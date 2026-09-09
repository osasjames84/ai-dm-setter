import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { PERSONAS, PERSONA_BY_ID } from './lib/personas.js';
import { igConfigured, igVerifyWebhook, igParseInbound, igSendText, igSendAudio, igSendAction, igProfile, igStatus, igFetchHistory, onIgAuthError } from './lib/instagram.js';
import { generateMove, varyMessage, applyOutboundFilter, stripDashes } from './lib/engine.js';
import { analyzeDms, generateIdeas, classifyMessages } from './lib/content.js';
import { createScheduler, withinMessagingWindow } from './lib/scheduler.js';
import { matchExactPhrase } from './lib/triggers.js';
import multer from 'multer';
import { initKnowledge, addDocument, listDocuments, deleteDocument, knowledgeText, isSupported } from './lib/knowledge.js';
import { refreshCalendly, calendlyText, setupWebhook } from './lib/calendly.js';
import { initAttachments, saveFromUrl, saveBuffer, attachmentPath, attachmentMime, attachmentKind } from './lib/attachments.js';
import { normalizeAudio, ffmpegAvailable } from './lib/audioconvert.js';
import { transcribeAudio } from './lib/transcribe.js';
import { initNotify, notify, notifyReady } from './lib/notify.js';
import { runBackup, latestBackup } from './lib/backup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* prod uses platform env */ }

const PORT = process.env.PORT || 5220;
const ADMIN_PIN = String(process.env.ADMIN_PIN || '4242');
const DATA_DIR = process.env.DATA_DIR || __dirname;

// Pipeline stages (funnel order). Semantics:
//   lead         = inbound, no meaningful exchange yet (creation default)
//   engaged      = lead has meaningfully replied at least once
//   qualifying   = learning goal / situation / blockers
//   qualified    = fits + warm, moving toward a call
//   booking_sent = booking proposed / times offered (autopilot MAY auto-apply)
//   call_booked  = call locked — HUMAN-CONFIRM ONLY (never auto-applied)
//   sale         = closed — HUMAN-SET ONLY (never auto-applied)
//   routed       = sent to community/guide instead of a call
//   dead         = went quiet through the follow-up sequence (revive-able)
const STAGES = ['lead', 'engaged', 'qualifying', 'qualified', 'booking_sent', 'call_booked', 'sale', 'routed', 'dead'];
// The first 7 form the ordered funnel; routed/dead are terminal outcomes outside it.
const FUNNEL_STAGES = STAGES.slice(0, 7);
// Stages a human must confirm — the engine may SUGGEST them but autopilot never
// auto-applies them (messages send, stage stays put, needs_human is raised).
const HUMAN_CONFIRM_STAGES = new Set(['call_booked', 'sale']);
const MODES = ['copilot', 'autopilot', 'off'];

// ---------- db ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
initKnowledge(DATA_DIR);     // knowledge-base document store (RAG-lite)
initAttachments(DATA_DIR);   // inbound image/voice/video attachment store
const db = new DatabaseSync(path.join(DATA_DIR, 'dmsetter.sqlite'));
// WAL + busy timeout: fewer fsyncs on the 15s sweeps and no SQLITE_BUSY if a
// second reader (backup, sqlite CLI) touches the file.
try { db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;'); }
catch (e) { console.warn('[db] pragmas failed:', e.message); }
// Tiny transaction helper (node:sqlite has none). Re-entrant: nested calls run
// inside the outer transaction instead of issuing a second BEGIN.
let _txDepth = 0;
function tx(fn) {
  if (_txDepth > 0) return fn();
  db.exec('BEGIN'); _txDepth++;
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw e; }
  finally { _txDepth--; }
}
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,                 -- 'sim' | 'instagram'
    external_id TEXT,                      -- IG sender id (null for sim)
    handle TEXT NOT NULL,
    display_name TEXT,
    stage TEXT NOT NULL DEFAULT 'lead',
    mode TEXT NOT NULL DEFAULT 'copilot',  -- 'copilot' | 'autopilot' | 'off'
    consecutive_ai_sends INTEGER NOT NULL DEFAULT 0,  -- autopilot guardrail counter
    followup_count INTEGER NOT NULL DEFAULT 0,        -- 0,1,2 then the thread goes dormant (never auto-'dead')
    next_followup_at TEXT,
    needs_human INTEGER NOT NULL DEFAULT 0,
    needs_human_reason TEXT,
    false_positive INTEGER NOT NULL DEFAULT 0,        -- call_booked but later found unqualified
    persona TEXT,                          -- sim persona id (Phase 4 drives replies)
    last_lead_message_at TEXT,
    last_message_at TEXT,
    kw_triggered INTEGER NOT NULL DEFAULT 0,  -- Story/Reel keyword trigger fired once
    created_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_conv_stage ON conversations(stage);
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,                    -- 'lead' | 'setter'
    text TEXT NOT NULL,
    source TEXT NOT NULL,                  -- 'ai' | 'human' | 'followup'
    mid TEXT,                              -- Instagram message id (dedup echoes + webhook retries)
    att_type TEXT,                         -- 'image' | 'audio' | 'video' | 'file' when the message is an attachment
    att_id TEXT,                           -- stored attachment file id (served via /api/attachments/:id)
    created_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, id);
  CREATE TABLE IF NOT EXISTS drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    messages_json TEXT NOT NULL,           -- JSON array of 1-2 strings
    stage_suggestion TEXT,
    needs_human INTEGER NOT NULL DEFAULT 0,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'pending',-- 'pending' | 'approved' | 'discarded'
    created_at TEXT,
    resolved_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_draft_conv ON drafts(conversation_id, status);
  -- One row per (conversation, stage) the moment that stage is first reached.
  -- Powers between-stage conversion + call_booked-this-week without touching history.
  CREATE TABLE IF NOT EXISTS stage_events (
    conversation_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (conversation_id, stage)
  );
`);

// Lightweight column migrations for existing DBs (the prod volume predates newer
// columns). ALTER throws if the column already exists — that's expected; ignore.
for (const [table, col, def] of [
  ['conversations', 'kw_triggered', 'INTEGER NOT NULL DEFAULT 0'],
  ['conversations', 'call_time', 'TEXT'],          // ISO start time of the booked Calendly call
  ['conversations', 'vsl_sent_at', 'TEXT'],        // when the Call Booked VSL was fired (once per conv)
  ['conversations', 'reminders_sent', 'TEXT'],     // JSON array of fired reminder keys (hours_before + 'noshow')
  ['messages', 'mid', 'TEXT'],
  ['messages', 'att_type', 'TEXT'],
  ['messages', 'att_id', 'TEXT'],
]) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); } catch { /* already present */ }
}
// Dedup index on the IG message id — created AFTER the migration so the column
// exists on both fresh and upgraded databases. Partial: many rows have no mid.
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_mid ON messages(mid) WHERE mid IS NOT NULL'); } catch { /* ignore */ }
// One conversation per Instagram sender — makes the webhook's find-or-create durable.
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_ext ON conversations(channel, external_id) WHERE external_id IS NOT NULL'); }
catch (e) { console.warn('[db] could not create unique external_id index (duplicate rows?):', e.message); }

// ---------- settings ----------
const SETTING_DEFAULTS = {
  // The owner-written prompt sections. ALL EMPTY by default — nothing about
  // how to sell, qualify, book, follow up, or talk is baked into the product.
  // lib/engine.js composes the system prompt from whatever the owner writes.
  prompt_persona: '',               // Character & Personality
  prompt_offer: '',                 // Offer & Context
  prompt_voice: '',                 // Texting Style (legacy `style` honored as a fallback)
  prompt_qualification: '',         // Qualification Sequence
  prompt_booking: '',               // Booking Sequence
  prompt_routing: '',               // Routing Rules
  prompt_objections: '',            // Objection Handling (free text)
  prompt_followup: '',              // Follow-up Instructions (AI-written follow-ups)
  prompt_hard_rules: '',            // Hard Rules
  prompt_custom: '',                // Custom Instructions
  coach_name: '',
  default_mode: 'off',              // AI is opt-in per thread: handoff phrase (owner) or keyword (lead)
  kill_switch: '0',
  // AI follow-up ladder (hours of silence before the AI writes follow-up #1,
  // then hours after the previous one for #2-#4). ALL OFF by default — the
  // owner opts in by entering timings, and the content comes from his own
  // Follow-up Instructions. Blank/0 disables that step and every step after it.
  // NOTE: later steps usually fall outside Instagram's 24h window — the AI still
  // composes the message, but it parks as a manual draft + notification for the
  // owner to send from his phone (Meta policy, not ours).
  followup_1_hours: '',
  followup_2_hours: '',
  followup_3_hours: '',
  followup_4_hours: '',
  call_slots: '',
  guide_link: '',
  community_link: '',
  // Universal outbound guardrail (regex source strings, JSON array). Default is
  // EMPTY — owners add their own tripwires (e.g. [£$€]\s*\d to block prices).
  outbound_filter_regexes: JSON.stringify([]),
  // Opt-in punctuation cleanup: '1' turns em/en dashes (and spaced hyphens) in
  // every outbound message into commas. Off by default — no style is enforced.
  strip_dashes: '0',

  // ---- AI Script (SetDM-parity) ----
  about_you: '',                    // About You (identity)
  style: '',                        // LEGACY — migrated into prompt_voice on boot; no longer edited in the UI
  client_results: '',               // real client results, one per line — the AI may cite only these
  objection_handlers: '[]',         // [{trigger, reply}]
  reactions_enabled: '0',           // Reaction Criteria master toggle
  reaction_rules: '[]',             // ["When they share their fitness goal", …]
  audio_arsenal: '[]',              // [{phrase}] (audio file infra is client-side/dormant)
  manual_voice: '[]',               // [{label}]
  keyword_trigger: JSON.stringify({ mode: 'text', keywords: '', initial_message: '', delay_min: '', delay_max: '', follow_ups: [] }),
  ai_on_phrases: '[]',              // ["exact outbound message", …] → autopilot handoff
  seq_lead: '[]',                   // [{delay_hours, message}]
  seq_qualification: '[]',
  seq_booking: '[]',
  call_booked_vsl: '',              // Call Booked › VSL message

  // ---- Booking loop (Calendly) ----
  // Pre-call reminders fired off the booked call_time (interpolate {{FIRST_NAME}}
  // + {{CALENDLY}}). Each { hours_before, message }; sent once per conversation.
  // EMPTY by default — the owner writes his own.
  booking_reminders: JSON.stringify([]),
  // Sent ~30 min after a no-show (no lead message since the call start). EMPTY
  // by default — nothing is sent unless the owner writes a message.
  noshow_message: '',

  // ---- Settings (SetDM-parity) ----
  calendar_link: '',                // Calendly booking URL
  notify_emails: '',                // extra notification recipients
  calendly_token: '',               // Calendly API token (in-DM booking)
  book_in_dms: '1',                 // "Book calls in DMs" checkbox (checked by default)
  response_min: '10',               // Autopilot › Response Time min seconds
  response_max: '30',               // Autopilot › Response Time max seconds
  typing_indicator: '0',            // Instagram typing indicator toggle
  languages: '',
  min_age: '',
  flag_send_final: '0',             // Flag Handling › send final message before flagging
  flag_final_message: '',           // fallback final message
  flag_messages: '{}',              // {reason_code: message} per-reason overrides
  flag_enabled: '{}',               // {reason_code: bool} — the OWNER opts in per scenario in Settings › Flag Handling; NOTHING flags by default

  // ---- System state (not user-editable via the Settings form) ----
  ig_auth_error: '',                // JSON {at, detail} when the IG token is dead/revoked; '' when healthy (FEATURE 2)
  calendly_webhook_id: '',          // Calendly webhook subscription uri (set by /api/calendly/webhook-setup)
  calendly_signing_key: '',         // its HMAC-SHA256 signing key (verifies inbound Calendly webhooks)
  content_analysis: '',             // JSON content-engine payload (mined lead DMs + generated ideas); set by /api/content/* (FEATURE 3)
};
const getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? null;
let _settingsCache = null; // allSettings() memo — invalidated on every write
const setSetting = (k, v) => { _settingsCache = null; db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, String(v)); };
for (const [k, v] of Object.entries(SETTING_DEFAULTS)) {
  if (getSetting(k) == null) setSetting(k, v);
}
// One-time cleanup of the defaults that USED to ship baked in (placeholder
// prompt text, the 4/23/48/96h follow-up ladder, canned reminders / no-show
// copy). A stored value that still equals the old built-in default was never
// the owner's choice, so it is cleared; anything the owner edited is untouched.
const LEGACY_BAKED_DEFAULTS = {
  prompt_offer: ['Describe your offer, who it serves, and your positioning.', ''],
  prompt_qualification: ['Describe how a lead should be qualified, step by step.', ''],
  prompt_routing: ['Describe routing rules: who gets booked, who gets sent to community/guide, links to use.', ''],
  prompt_voice: ['Describe how you text: tone, length, punctuation, emoji habits.', ''],
  prompt_hard_rules: ['List things the AI must NEVER do, one per line.', ''],
  followup_1_hours: ['4', ''],
  followup_2_hours: ['23', ''],
  followup_3_hours: ['48', ''],
  followup_4_hours: ['96', ''],
  booking_reminders: [JSON.stringify([
    { hours_before: 24, message: "hey {{FIRST_NAME}}, we're locked in for tomorrow — see you on the call 🤝" },
    { hours_before: 1, message: "call in about an hour — got your typical day of eating ready?" },
  ]), '[]'],
  noshow_message: ['hey, looks like we missed each other — no stress. grab a new time here: {{CALENDLY}}', ''],
};
for (const [k, [legacy, blank]] of Object.entries(LEGACY_BAKED_DEFAULTS)) {
  if (getSetting(k) === legacy) { setSetting(k, blank); console.log(`[settings] cleared legacy built-in default for ${k}`); }
}
// The old "Style" box lives on as Texting Style — carry its text over once.
if (!String(getSetting('prompt_voice') || '').trim() && String(getSetting('style') || '').trim()) {
  setSetting('prompt_voice', getSetting('style'));
  console.log('[settings] migrated legacy style → prompt_voice');
}
// Keys that must NEVER leave the server (the settings blob is polled by the
// browser every 5s and rides in backups). The frontend gets a boolean instead.
const SECRET_SETTING_KEYS = new Set(['calendly_token', 'calendly_signing_key', 'content_analysis']);
/** Every catalogued setting, one query, memoised until the next setSetting(). */
const allSettingsRaw = () => {
  if (!_settingsCache) {
    const out = Object.fromEntries(Object.keys(SETTING_DEFAULTS).map((k) => [k, null]));
    for (const r of db.prepare('SELECT key, value FROM settings').all()) if (r.key in SETTING_DEFAULTS) out[r.key] = r.value;
    _settingsCache = out;
  }
  return _settingsCache;
};
/** Settings as exposed to the browser and the engine: secrets stripped. */
// One-shot (2026-09-09): the Instagram token died and every autopilot send
// failed for days, flagging each thread "send failed" and dropping it to
// copilot. The token is fixed; clear those flags and put the threads back on
// autopilot so the owner doesn't click through them one by one.
if (getSetting('_clear_sendfailed_flags_v1') == null) {
  const r = db.prepare("UPDATE conversations SET needs_human = 0, needs_human_reason = NULL, mode = 'autopilot' WHERE needs_human = 1 AND needs_human_reason LIKE 'send failed%'").run();
  setSetting('_clear_sendfailed_flags_v1', '1');
  if (r.changes) console.log(`[migrate] cleared ${r.changes} "send failed" flag(s), threads back on autopilot`);
}
// One-shot (2026-09-09): the affordability range in the seeded script moves
// from £250-£500 to £200-£300 a month (owner's call). Only the exact seeded
// phrases are touched, so anything he rewrote himself is left alone.
if (getSetting('_price_range_200_300_v1') == null) {
  let n = 0;
  for (const k of ['prompt_routing', 'prompt_objections', 'prompt_hard_rules', 'prompt_qualification', 'prompt_custom', 'prompt_offer']) {
    const v = String(getSetting(k) || '');
    const nv = v.replace(/£250 and £500/g, '£200 and £300').replace(/£250 to £500/g, '£200 to £300');
    if (nv !== v) { setSetting(k, nv); n++; }
  }
  setSetting('_price_range_200_300_v1', '1');
  if (n) console.log(`[migrate] price range → £200-£300 in ${n} prompt section(s)`);
}
// One-shot (2026-09-09): minimum age 18 → 16 (owner's call). Swaps the exact
// seeded age phrases in the live prompt sections and the Settings min_age
// filter when it still holds the old value.
if (getSetting('_min_age_16_v1') == null) {
  let n = 0;
  for (const k of ['prompt_routing', 'prompt_hard_rules', 'prompt_qualification', 'prompt_offer', 'prompt_custom', 'prompt_objections']) {
    const v = String(getSetting(k) || '');
    const nv = v.replace(/over 18\b/g, 'over 16').replace(/Under 18\b/g, 'Under 16').replace(/under 18\b/g, 'under 16').replace(/They are 18 or over/g, 'They are 16 or over');
    if (nv !== v) { setSetting(k, nv); n++; }
  }
  if (String(getSetting('min_age') || '').trim() === '18') { setSetting('min_age', '16'); n++; }
  setSetting('_min_age_16_v1', '1');
  if (n) console.log(`[migrate] minimum age → 16 in ${n} place(s)`);
}
// One-shot (2026-09-09): regional affordability amounts (owner's call). Swaps
// the exact seeded phrases and appends the REGIONAL AFFORDABILITY block to the
// live Routing Rules. Sections the owner rewrote are left as they are.
if (getSetting('_regional_pricing_v1') == null) {
  const R = [["prompt_routing", "ask once, kindly, whether they could put between £200 and £300 a month towards it.", "ask once, kindly, whether they could put the affordability amount for where they live towards it (REGIONAL AFFORDABILITY below)."], ["prompt_objections", "The one range I am happy to mention is the £200 to £300 a month affordability question from the Routing Rules, and only as a question about them, never as my price.", "The one number I am happy to mention is the affordability question from the Routing Rules, at the amount for where they live (REGIONAL AFFORDABILITY there), and only as a question about them, never as my price."], ["prompt_hard_rules", "The only number you may ever mention is the £200 to £300 a month affordability question, and only as a question.", "The only number you may ever mention is the affordability amount for the lead's country from the Routing Rules, and only as a question."]];
  let n = 0;
  for (const [k, a, b] of R) {
    const v = String(getSetting(k) || '');
    if (v.includes(a)) { setSetting(k, v.split(a).join(b)); n++; }
  }
  const routing = String(getSetting('prompt_routing') || '');
  if (routing && !routing.includes('REGIONAL AFFORDABILITY')) { setSetting('prompt_routing', routing + "\n\nREGIONAL AFFORDABILITY (go by the lead's own answer to \"where are you from\" in question 1, never a guess from their name, accent or slang)\n- UK: £200 to £300 a month.\n- USA, Canada, Australia, New Zealand, Western Europe, the Gulf: the equivalent of £200 to £300 a month in their currency, rounded to a clean number (for example $250 to $400 in the US).\n- Nigeria: ₦200,000 a month.\n- Any other African country, India, Pakistan, Bangladesh, Sri Lanka, Nepal, the Philippines, Indonesia, Vietnam, most of Latin America, or any country with similar incomes: the rough equivalent of ₦200,000 a month in their local currency, rounded to a clean number (roughly £100 a month).\n- Not sure which bracket a country is in: use the lower one.\nAlways ask it as a question about them, never as my price."); n++; }
  setSetting('_regional_pricing_v1', '1');
  if (n) console.log(`[migrate] regional affordability applied in ${n} place(s)`);
}
// Second pass for the regional wording: looser matches (a whole sentence
// rather than the exact seeded string), logged per section, so nothing in the
// live prompt still pins the affordability question to pounds.
if (getSetting('_regional_pricing_v2') == null) {
  const passes = [
    ['prompt_hard_rules', /The only number you may ever mention is[^.]*\./, "The only number you may ever mention is the affordability amount for the lead's country from the Routing Rules, and only as a question."],
    ['prompt_objections', /The one (?:range|number) I am happy to mention is[^.]*\./, 'The one number I am happy to mention is the affordability question from the Routing Rules, at the amount for where they live (REGIONAL AFFORDABILITY there), and only as a question about them, never as my price.'],
    ['prompt_routing', /whether they could put between £[0-9,]+ and £[0-9,]+ a month towards it\./, 'whether they could put the affordability amount for where they live towards it (REGIONAL AFFORDABILITY below).'],
  ];
  const touched = [];
  for (const [k, re, b] of passes) {
    const v = String(getSetting(k) || '');
    const nv = v.replace(re, b);
    if (nv !== v) { setSetting(k, nv); touched.push(k); }
  }
  setSetting('_regional_pricing_v2', '1');
  console.log('[migrate] regional wording pass 2 touched: ' + (touched.join(', ') || 'nothing (already in place)'));
}
// Pass 3: the block itself. Pass 1 skipped the append because the swapped
// sentence already contained the words "REGIONAL AFFORDABILITY"; check for the
// block's own heading instead.
if (getSetting('_regional_pricing_v3') == null) {
  const routing = String(getSetting('prompt_routing') || '');
  if (routing && !routing.includes('REGIONAL AFFORDABILITY (go by')) {
    setSetting('prompt_routing', routing + "\n\nREGIONAL AFFORDABILITY (go by the lead's own answer to \"where are you from\" in question 1, never a guess from their name, accent or slang)\n- UK: £200 to £300 a month.\n- USA, Canada, Australia, New Zealand, Western Europe, the Gulf: the equivalent of £200 to £300 a month in their currency, rounded to a clean number (for example $250 to $400 in the US).\n- Nigeria: ₦200,000 a month.\n- Any other African country, India, Pakistan, Bangladesh, Sri Lanka, Nepal, the Philippines, Indonesia, Vietnam, most of Latin America, or any country with similar incomes: the rough equivalent of ₦200,000 a month in their local currency, rounded to a clean number (roughly £100 a month).\n- Not sure which bracket a country is in: use the lower one.\nAlways ask it as a question about them, never as my price.");
    console.log('[migrate] regional affordability block appended to Routing Rules');
  } else console.log('[migrate] regional affordability block already present');
  setSetting('_regional_pricing_v3', '1');
}
// One-shot (2026-09-09): the OLD July script (six-topic ladder + £300-500 gate)
// was still sitting in About You and in the objection handlers, contradicting
// the new Qualification Sequence — the AI followed it and jumped to money.
// About You goes back to identity only (the owner's own words); the old text is
// logged in full so it can be recovered. Objection handlers keep their
// meaning but lose the old range.
if (getSetting('_strip_old_ladder_v1') == null) {
  const oldAbout = String(getSetting('about_you') || '');
  if (/300|500|budget|invest|afford|ladder/i.test(oldAbout)) {
    console.log('[migrate] OLD about_you (saved here for recovery):\n' + oldAbout);
    setSetting('about_you', "I'm a 1-on-1 fitness coach. I help people lose fat and get shredded. The thing everybody struggles with is the diet — that's where people get stuck. They've been trying for years, doing it over and over, spinning their wheels with nothing to show for it. They're lost with food and they don't know how to eat to actually get lean.\n\nI coach the whole thing: I teach you how to diet properly AND I build and adjust your training. Everyone who works with me gets their training dialled in by me — I don't assume you've got that figured out. Nutrition is the piece most people are missing, but I sort both so you actually get shredded.\n\nWhy me: I've been exactly where they are. I was fat as hell growing up, overfed as a kid. I taught myself nutrition from scratch, figured out how to diet, and got shredded — and I did it coming from an African background where the food we grew up on isn't exactly macro-friendly. So I know how to make it work with real food, for real people.\n\nThe people I help are stuck, frustrated, and lost with dieting. They've tried and failed enough times that they're sick of it. That's who I want on a call.");
    console.log('[migrate] about_you reset to identity only');
  }
  let rows = []; try { rows = JSON.parse(getSetting('objection_handlers') || '[]'); } catch { rows = []; }
  if (Array.isArray(rows) && rows.length) {
    const fix = (t) => String(t || '')
      .replace(/£?\s?(?:300|250)\s?(?:-|–|to|and)\s?£?\s?500(?:\s?(?:a|per)\s?month)?/gi, '£200 to £300 a month (or the local equivalent from REGIONAL AFFORDABILITY in the Routing Rules)');
    let changed = 0;
    const out = rows.map((r) => { const nr = { ...r, trigger: fix(r.trigger), reply: fix(r.reply) }; if (nr.trigger !== r.trigger || nr.reply !== r.reply) changed++; return nr; });
    if (changed) { console.log('[migrate] OLD objection_handlers (saved here for recovery): ' + JSON.stringify(rows)); setSetting('objection_handlers', JSON.stringify(out)); console.log(`[migrate] objection_handlers: ${changed} entr${changed === 1 ? 'y' : 'ies'} updated to the new range`); }
  }
  setSetting('_strip_old_ladder_v1', '1');
}
// Pass 2 on the objection handlers: log them verbatim, then replace any
// "300 … 500" range (whatever the punctuation) with the new wording.
if (getSetting('_strip_old_ladder_v2') == null) {
  let rows = []; try { rows = JSON.parse(getSetting('objection_handlers') || '[]'); } catch { rows = []; }
  console.log('[migrate] objection_handlers now: ' + JSON.stringify(rows));
  const fix = (t) => String(t || '').replace(/£?\s?(?:300|250)\s?.{0,6}?\s?£?\s?500(?:\s?(?:a|per|\/)\s?(?:month|mo|pm))?/gi, '£200 to £300 a month (or the local equivalent from REGIONAL AFFORDABILITY in the Routing Rules)');
  let changed = 0;
  const out = (Array.isArray(rows) ? rows : []).map((r) => { const nr = { ...r, trigger: fix(r.trigger), reply: fix(r.reply) }; if (nr.trigger !== r.trigger || nr.reply !== r.reply) changed++; return nr; });
  if (changed) { setSetting('objection_handlers', JSON.stringify(out)); console.log(`[migrate] objection_handlers pass 2: ${changed} updated`); }
  else console.log('[migrate] objection_handlers pass 2: no 300-500 range found');
  setSetting('_strip_old_ladder_v2', '1');
}
// One-shot (2026-09-09): the price-objection handler ended with the open
// "how much would you set aside each month?" ask, which fires the moment a
// lead asks the price — before any qualifying. Keep the owner's line, drop the
// money ask, hand back to the sequence. Old reply logged.
if (getSetting('_price_handler_no_money_v1') == null) {
  let rows = []; try { rows = JSON.parse(getSetting('objection_handlers') || '[]'); } catch { rows = []; }
  let changed = 0;
  const out = (Array.isArray(rows) ? rows : []).map((r) => {
    const reply = String(r.reply || '');
    if (/set aside each month/i.test(reply) && /price|how much/i.test(String(r.trigger || ''))) {
      console.log('[migrate] OLD price handler reply: ' + reply);
      changed++;
      return { ...r, reply: "it's not one size fits all, i wouldn't put you on the same plan as your 50 year old grandpa 😂 depends what you actually need, that's what the call's for. then go straight back to whichever qualifying question you were on. do NOT ask about money here." };
    }
    return r;
  });
  if (changed) { setSetting('objection_handlers', JSON.stringify(out)); console.log('[migrate] price handler no longer asks about money'); }
  setSetting('_price_handler_no_money_v1', '1');
}
const allSettings = () => {
  const raw = allSettingsRaw();
  const s = { ...raw };
  for (const k of SECRET_SETTING_KEYS) delete s[k];
  s.calendly_token_set = !!String(raw.calendly_token || '').trim();
  return s;
};
// Starter script (prompts/starter.json): seeded ONCE into empty prompt sections
// so the setter has a working script out of the box, and served to the Prompt
// page's "Fill empty sections" button. Plain data — the owner edits it freely.
const STARTER_PROMPT = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'prompts', 'starter.json'), 'utf8')); }
  catch (e) { console.warn('[settings] no starter prompt loaded:', e.message); return null; }
})();
if (STARTER_PROMPT && STARTER_PROMPT.sections && getSetting('_seed_prompt_v1') == null) {
  let n = 0;
  for (const [k, v] of Object.entries(STARTER_PROMPT.sections)) {
    if (k in SETTING_DEFAULTS && !String(getSetting(k) || '').trim() && String(v || '').trim()) { setSetting(k, v); n++; }
  }
  setSetting('_seed_prompt_v1', '1');
  console.log(`[settings] seeded ${n} empty prompt section(s) from prompts/starter.json`);
}
// Outbound punctuation cleanup is OPT-IN (Settings › AI Controls › Strip dashes).
const cleanOutbound = (t) => (getSetting('strip_dashes') === '1' ? stripDashes(t) : String(t ?? ''));

// Settings PLUS injected knowledge-base text + Calendly availability — used only
// for engine calls so the frontend settings blob (allSettings) stays lean.
const engineSettings = () => ({ ...allSettings(), knowledge_text: knowledgeText(), calendly_slots: calendlyText() });

// Owner email notifications (FEATURE 3) — dormant until RESEND_API_KEY is set.
// Recipients come from the comma/space-separated notify_emails setting; a bad
// entry (no @) is dropped so Resend never rejects the whole batch.
initNotify({
  getEmails: () => String(getSetting('notify_emails') || '')
    .split(/[,\s]+/).map((e) => e.trim()).filter((e) => e.includes('@')),
});
// needs_human notify throttle: convId → last-notified epoch ms (skip if < 30 min).
const NEEDS_HUMAN_NOTIFY_MS = 30 * 60 * 1000;
const needsHumanNotifiedAt = new Map();

// Calendly availability refresh (dormant until "book calls in DMs" + a token are set).
function maybeRefreshCalendly() {
  const token = getSetting('calendly_token');
  if (getSetting('book_in_dms') === '1' && token) refreshCalendly(token);
}
maybeRefreshCalendly();                              // warm the cache on boot
setInterval(maybeRefreshCalendly, 15 * 60 * 1000);  // and keep it fresh

// ---------- app ----------
// Process-level safety nets: a fire-and-forget scheduler turn (autopilot / follow-up)
// that rejects would otherwise crash Node 23. LOG and keep the process alive — the
// scheduler already surfaces the affected lead in Needs Review.
process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

const app = express();
app.set('trust proxy', 1); // Railway's edge proxy — needed for req.ip in the PIN lockout
app.use(express.json({ limit: '2mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.static(path.join(__dirname, 'public')));
// In-memory multipart handler for knowledge-base uploads (25MB cap, matches the UI).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const nowIso = () => new Date().toISOString();
// Normalize any timestamp (IG's "…+0000", bare ISO, epoch ms) to canonical
// ISO-8601 UTC so lexical order == chronological order everywhere. Returns the
// raw value untouched when unparseable so a real timestamp is never nulled out.
const toIso = (v) => {
  if (v == null || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
};
const newId = () => crypto.randomBytes(9).toString('hex');
const parseJ = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

// One-time backfill (idempotent, flag-guarded): the history sync stored IG
// timestamps ("…+0000") while webhook/AI messages use ISO-Z. Mixed formats broke
// ORDER BY created_at, so synced history sorted into the wrong position in a
// thread. Normalize every stored message timestamp to ISO-Z once, then recompute
// each conversation's last_message_at from its newest message so inbox ordering
// matches reality.
try {
  const done = db.prepare("SELECT value FROM settings WHERE key = '_ts_normalized_v1'").get();
  if (!done) {
    const rows = db.prepare('SELECT id, created_at FROM messages').all();
    const upd = db.prepare('UPDATE messages SET created_at = ? WHERE id = ?');
    let fixed = 0;
    for (const r of rows) {
      const iso = toIso(r.created_at);
      if (iso && iso !== r.created_at) { upd.run(iso, r.id); fixed++; }
    }
    db.exec(`UPDATE conversations SET last_message_at = (
        SELECT MAX(created_at) FROM messages m WHERE m.conversation_id = conversations.id
      ) WHERE EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = conversations.id)`);
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('_ts_normalized_v1', '1')").run();
    console.log('[migrate] normalized ' + fixed + ' message timestamp(s) to ISO-Z');
  }
} catch (e) { console.error('[migrate] timestamp normalize failed:', e.message); }

// One-time backfill (idempotent, flag-guarded): last_lead_message_at is only set
// by onLeadMessage (webhook path), so history-synced conversations have it NULL
// even though their lead messages carry real timestamps — the 24h messaging-window
// guard would wrongly treat them as "never heard from". Derive it from each
// conversation's newest lead message (stays NULL when a conv has none). Runs AFTER
// the timestamp normalize above so it reads the already-ISO-Z message timestamps.
try {
  const done = db.prepare("SELECT value FROM settings WHERE key = '_lead_at_backfill_v1'").get();
  if (!done) {
    const info = db.prepare(`UPDATE conversations SET last_lead_message_at = (
        SELECT MAX(created_at) FROM messages m WHERE m.conversation_id = conversations.id AND m.role = 'lead'
      ) WHERE last_lead_message_at IS NULL`).run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('_lead_at_backfill_v1', '1')").run();
    console.log('[migrate] backfilled last_lead_message_at for ' + info.changes + ' conversation(s)');
  }
} catch (e) { console.error('[migrate] last_lead_message_at backfill failed:', e.message); }

// One-time backfill (idempotent, flag-guarded): dead→mode-off only fires on the
// TRANSITION into dead, so conversations already dead when that rule shipped kept
// their old mode — the AI was still replying to leads inside dead threads. Silence them.
try {
  const done = db.prepare("SELECT value FROM settings WHERE key = '_dead_ai_off_v1'").get();
  if (!done) {
    const info = db.prepare("UPDATE conversations SET mode = 'off', next_followup_at = NULL WHERE stage = 'dead' AND mode != 'off'").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('_dead_ai_off_v1', '1')").run();
    console.log('[migrate] turned AI off for ' + info.changes + ' legacy dead conversation(s)');
  }
} catch (e) { console.error('[migrate] dead ai-off backfill failed:', e.message); }

// One-time backfill (idempotent, flag-guarded): AI-OFF-BY-DEFAULT (owner's
// 2026-07-30 direction — the AI must NOT engage every chat; it opts IN per
// thread via his handoff phrase or the lead's keyword). Existing conversations
// that never showed real funnel intent — early-stage (lead/engaged/routed) and
// never keyword-triggered — go to mode 'off'. This is where personal contacts
// and synced-history threads live; the AI had been free-running on them.
// Active pipeline threads (qualifying and beyond) and keyword-triggered leads
// keep their current mode — those engaged the funnel deliberately.
try {
  const done = db.prepare("SELECT value FROM settings WHERE key = '_default_off_backfill_v1'").get();
  if (!done) {
    const info = db.prepare(`UPDATE conversations SET mode = 'off'
      WHERE stage IN ('lead', 'engaged', 'routed') AND kw_triggered = 0 AND mode != 'off'`).run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('_default_off_backfill_v1', '1')").run();
    console.log('[migrate] AI-off-by-default: turned AI off for ' + info.changes + ' non-funnel conversation(s)');
  }
} catch (e) { console.error('[migrate] default-off backfill failed:', e.message); }

// Production must never run on the default PIN.
const IS_PROD = !!process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production';
if (IS_PROD && !process.env.ADMIN_PIN) {
  console.error('[boot] ADMIN_PIN is not set — refusing to start in production with the default PIN');
  process.exit(1);
}
// PIN brute-force protection: per-IP failure counter; after 5 misses every
// further miss doubles a lockout (2s, 4s, … capped at 5 min). Timing-safe compare.
const pinFailures = new Map(); // ip → { n, until }
const PIN_FREE_FAILURES = 5;
function requireAdmin(req, res, next) {
  const ip = String(req.ip || req.socket?.remoteAddress || '');
  const rec = pinFailures.get(ip);
  if (rec && rec.until > Date.now()) {
    res.set('Retry-After', String(Math.ceil((rec.until - Date.now()) / 1000)));
    return res.status(429).json({ error: 'Too many wrong PINs — try again shortly' });
  }
  const given = Buffer.from(String(req.headers['x-admin-pin'] || ''));
  const want = Buffer.from(ADMIN_PIN);
  const ok = given.length === want.length && crypto.timingSafeEqual(given, want);
  if (!ok) {
    const n = (rec ? rec.n : 0) + 1;
    const extra = Math.max(0, n - PIN_FREE_FAILURES);
    pinFailures.set(ip, { n, until: extra ? Date.now() + Math.min(2 ** extra, 300) * 1000 : 0 });
    return res.status(401).json({ error: 'Wrong PIN' });
  }
  if (rec) pinFailures.delete(ip);
  next();
}

// Absolute base URL for links Instagram must fetch itself (Audio Arsenal clips).
// Railway injects RAILWAY_PUBLIC_DOMAIN; PUBLIC_BASE_URL can override locally.
const PUBLIC_BASE = String(process.env.PUBLIC_BASE_URL
  || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : '')).replace(/\/+$/, '');

// ---------- helpers ----------
const getConv = (id) => db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
const historyOf = (convId) =>
  db.prepare('SELECT role, text, source, att_type, att_id, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at, id').all(convId);

/** Serialize a conversation row for the API (ints → bools where it reads better). */
function shapeConv(c) {
  return {
    ...c,
    needs_human: !!c.needs_human,
    false_positive: !!c.false_positive,
  };
}

function pendingDraftOf(convId) {
  const d = db.prepare("SELECT * FROM drafts WHERE conversation_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1").get(convId);
  return d ? { ...d, messages: parseJ(d.messages_json, []), needs_human: !!d.needs_human } : null;
}

function addMessage(convId, role, text, source, mid = null, att_type = null, att_id = null, createdAt = null) {
  const at = toIso(createdAt) || nowIso();
  // OR IGNORE + the unique idx_msg_mid means a duplicate IG message id (echo of
  // our own send, a webhook retry, or a re-run history sync) is silently skipped.
  const info = db.prepare('INSERT OR IGNORE INTO messages (conversation_id, role, text, source, mid, att_type, att_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(convId, role, text, source, mid, att_type, att_id, at);
  // Advance last_message_at but NEVER move it backward (matters for history backfill).
  if (info.changes) {
    db.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ? AND (last_message_at IS NULL OR last_message_at < ?)').run(at, convId, at);
  }
  return info.changes > 0;
}

/**
 * Move to a stage + record first-reach timestamps (idempotent per stage).
 * Funnel semantics: reaching a funnel stage means the lead passed through every
 * earlier one, so skipped stages are backfilled — "reached" totals stay
 * monotonically decreasing down the funnel and conversions never exceed 100%.
 */
function setStage(convId, stage) {
  if (!STAGES.includes(stage)) return;
  return tx(() => setStageInner(convId, stage));
}
function setStageInner(convId, stage) {
  const prev = getConv(convId)?.stage;
  db.prepare('UPDATE conversations SET stage = ? WHERE id = ?').run(stage, convId);
  // Owner email (FEATURE 3) on a fresh call_booked — only on the transition INTO
  // it (prev !== stage) so re-setting the same stage doesn't re-notify. Fire-and-forget.
  if (stage === 'call_booked' && prev !== 'call_booked') {
    const handle = getConv(convId)?.handle || convId;
    notify('Call booked 🎉', `${handle} just booked a call.`).catch(() => {});
  }
  // dead is a deliberate final state: the owner wants the AI fully off so a random
  // future message doesn't restart selling. On the transition INTO dead, turn the
  // conversation off and drop any queued follow-up. (Revive re-enables manually.)
  if (stage === 'dead' && prev !== 'dead') {
    db.prepare("UPDATE conversations SET mode = 'off', next_followup_at = NULL WHERE id = ?").run(convId);
  }
  const at = nowIso();
  const idx = FUNNEL_STAGES.indexOf(stage);
  const insert = db.prepare('INSERT OR IGNORE INTO stage_events (conversation_id, stage, at) VALUES (?, ?, ?)');
  if (idx === -1) { insert.run(convId, stage, at); return; }
  for (let i = 0; i <= idx; i++) insert.run(convId, FUNNEL_STAGES[i], at);
}

// One-time repair for stage_events written before backfill existed: give every
// recorded funnel event its missing predecessors (same timestamp). Idempotent.
for (const ev of db.prepare('SELECT conversation_id, stage, at FROM stage_events').all()) {
  const idx = FUNNEL_STAGES.indexOf(ev.stage);
  for (let i = 0; i < idx; i++) {
    db.prepare('INSERT OR IGNORE INTO stage_events (conversation_id, stage, at) VALUES (?, ?, ?)')
      .run(ev.conversation_id, FUNNEL_STAGES[i], ev.at);
  }
}

/** Discard any pending draft on a conversation (superseded by a newer action). */
function discardPending(convId) {
  db.prepare("UPDATE drafts SET status = 'discarded', resolved_at = ? WHERE conversation_id = ? AND status = 'pending'")
    .run(nowIso(), convId);
}

/**
 * Push text to the lead through the channel, storing it as a setter message.
 * Runs the outbound filter; on refusal, flags needs_human and does NOT send.
 * On a successful send to a sim persona conversation, schedules the persona's
 * reply (Phase 4 self-play — every setter send is the single trigger point).
 * Returns { ok, reason? }.
 */
/**
 * Audio Arsenal: if an outbound AI message contains a configured phrase and this
 * lead hasn't heard that clip yet, send the coach's voice note (first-time-only,
 * per lead per clip). Best-effort — a failed audio send never blocks the text.
 */
// Punctuation-/apostrophe-proof text for phrase matching ("I'm not an AI" == "im not an ai").
const normForMatch = (x) => String(x || '').toLowerCase().replace(/['’‘`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

async function maybeFireVoiceNote(conv, text) {
  if (conv.channel !== 'instagram' || !igConfigured() || !conv.external_id || !PUBLIC_BASE) return;
  const arsenal = parseJ(getSetting('audio_arsenal'), []);
  if (!Array.isArray(arsenal) || !arsenal.length) return;
  const t = normForMatch(text);
  for (const a of arsenal) {
    const phrase = normForMatch(a?.phrase);
    const audioId = String(a?.audio_id || '').trim();
    if (!phrase || !audioId || !t.includes(phrase)) continue;
    if (!attachmentPath(audioId)) return;                                   // clip file missing
    if (db.prepare('SELECT 1 FROM messages WHERE conversation_id = ? AND att_id = ? LIMIT 1').get(conv.id, audioId)) return; // already heard it
    try {
      const sent = await igSendAudio(conv.external_id, PUBLIC_BASE + '/api/attachments/' + audioId);
      addMessage(conv.id, 'setter', '[voice note]', 'ai', sent && sent.message_id ? String(sent.message_id) : null, 'audio', audioId);
    } catch (e) { console.error('[voice-note] send failed:', e.message); }
    return; // at most one clip per turn
  }
}

// Normalize outbound text for send-dedupe comparison (GUARD 1): lowercase,
// collapse whitespace, strip trailing punctuation. Two sends are "the same" when
// their normalized forms match — catches the 4-5× verbatim loops + copilot
// double-sends the audit found (evelicious_23, samri_debesai, kiingjoeyp).
const normForDedupe = (x) => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.,!?;:…]+$/u, '').trim();

// GUARD 3 — outgoing text that is a leftover test marker must never reach a real
// lead ('dmSetter test 1/2 — text send. ignore, just testing 🧪' was delivered to
// mrosashimself). Sim conversations are exempt (tests belong there).
const TEST_MARKER_RE = /dmsetter\s*test|just testing|\btest \d+\/\d+\b/i;

// Recipient ids with an AI/followup send in flight (Graph call issued, echo not
// yet reconciled). Instagram can echo our own message BEFORE the Send API
// returns; without this the echo is stored as a human reply and resets the
// max-2 autopilot counter. Entries expire on their own.
const inFlightSends = new Map(); // external_id → expiry epoch ms
async function deliver(conv, text, source) {
  let sentMid = null;
  // Optional owner-enabled dash cleanup, applied before anything else so every
  // downstream path (dedupe, IG send, DB store) sees the same text.
  text = cleanOutbound(text);
  const filtered = applyOutboundFilter(text, parseJ(getSetting('outbound_filter_regexes'), []));
  if (!filtered.ok) {
    db.prepare('UPDATE conversations SET needs_human = 1, needs_human_reason = ? WHERE id = ?')
      .run(filtered.reason || 'outbound_filter', conv.id);
    return { ok: false, reason: filtered.reason || 'outbound_filter' };
  }
  // GUARD 3 — block test-marker text from a real IG thread (sim is exempt). Refuse
  // (ok:false) so the caller flags/parks it instead of shipping the marker.
  if (conv.channel === 'instagram' && TEST_MARKER_RE.test(filtered.text)) {
    console.log('[guard] test-marker text blocked from real thread');
    return { ok: false, reason: 'test text blocked' };
  }
  // GUARD 1 — send-dedupe. For AI/followup sends only (human sends are the owner's
  // call — never block those), suppress a send whose normalized text matches any of
  // the last 6 setter messages. Return ok:true so callers treat it as HANDLED and
  // ADVANCE (a duplicate must be consumed, not retried) — and it must NOT flag
  // needs_human. Applies to everything incl. short "?" nudges (those are what looped).
  if (source === 'ai' || source === 'followup') {
    const recent = db.prepare("SELECT text FROM messages WHERE conversation_id = ? AND role = 'setter' ORDER BY created_at DESC, id DESC LIMIT 6").all(conv.id);
    const norm = normForDedupe(filtered.text);
    if (norm && recent.some((r) => normForDedupe(r.text) === norm)) {
      console.log(`[dedupe] suppressed duplicate → ${conv.handle}`);
      return { ok: true, deduped: true };
    }
  }
  if (conv.channel === 'instagram' && igConfigured() && conv.external_id) {
    // Instagram typing indicator: for AI/autopilot sends, mark the thread read,
    // show typing, then pause a length-scaled beat so the bubble is visible.
    if (source !== 'human' && getSetting('typing_indicator') === '1') {
      try {
        await igSendAction(conv.external_id, 'mark_seen');
        await igSendAction(conv.external_id, 'typing_on');
        await new Promise((r) => setTimeout(r, Math.min(1000 + filtered.text.length * 45, 8000)));
      } catch { /* presence is best-effort — never block the real message */ }
    }
    if (source !== 'human') inFlightSends.set(String(conv.external_id), Date.now() + 20_000);
    const sent = await igSendText(conv.external_id, filtered.text);
    sentMid = sent && sent.message_id ? String(sent.message_id) : null;
  }
  // sim channel: delivery is just persistence (the persona reply is scheduled below).
  // Store the IG message id so the echo webhook for THIS send is deduped, not double-shown.
  addMessage(conv.id, 'setter', filtered.text, source, sentMid);
  // Audio Arsenal: AI/followup sends may fire a first-time voice note (not human sends).
  if (source !== 'human') await maybeFireVoiceNote(conv, filtered.text);
  // "Turn On AI When I Send…": a HUMAN-sent message that exactly matches a handoff
  // phrase flips this chat to autopilot, so future inbound messages get the AI.
  if (source === 'human' && conv.mode !== 'autopilot'
      && matchExactPhrase(filtered.text, parseJ(getSetting('ai_on_phrases'), []))) {
    setMode(conv.id, 'autopilot');
  }
  if (conv.channel === 'sim' && conv.persona) scheduler.onSetterDelivered(conv.id);
  return { ok: true };
}

/** Send a voice note directly (Core Sequence audio follow-up). Records it as a
 *  setter 'audio' message; no-op on the IG send for sim / unconfigured. */
async function deliverVoiceNote(conv, audioId, source, caption = '[voice note]') {
  if (!audioId || !attachmentPath(audioId)) return { ok: false, reason: 'clip missing' };
  // GUARD 3 (belt-and-suspenders) — if a caption is ever passed for a real IG
  // thread, hold it to the same test-marker refusal as deliver().
  if (conv.channel === 'instagram' && TEST_MARKER_RE.test(String(caption || ''))) {
    console.log('[guard] test-marker text blocked from real thread');
    return { ok: false, reason: 'test text blocked' };
  }
  let sentMid = null;
  if (conv.channel === 'instagram' && igConfigured() && conv.external_id && PUBLIC_BASE) {
    try {
      const sent = await igSendAudio(conv.external_id, PUBLIC_BASE + '/api/attachments/' + audioId);
      sentMid = sent && sent.message_id ? String(sent.message_id) : null;
    } catch (e) { console.error('[followup-audio] send failed:', e.message); return { ok: false, reason: e.message }; }
  }
  addMessage(conv.id, 'setter', caption, source, sentMid, 'audio', audioId);
  return { ok: true };
}

/** A lead just spoke: reset the AI-send guardrail + clear any queued follow-up. */
function onLeadMessage(convId) {
  const at = nowIso();
  // Also reset followup_count: a returning lead who previously got 2 nudges would
  // otherwise be at count=2 and get marked `dead` ~15s after the AI answers them.
  // Speaking again restarts the follow-up cadence from zero.
  db.prepare('UPDATE conversations SET consecutive_ai_sends = 0, followup_count = 0, next_followup_at = NULL, last_lead_message_at = ? WHERE id = ?')
    .run(at, convId);
}

/** Create an inbound conversation (webhook + sim share this). Stage 'lead', mode = default. */
function createConversation({ channel, external_id = null, handle, display_name = null, persona = null }) {
  return tx(() => createConversationInner({ channel, external_id, handle, display_name, persona }));
}
function createConversationInner({ channel, external_id, handle, display_name, persona }) {
  const id = newId();
  const mode = MODES.includes(getSetting('default_mode')) ? getSetting('default_mode') : 'copilot';
  db.prepare(`INSERT INTO conversations
      (id, channel, external_id, handle, display_name, stage, mode, persona, created_at)
      VALUES (?, ?, ?, ?, ?, 'lead', ?, ?, ?)`)
    .run(id, channel, external_id, handle, display_name, mode, persona, nowIso());
  db.prepare('INSERT OR IGNORE INTO stage_events (conversation_id, stage, at) VALUES (?, ?, ?)').run(id, 'lead', nowIso());
  return getConv(id);
}

/**
 * Store the single pending draft for a conversation (supersedes any older one).
 * Shared by the request-draft route and the Phase 4 scheduler.
 * @returns the created draft row (raw).
 */
function storeDraft(convId, messages, stageSuggestion, needsHuman, reason) {
  return tx(() => storeDraftInner(convId, messages, stageSuggestion, needsHuman, reason));
}
function storeDraftInner(convId, messages, stageSuggestion, needsHuman, reason) {
  const msgs = Array.isArray(messages) && messages.length ? messages.slice(0, 2).map((m) => String(m)) : [''];
  discardPending(convId); // at-most-one pending draft
  const info = db.prepare(`INSERT INTO drafts
      (conversation_id, messages_json, stage_suggestion, needs_human, reason, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)`)
    .run(convId, JSON.stringify(msgs), STAGES.includes(stageSuggestion) ? stageSuggestion : null,
      needsHuman ? 1 : 0, reason || '', nowIso());
  return db.prepare('SELECT * FROM drafts WHERE id = ?').get(info.lastInsertRowid);
}

/** Flag a conversation for human review (optionally with a terse reason). */
function setNeedsHuman(convId, reason) {
  const r = String(reason || 'needs_human').slice(0, 300);
  db.prepare('UPDATE conversations SET needs_human = 1, needs_human_reason = ? WHERE id = ?')
    .run(r, convId);
  // Owner email (FEATURE 3) — throttled to once / 30 min per conversation so a
  // burst of flags on the same thread doesn't spam. Fire-and-forget.
  const last = needsHumanNotifiedAt.get(convId) || 0;
  if (Date.now() - last >= NEEDS_HUMAN_NOTIFY_MS) {
    needsHumanNotifiedAt.set(convId, Date.now());
    const handle = getConv(convId)?.handle || convId;
    notify('Conversation needs review', `${handle} was flagged: ${r}`).catch(() => {});
  }
}

/** Set a conversation's mode (scheduler drops autopilot → copilot on handoff). */
function setMode(convId, mode) {
  if (MODES.includes(mode)) db.prepare('UPDATE conversations SET mode = ? WHERE id = ?').run(mode, convId);
}

/** Count an autopilot/approved AI turn toward the max-2 guardrail. */
function incrementAiSends(convId) {
  db.prepare('UPDATE conversations SET consecutive_ai_sends = consecutive_ai_sends + 1 WHERE id = ?').run(convId);
}

/** Set followup_count + next due timestamp (NULL clears/exhausts the schedule). */
function setFollowup(convId, count, nextAt) {
  db.prepare('UPDATE conversations SET followup_count = ?, next_followup_at = ? WHERE id = ?')
    .run(count, nextAt, convId);
}

/** Store a persona (self-play) lead message. role 'lead', source 'ai' (machine). */
function addLeadMessage(convId, text) {
  addMessage(convId, 'lead', text, 'ai');
}

/** id of the newest lead message on a conversation (null if none). */
function latestLeadMessageId(convId) {
  return db.prepare("SELECT id FROM messages WHERE conversation_id = ? AND role = 'lead' ORDER BY id DESC LIMIT 1").get(convId)?.id ?? null;
}

/** newest lead message text on a conversation ('' if none). */
function latestLeadText(convId) {
  return db.prepare("SELECT text FROM messages WHERE conversation_id = ? AND role = 'lead' ORDER BY id DESC LIMIT 1").get(convId)?.text ?? '';
}

/** Mark this conversation's Story/Reel keyword trigger as fired (once-only guard). */
function markKwTriggered(convId) {
  db.prepare('UPDATE conversations SET kw_triggered = 1 WHERE id = ?').run(convId);
}

/**
 * Conversations the follow-up sweep should consider: any live stage (lead →
 * booking_sent), not flagged, mode != off. The sweep does the per-row timing +
 * last-message check. lead/engaged are included so a configured seq_lead can
 * fire; without a Core Sequence they still get NO nudge (the sweep skips them).
 */
/** Role of the newest message in a conversation ('lead' | 'setter' | null). Cheap — the sweep calls it per candidate every 15s. */
function lastRole(convId) {
  return db.prepare('SELECT role FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1').get(convId)?.role || null;
}

function followupCandidates() {
  return db.prepare(`SELECT * FROM conversations
    WHERE stage IN ('lead','engaged','qualifying','qualified','booking_sent') AND needs_human = 0 AND mode != 'off'`).all();
}

/**
 * Conversations where the AI still OWES a reply: the lead spoke last, nothing
 * is queued, nothing is flagged, mode is on, and the thread is live. Used by
 * the scheduler's one-shot boot rescue — the humanizing-delay timers are
 * in-memory, so a restart/redeploy mid-delay silently drops the reply, and the
 * follow-up sweep can never revive that thread (it requires the SETTER to have
 * spoken last).
 */
function owedReplyConvs() {
  return db.prepare(`SELECT c.* FROM conversations c
    WHERE c.needs_human = 0 AND c.mode != 'off'
      AND c.stage NOT IN ('dead','routed','sale')
      AND NOT EXISTS (SELECT 1 FROM drafts d WHERE d.conversation_id = c.id AND d.status = 'pending')
      AND (SELECT m.role FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) = 'lead'`).all();
}

/**
 * Conversations the booking sweep should consider: a locked call, not flagged,
 * mode != off. The sweep does the per-row reminder/no-show timing itself.
 */
function bookedConvs() {
  return db.prepare(`SELECT * FROM conversations
    WHERE stage = 'call_booked' AND call_time IS NOT NULL AND needs_human = 0 AND mode != 'off'`).all();
}

/** Append a fired reminder key (hours_before number or 'noshow') to reminders_sent (JSON, dedup). */
function markReminderSent(convId, key) {
  const row = db.prepare('SELECT reminders_sent FROM conversations WHERE id = ?').get(convId);
  let arr; try { arr = JSON.parse(row?.reminders_sent || '[]'); } catch { arr = []; }
  if (!Array.isArray(arr)) arr = [];
  if (!arr.includes(key)) arr.push(key);
  db.prepare('UPDATE conversations SET reminders_sent = ? WHERE id = ?').run(JSON.stringify(arr), convId);
}

/** Did the lead send any message after the given ISO time? (no-show detection). */
function leadSpokeSince(convId, iso) {
  return !!db.prepare("SELECT 1 FROM messages WHERE conversation_id = ? AND role = 'lead' AND created_at > ? LIMIT 1").get(convId, iso);
}

// The scheduler owns all Phase 4 timers + self-play. It reaches the db only
// through these thin wrappers (never the schema directly), which keeps it
// decoupled and unit-testable.
const scheduler = createScheduler({
  getConv,
  getSettings: engineSettings,
  historyOf,
  addLeadMessage,
  deliver,
  deliverVoiceNote,
  varyMessage,
  storeDraft,
  setStage,
  setMode,
  setNeedsHuman,
  incrementAiSends,
  setFollowup,
  onLeadMessage,
  latestLeadMessageId,
  latestLeadText,
  markKwTriggered,
  followupCandidates,
  lastRole,
  owedReplyConvs,
  bookedConvs,
  markReminderSent,
  leadSpokeSince,
  humanConfirmStages: HUMAN_CONFIRM_STAGES,
  // FEATURE 1/3: parked 24h-window drafts notify the owner. Best-effort, fire-and-forget.
  notify: (subject, text) => { notify(subject, text).catch(() => {}); },
});

// FEATURE 2: surface an expired/revoked IG token instead of failing silently.
// instagram.js emits a detail string on any auth failure, and null on a healthy
// igStatus fetch. We persist it to the ig_auth_error setting (frontend reads it
// via /api/instagram/status) and notify ONCE per outage (only when the setting was
// previously empty) so a burst of failed sends doesn't spam the owner.
onIgAuthError((detail) => {
  if (detail) {
    const was = getSetting('ig_auth_error') || '';
    setSetting('ig_auth_error', JSON.stringify({ at: nowIso(), detail: String(detail).slice(0, 200) }));
    if (!was) notify('Instagram token error', `Instagram rejected a request (token may be expired/revoked): ${String(detail).slice(0, 200)}`).catch(() => {});
  } else {
    setSetting('ig_auth_error', ''); // healthy token → clear
  }
});

// ---------- auth / settings ----------
app.post('/api/auth', requireAdmin, (req, res) => res.json({ ok: true }));

app.get('/api/prompt-starter', requireAdmin, (req, res) => {
  res.json({ sections: (STARTER_PROMPT && STARTER_PROMPT.sections) || {}, name: (STARTER_PROMPT && STARTER_PROMPT.name) || '' });
});

app.get('/api/settings', requireAdmin, (req, res) => {
  res.json({
    settings: allSettings(),
    igConfigured: igConfigured(),
    aiReady: !!process.env.ANTHROPIC_API_KEY,
    notifyReady: notifyReady(), // FEATURE 3: owner email notifications live? (frontend reads this)
    calendlyWebhookConfigured: !!getSetting('calendly_webhook_id'), // booking loop wired? (frontend reads this)
    stages: STAGES,
    modes: MODES,
  });
});

/**
 * Instagram connection status for the Settings page. Reports which credentials
 * are configured (never their values) and does a live Graph API check so the UI
 * can show "Connected as @handle". Also surfaces everything the owner must paste
 * into the Meta app webhook config.
 */
app.get('/api/instagram/status', requireAdmin, async (req, res) => {
  const st = await igStatus(); // may clear/set ig_auth_error via the onIgAuthError handler
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'your-domain';
  st.webhook_url = `${proto}://${host}/webhook/instagram`;
  st.subscription_field = 'messages';
  st.permissions = ['instagram_business_manage_messages', 'pages_manage_metadata'];
  // FEATURE 2: surface a dead/revoked token to the UI. Read AFTER igStatus so a
  // just-healed token (igStatus cleared it) reports null immediately.
  st.auth_error = parseJ(getSetting('ig_auth_error') || '', null);
  st.signature_verified = !!process.env.IG_APP_SECRET; // false → Settings shows the IG_APP_SECRET notice (webhooks are rejected until it is set)
  res.json(st);
});

// FEATURE 4: on-demand SQLite backup download. Runs a FRESH backup first so the
// owner always gets a current snapshot, then streams it. PIN-gated.
app.get('/api/backup', requireAdmin, (req, res) => {
  try {
    const file = runBackup(db, DATA_DIR);
    res.download(file);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Backfill existing IG conversations + recent message history into the inbox.
// Idempotent: re-runs dedup on message id, so it never double-inserts.
app.post('/api/instagram/sync-history', requireAdmin, async (req, res) => {
  if (!igConfigured()) return res.status(400).json({ error: 'Instagram not connected' });
  try {
    const threads = await igFetchHistory();
    let newConvs = 0, newMsgs = 0;
    for (const th of threads) {
      let conv = db.prepare("SELECT * FROM conversations WHERE channel = 'instagram' AND external_id = ?").get(th.leadId);
      if (!conv) {
        conv = createConversation({ channel: 'instagram', external_id: th.leadId, handle: th.handle, display_name: th.name });
        newConvs++;
      } else if (th.handle && th.handle !== th.leadId) {
        db.prepare('UPDATE conversations SET handle = COALESCE(?, handle), display_name = COALESCE(?, display_name) WHERE id = ?')
          .run(th.handle, th.name || null, conv.id);
      }
      // Insert oldest→newest so the timeline (and last_message_at) end up correct.
      const ordered = th.messages.slice().sort((a, b) => (a.created_time || '') < (b.created_time || '') ? -1 : 1);
      for (const m of ordered) {
        if (addMessage(conv.id, m.role, m.text, 'human', m.mid || null, null, null, m.created_time || null)) newMsgs++;
      }
    }
    res.json({ ok: true, threads: threads.length, conversations: newConvs, messages: newMsgs });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Audio Arsenal voice-note upload (record or file). Stored in the attachment
// store + served publicly so Instagram can fetch it when the AI fires the clip.
app.get('/api/voice/health', requireAdmin, async (req, res) => {
  res.json({ ffmpeg: await ffmpegAvailable() });
});

app.post('/api/voice', requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio uploaded' });
  const CT_EXT = { 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
    'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm', 'video/mp4': 'm4a' };
  const ct = String(req.file.mimetype || '').split(';')[0].trim().toLowerCase();
  const nameExt = (String(req.file.originalname || '').match(/\.([a-z0-9]{2,5})$/i) || [])[1];
  try {
    // Transcode anything IG might reject (webm/ogg/wav/…) to m4a; m4a/mp3/aac pass through.
    const norm = await normalizeAudio(req.file.buffer, CT_EXT[ct] || nameExt || 'webm');
    const saved = saveBuffer(norm.buf, norm.ext);
    res.json({ ok: true, id: saved.id, mime: saved.mime, url: '/api/attachments/' + saved.id, converted: norm.converted });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/settings', requireAdmin, (req, res) => {
  const body = req.body || {};
  for (const k of Object.keys(SETTING_DEFAULTS)) {
    if (body[k] == null) continue;
    // System-owned state — never writable via the settings form (set by internal flows).
    if (k === 'ig_auth_error' || k === 'calendly_webhook_id' || k === 'calendly_signing_key' || k === 'content_analysis') continue;
    let v = String(body[k]).slice(0, 20000);
    // Guard the two enum-ish settings so downstream never sees garbage.
    if (k === 'default_mode' && !MODES.includes(v)) continue;
    if (k === 'kill_switch') v = v === '1' || v === 'true' ? '1' : '0';
    setSetting(k, v);
  }
  maybeRefreshCalendly(); // pick up a new token / toggle immediately
  res.json({ ok: true, settings: allSettings() });
});

/**
 * Wire the Calendly booking loop: subscribe Calendly to POST booking events to
 * our public /webhook/calendly endpoint. Requires a Calendly PAT (calendly_token)
 * and a public base URL. Persists the subscription id + signing key (system state)
 * so the webhook can verify inbound events. Idempotent — a second run replaces any
 * existing subscription for this URL and rotates in a fresh signing key.
 */
app.post('/api/calendly/webhook-setup', requireAdmin, async (req, res) => {
  const token = getSetting('calendly_token');
  if (!token) return res.status(400).json({ error: 'Add your Calendly API token first' });
  if (!PUBLIC_BASE) return res.status(400).json({ error: 'No public base URL configured (PUBLIC_BASE_URL / RAILWAY_PUBLIC_DOMAIN)' });
  try {
    const out = await setupWebhook(token, PUBLIC_BASE + '/webhook/calendly');
    setSetting('calendly_webhook_id', out.id || '');
    setSetting('calendly_signing_key', out.signing_key || '');
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---------- knowledge base (RAG-lite documents) ----------
app.get('/api/knowledge', requireAdmin, (req, res) => {
  res.json({ documents: listDocuments() });
});
app.post('/api/knowledge', requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (!isSupported(req.file.originalname)) {
    return res.status(400).json({ error: 'Unsupported type — use PDF, .docx, .txt or .md' });
  }
  try {
    const document = await addDocument(req.file.buffer, req.file.originalname);
    res.json({ ok: true, document });
  } catch (e) { res.status(422).json({ error: e.message }); }
});
app.delete('/api/knowledge/:id', requireAdmin, (req, res) => {
  res.json({ ok: deleteDocument(req.params.id) });
});

// ---------- content engine (mines real lead DMs → content ideas, FEATURE 3) ----------
// Assigns stable per-idea ids (i1, i2, …) off a running counter so the frontend
// can key them; the counter lives in the payload so /more keeps incrementing.
function assignIdeaIds(payload) {
  let n = payload._idea_seq || 0;
  for (const idea of payload.ideas || []) {
    if (!idea.id) idea.id = 'i' + (++n);
  }
  payload._idea_seq = n;
  return payload;
}

// Real lead messages, sim/test conversations excluded (channel = 'sim'), longer
// than a trivial "yh"/"lol", newest first, capped so one analysis stays bounded.
function contentLeadMessages() {
  return db.prepare(
    `SELECT c.handle, m.text, m.created_at
       FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.role = 'lead' AND length(m.text) >= 12 AND c.channel != 'sim'
      ORDER BY m.created_at DESC LIMIT 500`
  ).all();
}

app.get('/api/content', requireAdmin, (req, res) => {
  const cached = parseJ(getSetting('content_analysis') || '', null);
  if (!cached) return res.json({ empty: true });
  res.json(cached);
});

app.post('/api/content/analyze', requireAdmin, async (req, res) => {
  const rows = contentLeadMessages();
  if (rows.length < 20) return res.status(400).json({ error: 'not enough lead messages yet' });
  try {
    const analysis = await analyzeDms(rows);
    // Classification pass: attach REAL per-theme message counts + dates (for the
    // bar chart's daily/weekly/monthly filtering) instead of the model's vague
    // count_hint. Best-effort — a failure here must not sink the whole analysis.
    const pains = Array.isArray(analysis.pains) ? analysis.pains : [];
    try {
      const assignments = await classifyMessages(pains.map((p) => p.theme), rows);
      const byTheme = new Map(); // theme index → [created_at ISO, …]
      for (const { i, t } of assignments) {
        const iso = toIso(rows[i]?.created_at);
        if (!iso) continue;
        if (!byTheme.has(t)) byTheme.set(t, []);
        byTheme.get(t).push(iso);
      }
      pains.forEach((p, t) => {
        const dates = (byTheme.get(t) || []).sort((a, b) => (a < b ? 1 : -1)).slice(0, 200);
        p.count = dates.length;
        p.dates = dates;
      });
    } catch (e) {
      console.error('[content] classify failed', e.message);
      for (const p of pains) {
        p.count = Array.isArray(p.quotes) ? p.quotes.length : 0;
        p.dates = [];
      }
    }
    const { ideas } = await generateIdeas(analysis, []);
    const payload = assignIdeaIds({
      generated_at: nowIso(),
      sample_size: rows.length,
      ...analysis,
      ideas: Array.isArray(ideas) ? ideas : [],
    });
    setSetting('content_analysis', JSON.stringify(payload));
    res.json(payload);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.post('/api/content/more', requireAdmin, async (req, res) => {
  const payload = parseJ(getSetting('content_analysis') || '', null);
  if (!payload) return res.status(400).json({ error: 'run an analysis first' });
  try {
    const existingTitles = (payload.ideas || []).map((i) => i.title);
    const { ideas } = await generateIdeas(payload, existingTitles);
    const have = new Set(existingTitles.map((t) => String(t || '').trim().toLowerCase()));
    const fresh = (Array.isArray(ideas) ? ideas : []).filter((i) => {
      const key = String(i.title || '').trim().toLowerCase();
      if (!key || have.has(key)) return false;
      have.add(key);
      return true;
    });
    payload.ideas = (payload.ideas || []).concat(fresh);
    assignIdeaIds(payload);
    setSetting('content_analysis', JSON.stringify(payload));
    res.json(payload);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---------- conversations ----------
// Per-row `attention` (see below) lets the inbox sort by "who needs me most".
// stageRank weights leads deeper in the funnel higher (a booking_sent is more
// worth chasing than a cold lead).
const ATTENTION_STAGE_RANK = { booking_sent: 5, qualified: 4, qualifying: 3, engaged: 2, lead: 1 };
app.get('/api/conversations', requireAdmin, (req, res) => {
  const stage = String(req.query.stage || '').trim();
  const q = String(req.query.q || '').trim().toLowerCase();
  let rows = db.prepare(`
    SELECT c.*,
      (SELECT text FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_text,
      EXISTS(SELECT 1 FROM drafts d WHERE d.conversation_id = c.id AND d.status = 'pending') AS pending_draft,
      (SELECT MIN(created_at) FROM drafts d WHERE d.conversation_id = c.id AND d.status = 'pending') AS oldest_pending_draft_at
    FROM conversations c
    ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC
    LIMIT 500`).all();
  if (stage && STAGES.includes(stage)) rows = rows.filter((r) => r.stage === stage);
  if (q) rows = rows.filter((r) =>
    r.handle.toLowerCase().includes(q) ||
    (r.display_name || '').toLowerCase().includes(q) ||
    (r.last_text || '').toLowerCase().includes(q));
  // Attention score the inbox can opt into sorting by. Higher = more urgent.
  // Default API sort stays unchanged (last_message_at DESC); the frontend sorts
  // by `attention` client-side when the user chooses. Components:
  //   stageRank*10  — funnel depth (booking_sent weighted highest)
  //   +40           — flagged for human review
  //   +draftAgeHours (cap 24) — a pending draft that's been waiting to be sent
  //   +25           — a booked call within the next 48h (needs prep/confirm)
  const now = Date.now();
  const shaped = rows.map((r) => {
    let attention = (ATTENTION_STAGE_RANK[r.stage] || 0) * 10;
    if (r.needs_human) attention += 40;
    if (r.oldest_pending_draft_at) {
      const ageMs = now - new Date(r.oldest_pending_draft_at).getTime();
      if (ageMs > 0) attention += Math.min(ageMs / 3600_000, 24);
    }
    if (r.call_time) {
      const untilMs = new Date(r.call_time).getTime() - now;
      if (untilMs >= 0 && untilMs <= 48 * 3600_000) attention += 25;
    }
    return { ...shapeConv(r), pending_draft: !!r.pending_draft, attention };
  });
  res.json(shaped);
});

app.get('/api/conversations/:id', requireAdmin, (req, res) => {
  const conv = getConv(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  res.json({
    conversation: shapeConv(conv),
    messages: historyOf(conv.id),
    pending_draft: pendingDraftOf(conv.id),
    // Stage transitions for the inline "Chat moved to: X" timeline markers.
    stage_events: db.prepare('SELECT stage, at FROM stage_events WHERE conversation_id = ? ORDER BY at').all(conv.id),
  });
});

/**
 * Human edits to a conversation. Nothing here auto-advances the pipeline;
 * these are deliberate human moves:
 *  - mode: set copilot|autopilot|off
 *  - stage: free stage set; setting 'call_booked' or 'sale' is the human confirm path → clears needs_human
 *  - false_positive: only meaningful on a call_booked conversation (mark, keep stage)
 *  - revive: dead → qualifying, reset follow-up count (recover a ghosted lead)
 */
// Bulk set AI mode on many conversations at once (inbox multi-select). autopilot
// = AI auto-sends; copilot = AI drafts, you approve; off = full manual.
/** Clear every needs_human flag in one go. `send_failed_only` limits it to the
 *  flags a dead Instagram token leaves behind, and puts those threads back on
 *  autopilot (that failure is the only thing that dropped them to copilot). */
app.post('/api/conversations/handled-all', requireAdmin, (req, res) => {
  const onlySendFailed = !!req.body?.send_failed_only;
  const r = onlySendFailed
    ? db.prepare("UPDATE conversations SET needs_human = 0, needs_human_reason = NULL, mode = 'autopilot' WHERE needs_human = 1 AND needs_human_reason LIKE 'send failed%'").run()
    : db.prepare('UPDATE conversations SET needs_human = 0, needs_human_reason = NULL WHERE needs_human = 1').run();
  res.json({ ok: true, cleared: r.changes });
});

app.post('/api/conversations/bulk-mode', requireAdmin, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, 1000) : [];
  const mode = String(req.body?.mode || '');
  if (!MODES.includes(mode)) return res.status(400).json({ error: 'Bad mode' });
  for (const id of ids) setMode(id, mode); // setMode ignores unknown ids + validates mode
  res.json({ ok: true, updated: ids.length, mode });
});

app.patch('/api/conversations/:id', requireAdmin, (req, res) => {
  const conv = getConv(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  const body = req.body || {};

  // Validate the ENTIRE body before touching the row — a 400 must never leave
  // a partial write behind (e.g. mode applied, then revive rejected).
  if (body.mode !== undefined && !MODES.includes(body.mode)) {
    return res.status(400).json({ error: 'Bad mode' });
  }
  if (body.display_name !== undefined && typeof body.display_name !== 'string') {
    return res.status(400).json({ error: 'Bad display_name' });
  }
  // Humans may only CLEAR the flag (mark handled) — setting it is the engine's job.
  if (body.needs_human !== undefined && body.needs_human !== false) {
    return res.status(400).json({ error: 'needs_human can only be set to false (mark handled)' });
  }
  if (body.stage !== undefined && !STAGES.includes(body.stage)) {
    return res.status(400).json({ error: 'Bad stage' });
  }
  if (body.revive === true && body.stage !== undefined) {
    return res.status(400).json({ error: 'stage and revive conflict — send one or the other' });
  }
  if (body.revive === true && conv.stage !== 'dead') {
    return res.status(400).json({ error: 'Only dead conversations can be revived' });
  }
  if (typeof body.false_positive === 'boolean') {
    // Judge against the stage this SAME request lands on (e.g. stage:'call_booked' + false_positive is valid).
    const effectiveStage = body.revive === true ? 'qualifying' : (body.stage ?? conv.stage);
    if (effectiveStage !== 'call_booked') {
      return res.status(400).json({ error: 'false_positive only applies to call_booked conversations' });
    }
  }

  // All valid — apply everything.
  if (body.mode !== undefined) {
    db.prepare('UPDATE conversations SET mode = ? WHERE id = ?').run(body.mode, conv.id);
  }
  if (body.display_name !== undefined) {
    db.prepare('UPDATE conversations SET display_name = ? WHERE id = ?')
      .run(body.display_name.trim().slice(0, 120) || null, conv.id);
  }
  if (body.needs_human === false) {
    db.prepare('UPDATE conversations SET needs_human = 0, needs_human_reason = NULL WHERE id = ?').run(conv.id);
  }
  if (body.stage !== undefined) {
    setStage(conv.id, body.stage);
    // Human confirming a call_booked or sale is the ONLY path there — clears the flag.
    if (HUMAN_CONFIRM_STAGES.has(body.stage)) {
      db.prepare('UPDATE conversations SET needs_human = 0, needs_human_reason = NULL WHERE id = ?').run(conv.id);
    }
  }
  if (body.revive === true) {
    setStage(conv.id, 'qualifying');
    db.prepare('UPDATE conversations SET followup_count = 0, next_followup_at = NULL WHERE id = ?').run(conv.id);
  }
  if (typeof body.false_positive === 'boolean') {
    db.prepare('UPDATE conversations SET false_positive = ? WHERE id = ?').run(body.false_positive ? 1 : 0, conv.id);
  }

  res.json(shapeConv(getConv(conv.id)));
});

/** Human manual send. Filters, delivers, resets AI-send counter, supersedes drafts. */
app.post('/api/conversations/:id/send', requireAdmin, async (req, res) => {
  const conv = getConv(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Empty message' });
  try {
    const out = await deliver(conv, text, 'human');
    if (!out.ok) return res.status(422).json({ error: 'Blocked by outbound filter', reason: out.reason });
    // Human took the wheel: guardrail counter resets, any AI draft is stale.
    db.prepare('UPDATE conversations SET consecutive_ai_sends = 0 WHERE id = ?').run(conv.id);
    discardPending(conv.id);
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

/** Ask the engine for a fresh draft; store as the single pending draft. */
app.post('/api/conversations/:id/request-draft', requireAdmin, async (req, res) => {
  const conv = getConv(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  // Kill switch halts ALL AI drafting globally — nothing reaches the engine.
  if (getSetting('kill_switch') === '1') return res.status(409).json({ error: 'Kill switch is on' });
  try {
    const move = await generateMove(engineSettings(), conv, historyOf(conv.id));
    const messages = Array.isArray(move?.messages) && move.messages.length
      ? move.messages.slice(0, 2).map((m) => cleanOutbound(String(m))) : [''];
    const draft = storeDraft(conv.id, messages, move?.stage, move?.needs_human, move?.reason);
    res.json({ ...draft, messages: parseJ(draft.messages_json, []), needs_human: !!draft.needs_human });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * AI Preview (Prompt page sandbox): run the engine against an ephemeral,
 * never-persisted history so the owner can test his script exactly as live
 * DMs would run it. Same kill-switch gate and outbound filter as real sends —
 * blocked messages come back marked, not hidden.
 */
app.post('/api/preview', requireAdmin, async (req, res) => {
  if (getSetting('kill_switch') === '1') return res.status(409).json({ error: 'Kill switch is on' });
  const history = (Array.isArray(req.body?.history) ? req.body.history : [])
    .filter((m) => m && (m.role === 'lead' || m.role === 'setter') && String(m.text || '').trim())
    .slice(-40)
    .map((m) => ({ role: m.role, text: String(m.text).slice(0, 2000) }));
  if (!history.length) return res.status(400).json({ error: 'Empty history' });
  const stage = STAGES.includes(req.body?.stage) ? req.body.stage : 'lead';
  try {
    const move = await generateMove(engineSettings(), { handle: 'preview_lead', stage }, history);
    const regexes = parseJ(getSetting('outbound_filter_regexes'), []);
    const messages = (move.messages || []).map((raw) => {
      const text = cleanOutbound(String(raw));
      return { text, blocked: !applyOutboundFilter(text, regexes).ok };
    });
    res.json({ messages, stage: move.stage, needs_human: move.needs_human, reason: move.reason });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- drafts ----------
app.get('/api/drafts', requireAdmin, (req, res) => {
  const status = String(req.query.status || 'pending');
  const rows = db.prepare(`
    SELECT d.*, c.handle, c.display_name, c.channel, c.stage AS conv_stage
    FROM drafts d JOIN conversations c ON c.id = d.conversation_id
    WHERE d.status = ? ORDER BY d.id DESC LIMIT 500`).all(status);
  res.json(rows.map((d) => ({ ...d, messages: parseJ(d.messages_json, []), needs_human: !!d.needs_human })));
});

/**
 * Approve a draft → send each message (filtered), mark approved, apply the
 * stage suggestion EXCEPT the human-confirm stages (call_booked/sale, which
 * only a deliberate PATCH may set), and count this as an AI send toward the
 * autopilot guardrail. body.messages? lets the human edit before sending.
 */
app.post('/api/drafts/:id/approve', requireAdmin, async (req, res) => {
  const draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(Number(req.params.id));
  if (!draft) return res.status(404).json({ error: 'Not found' });
  if (draft.status !== 'pending') return res.status(409).json({ error: 'Draft already resolved' });
  const conv = getConv(draft.conversation_id);
  if (!conv) return res.status(404).json({ error: 'Conversation gone' });

  const edited = Array.isArray(req.body?.messages) ? req.body.messages : parseJ(draft.messages_json, []);
  const messages = edited.map((m) => String(m).trim()).filter(Boolean).slice(0, 2);
  if (!messages.length) return res.status(400).json({ error: 'No message to send' });

  // Filter ALL messages BEFORE delivering any: a mid-loop block would leave a
  // half-sent pending draft, and a retry-approve would then duplicate the
  // already-sent half to the lead. Blocked → 422, nothing sent, draft stays pending.
  const regexes = parseJ(getSetting('outbound_filter_regexes'), []);
  for (const m of messages) {
    const f = applyOutboundFilter(m, regexes);
    if (!f.ok) {
      db.prepare('UPDATE conversations SET needs_human = 1, needs_human_reason = ? WHERE id = ?')
        .run(f.reason || 'outbound_filter', conv.id);
      return res.status(422).json({ error: 'Blocked by outbound filter', reason: f.reason || 'outbound_filter' });
    }
  }

  try {
    for (const m of messages) {
      // deliver() re-filters with the same regexes (pre-verified clean) — harmless.
      const out = await deliver(conv, m, 'ai');
      if (!out.ok) return res.status(422).json({ error: 'Blocked by outbound filter', reason: out.reason });
    }
    // Approved AI draft counts as one AI turn (regardless of split into 1-2 msgs).
    db.prepare('UPDATE conversations SET consecutive_ai_sends = consecutive_ai_sends + 1 WHERE id = ?').run(conv.id);
    // Apply stage suggestion, but never auto-confirm call_booked/sale (human PATCH only).
    if (draft.stage_suggestion && !HUMAN_CONFIRM_STAGES.has(draft.stage_suggestion) && STAGES.includes(draft.stage_suggestion)) {
      setStage(conv.id, draft.stage_suggestion);
    }
    db.prepare("UPDATE drafts SET status = 'approved', resolved_at = ? WHERE id = ?").run(nowIso(), draft.id);
    res.json({ ok: true, sent: messages });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

/**
 * "Send all" — fire every pending draft in one click. Same per-draft rules as
 * single approve, but one bad draft never aborts the batch: each resolves to a
 * summary bucket and the caller gets the tallies. Deliberately skipped:
 *  - flagged (needs_human) drafts — they exist FOR human judgment;
 *  - IG drafts outside Meta's 24h window — the API would reject them; they stay
 *    pending for the owner to send from his phone.
 */
app.post('/api/drafts/send-all', requireAdmin, async (req, res) => {
  // Oldest first: threads get their message in the order the AI queued them.
  const pending = db.prepare(`SELECT * FROM drafts WHERE status = 'pending' ORDER BY id ASC`).all();
  const regexes = parseJ(getSetting('outbound_filter_regexes'), []);
  const summary = { sent: 0, window: 0, flagged: 0, blocked: 0, failed: 0 };
  for (const draft of pending) {
    if (draft.needs_human) { summary.flagged++; continue; }
    const conv = getConv(draft.conversation_id);
    const messages = conv
      ? parseJ(draft.messages_json, []).map((m) => String(m).trim()).filter(Boolean).slice(0, 2) : [];
    if (!messages.length) { summary.failed++; continue; }
    if (conv.channel === 'instagram' && !withinMessagingWindow(conv)) { summary.window++; continue; }
    // Filter ALL messages before delivering any (same reasoning as single approve:
    // a mid-loop block would half-send, and a retry would duplicate the sent half).
    if (messages.some((m) => !applyOutboundFilter(m, regexes).ok)) {
      db.prepare('UPDATE conversations SET needs_human = 1, needs_human_reason = ? WHERE id = ?')
        .run('outbound_filter', conv.id);
      summary.blocked++; continue;
    }
    try {
      let ok = true;
      for (const m of messages) {
        const out = await deliver(conv, m, 'ai');
        if (!out || !out.ok) { ok = false; break; }
      }
      if (!ok) { summary.failed++; continue; }
      db.prepare('UPDATE conversations SET consecutive_ai_sends = consecutive_ai_sends + 1 WHERE id = ?').run(conv.id);
      if (draft.stage_suggestion && !HUMAN_CONFIRM_STAGES.has(draft.stage_suggestion) && STAGES.includes(draft.stage_suggestion)) {
        setStage(conv.id, draft.stage_suggestion);
      }
      db.prepare("UPDATE drafts SET status = 'approved', resolved_at = ? WHERE id = ?").run(nowIso(), draft.id);
      summary.sent++;
    } catch { summary.failed++; }
  }
  res.json({ ok: true, total: pending.length, ...summary });
});

app.post('/api/drafts/:id/discard', requireAdmin, (req, res) => {
  const draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(Number(req.params.id));
  if (!draft) return res.status(404).json({ error: 'Not found' });
  if (draft.status !== 'pending') return res.status(409).json({ error: 'Draft already resolved' });
  db.prepare("UPDATE drafts SET status = 'discarded', resolved_at = ? WHERE id = ?").run(nowIso(), draft.id);
  res.json({ ok: true });
});

// ---------- stats ----------
app.get('/api/stats', requireAdmin, (req, res) => {
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
  // Optional dashboard date range: limits the funnel's "reached" counts (and
  // therefore the conversion percentages) to stage events inside the window.
  // Snapshot numbers (current stage, modes, flags) are point-in-time and ignore it.
  const days = Number(req.query.days);
  const cutoff = Number.isFinite(days) && days > 0 ? new Date(Date.now() - days * 86400_000).toISOString() : null;

  const total = db.prepare('SELECT COUNT(*) c FROM conversations').get().c;
  const leadsToday = db.prepare('SELECT COUNT(*) c FROM conversations WHERE created_at >= ?').get(startOfToday.toISOString()).c;
  const everQualified = db.prepare("SELECT COUNT(*) c FROM stage_events WHERE stage = 'qualified'").get().c;
  const bookedThisWeek = db.prepare("SELECT COUNT(*) c FROM stage_events WHERE stage = 'call_booked' AND at >= ?").get(weekAgo).c;
  const pendingDrafts = db.prepare("SELECT COUNT(*) c FROM drafts WHERE status = 'pending'").get().c;
  const falsePositives = db.prepare('SELECT COUNT(*) c FROM conversations WHERE false_positive = 1').get().c;

  const active = db.prepare("SELECT COUNT(*) c FROM conversations WHERE stage NOT IN ('routed','dead')").get().c;
  const autopilotCount = db.prepare("SELECT COUNT(*) c FROM conversations WHERE mode = 'autopilot'").get().c;
  const needsReview = db.prepare('SELECT COUNT(*) c FROM conversations WHERE needs_human = 1').get().c;
  const inFollowup = db.prepare('SELECT COUNT(*) c FROM conversations WHERE next_followup_at IS NOT NULL').get().c;

  const byStage = {};
  const reached = {};
  for (const stage of STAGES) {
    byStage[stage] = db.prepare('SELECT COUNT(*) c FROM conversations WHERE stage = ?').get(stage).c;
    reached[stage] = cutoff
      ? db.prepare('SELECT COUNT(*) c FROM stage_events WHERE stage = ? AND at >= ?').get(stage, cutoff).c
      : db.prepare('SELECT COUNT(*) c FROM stage_events WHERE stage = ?').get(stage).c;
  }
  // Inside a ?days window, backfilled intermediate events carry the jump's
  // timestamp while the original lead event keeps its older one, so a later
  // stage can out-count an earlier one. Clamp to "reached this stage or beyond
  // in the window" — keeps the funnel monotonic and conversions <= 100%.
  for (let i = FUNNEL_STAGES.length - 2; i >= 0; i--) {
    reached[FUNNEL_STAGES[i]] = Math.max(reached[FUNNEL_STAGES[i]], reached[FUNNEL_STAGES[i + 1]]);
  }

  // ---- reply_latency: median seconds from a lead message to the NEXT setter
  // reply in the same conversation, over the last 30 days, split by who replied
  // (ai vs human). One ordered pass; walk per conversation in JS collecting each
  // lead→next-setter gap. Scan is bounded (30d + LIMIT 20000).
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000).toISOString();
  const median = (arr) => {
    if (!arr.length) return null;
    const s = arr.slice().sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };
  const aiGaps = [], humanGaps = [];
  {
    const msgRows = db.prepare(
      `SELECT conversation_id, role, source, created_at FROM messages
       WHERE created_at >= ? ORDER BY conversation_id, created_at, id LIMIT 20000`
    ).all(thirtyDaysAgo);
    let pendingLeadAt = null, curConv = null;
    for (const m of msgRows) {
      if (m.conversation_id !== curConv) { curConv = m.conversation_id; pendingLeadAt = null; }
      if (m.role === 'lead') {
        // Remember the FIRST unanswered lead message; a burst of lead messages
        // before a reply all map to that first one's timestamp.
        if (pendingLeadAt == null) pendingLeadAt = m.created_at;
      } else if (pendingLeadAt != null) { // setter message answering a pending lead
        const secs = (new Date(m.created_at).getTime() - new Date(pendingLeadAt).getTime()) / 1000;
        if (secs >= 0) (m.source === 'human' ? humanGaps : aiGaps).push(secs);
        pendingLeadAt = null;
      }
    }
  }
  const replyLatency = { ai: median(aiGaps), human: median(humanGaps) };

  // ---- stage_aging: active-pipeline conversations sitting > 48h since their last
  // message (stalled leads the owner should nudge or clear).
  const stageAging = {};
  const staleCutoff = new Date(Date.now() - 48 * 3600_000).toISOString();
  for (const st of ['lead', 'engaged', 'qualifying', 'qualified', 'booking_sent']) {
    stageAging[st] = db.prepare(
      'SELECT COUNT(*) c FROM conversations WHERE stage = ? AND last_message_at IS NOT NULL AND last_message_at < ?'
    ).get(st, staleCutoff).c;
  }

  // ---- flag_reasons: top reasons conversations are flagged for review, grouped
  // by the first 30 chars of the reason so near-identical reasons collapse together.
  const flagReasons = db.prepare(
    `SELECT substr(needs_human_reason, 1, 30) AS reason, COUNT(*) AS n
     FROM conversations
     WHERE needs_human = 1 AND needs_human_reason IS NOT NULL AND needs_human_reason != ''
     GROUP BY reason ORDER BY n DESC LIMIT 6`
  ).all();

  res.json({
    leads_today: leadsToday,
    qualification_rate: total ? Math.round((everQualified / total) * 100) : 0,
    booked_this_week: bookedThisWeek,
    pending_drafts: pendingDrafts,
    false_positives: falsePositives,
    total,
    active,
    autopilot_count: autopilotCount,
    autopilot_pct: total ? Math.round((autopilotCount / total) * 100) : 0,
    needs_review: needsReview,
    in_followup: inFollowup,
    by_stage: byStage,
    reached,
    reply_latency: replyLatency,   // {ai: sec|null, human: sec|null} median lead→setter reply time (30d)
    stage_aging: stageAging,       // {stage: count} conversations stalled >48h in each active stage
    flag_reasons: flagReasons,     // [{reason, n}] top 6 needs_human reasons (first 30 chars)
  });
});

// ---------- simulator ----------
/** List available sim personas (id/name/handle only — briefs stay server-side). */
app.get('/api/personas', requireAdmin, (req, res) => {
  res.json(PERSONAS.map((p) => ({ id: p.id, name: p.name, handle: p.handle })));
});

/** Spawn a sim conversation. Persona is stored only (Phase 4 gives it a voice). */
app.post('/api/sim/spawn', requireAdmin, (req, res) => {
  const personaId = req.body?.personaId;
  const persona = personaId && PERSONA_BY_ID.has(personaId) ? PERSONA_BY_ID.get(personaId) : null;
  if (personaId && !persona) return res.status(400).json({ error: 'Unknown persona' });
  const handle = String(req.body?.handle || persona?.handle || 'test_lead').slice(0, 60);
  const conv = createConversation({
    channel: 'sim',
    handle,
    display_name: persona?.name || null,
    persona: persona?.id || null,
  });
  res.json(shapeConv(conv));
});

/** Sim-only: store a lead message (Phase 4 will drive this from personas). */
app.post('/api/conversations/:id/lead-message', requireAdmin, (req, res) => {
  const conv = getConv(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  if (conv.channel !== 'sim') return res.status(400).json({ error: 'Only simulator conversations' });
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Empty message' });
  addMessage(conv.id, 'lead', text, 'human');
  onLeadMessage(conv.id);
  scheduler.onInboundLead(conv.id); // autopilot/copilot turn (mode-aware)
  res.json({ ok: true });
});

// ---------- instagram business-login OAuth redirect landing ----------
// Meta requires a valid HTTPS redirect URL for the Instagram Business Login
// config. The owner generates their long-lived token from the Meta dashboard
// directly (copied into IG_PAGE_TOKEN), so this just gives a clean landing page
// after authorizing rather than a 404.
app.get('/auth/instagram/callback', (req, res) => {
  res.type('html').send('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Instagram authorization</title></head>'
    + '<body style="font-family:Inter,system-ui,sans-serif;background:#171a21;color:#f9fafa;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:24px">'
    + '<div style="max-width:420px"><h2 style="font-weight:600;margin:0 0 8px">Instagram authorization received</h2>'
    + '<p style="color:#a7abb4;line-height:1.6;margin:0">You can close this tab. Copy your access token and account ID from the Meta dashboard and add them to the app.</p></div></body></html>');
});

// ---------- legal pages (required to publish the Meta app) ----------
// Real, honest policy pages so the app can go Live. Generic by design — the
// owner can edit the copy; they satisfy Meta's Privacy Policy / Data Deletion
// requirements for an Instagram-messaging app.
function legalPage(title, sections) {
  const body = sections.map(([h, p]) => `<h2>${h}</h2><p>${p}</p>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>`
    + `<style>body{font-family:Inter,system-ui,sans-serif;background:#171a21;color:#e9eaed;margin:0;padding:48px 20px;line-height:1.65}`
    + `main{max-width:680px;margin:0 auto}h1{color:#f9fafa;font-size:26px;margin:0 0 6px}h2{color:#f9fafa;font-size:17px;margin:28px 0 6px}`
    + `p{color:#a7abb4;margin:0}.upd{color:#7b8090;font-size:13px;margin-bottom:8px}a{color:#7c8cff}</style></head>`
    + `<body><main><h1>${title}</h1><p class="upd">Last updated: 2026</p>${body}</main></body></html>`;
}
const CONTACT = 'Reply to the conversation on Instagram, or email the address listed on the associated Meta app.';
app.get('/privacy', (req, res) => res.type('html').send(legalPage('Privacy Policy', [
  ['What this service is', 'This tool helps the operator of a single Instagram business account read and respond to their own Instagram direct messages, using Meta&rsquo;s official Instagram Messaging API and AI-assisted reply drafting.'],
  ['Information processed', 'Direct messages sent to the connected Instagram business account &mdash; message text, the sender&rsquo;s Instagram username and display name, and timestamps &mdash; accessed only through Meta&rsquo;s official Instagram Graph API with the account owner&rsquo;s authorization.'],
  ['How it is used', 'To show conversations to the account owner and let them (or an AI assistant) draft and send replies. Message content may be sent to our AI provider (Anthropic) solely to generate reply drafts; it is not used to train models.'],
  ['Sharing', 'We do not sell your data. It is processed only to operate this messaging tool. The third parties involved are Meta/Instagram (the messaging platform) and Anthropic (AI drafting).'],
  ['Retention and deletion', 'Conversations are retained to provide message history. To request deletion of your data, see the Data Deletion instructions at /data-deletion. Data is also removed if the Instagram connection is disconnected.'],
  ['Contact', CONTACT],
])));
app.get('/data-deletion', (req, res) => res.type('html').send(legalPage('Data Deletion', [
  ['Request deletion of your data', 'If you have messaged this Instagram business account and want your data removed, you can request deletion at any time.'],
  ['How', 'Reply to the conversation on Instagram asking for your data to be deleted, or email the address listed on the associated Meta app. The account owner will remove your conversation and all associated data from the system.'],
  ['Automatic removal', 'Your data is also removed if the account owner disconnects the Instagram integration.'],
  ['Contact', CONTACT],
])));
app.get('/terms', (req, res) => res.type('html').send(legalPage('Terms of Service', [
  ['Use of this service', 'This tool is operated by the owner of the connected Instagram business account for managing their own direct messages. It is provided on an as-is basis with no warranty.'],
  ['Consent', 'By messaging the connected Instagram account, you consent to your messages being processed as described in the Privacy Policy at /privacy.'],
  ['Contact', CONTACT],
])));

/**
 * Persist one inbound/echo message event: its text (if any) and each attachment.
 * Attachments are downloaded to our own store (IG URLs expire); voice notes are
 * transcribed (Groq/OpenAI Whisper, if a key is set) so both the owner and the AI
 * can read them. The event `mid` rides on the FIRST stored row so a redelivery
 * dedups the whole event.
 */
async function ingestMessage(conv, ev) {
  const role = ev.direction === 'out' ? 'setter' : 'lead';
  let midUsed = false;
  const useMid = () => (midUsed ? null : ((midUsed = true), ev.mid));

  if (ev.text) addMessage(conv.id, role, ev.text, 'human', useMid(), null, null);

  // "Turn On AI When I Send…" must work from the owner's PHONE, not just the
  // dashboard composer: phone sends arrive here as webhook echoes and never pass
  // through deliver()'s phrase check. Same rule as deliver(): an outbound human
  // message matching a handoff phrase flips this chat to autopilot. (The AI then
  // waits for the lead's next reply — the owner just sent the opener himself.)
  if (role === 'setter' && ev.text && conv.mode !== 'autopilot'
      && matchExactPhrase(ev.text, parseJ(getSetting('ai_on_phrases'), []))) {
    setMode(conv.id, 'autopilot');
    console.log(`[ai-on] handoff phrase echoed from owner's phone → autopilot (@${conv.handle})`);
  }

  for (const att of ev.attachments || []) {
    const kind = attachmentKind(att.type);
    let saved = null;
    try { saved = await saveFromUrl(att.url, att.type); }
    catch (e) { console.error('attachment download failed:', e.message); }
    let text;
    if (kind === 'audio') {
      text = '';
      if (saved) {
        try { text = (await transcribeAudio(attachmentPath(saved.id))) || ''; }
        catch (e) { console.error('transcribe failed:', e.message); }
      }
      if (!text) text = '[voice note]';
    } else {
      text = kind === 'image' ? '[photo]' : kind === 'video' ? '[video]' : '[attachment]';
    }
    addMessage(conv.id, role, text, 'human', useMid(), kind, saved ? saved.id : null);
  }
}

// ---------- attachment media (served to the owner's chat; unguessable ids) ----------
// Supports HTTP Range so <audio>/<video> elements (which request byte ranges and
// error on a plain 200) play + seek correctly — including Safari, which REQUIRES it.
app.get('/api/attachments/:id', (req, res) => {
  const p = attachmentPath(req.params.id);
  if (!p) return res.sendStatus(404);
  let size;
  try { size = fs.statSync(p).size; } catch { return res.sendStatus(404); } // file vanished (TOCTOU)
  res.setHeader('Content-Type', attachmentMime(req.params.id));
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=86400');

  // Parse a SINGLE byte range. Suffix ("bytes=-500" = last 500), normal
  // ("bytes=100-199"), open ("bytes=100-"). Multi-range or malformed → serve the
  // full 200 (RFC-permitted) rather than a wrong 206.
  let start = 0, end = size - 1, partial = false;
  const header = req.headers.range;
  if (header && /^bytes=/.test(header)) {
    const spec = header.slice(6);
    if (!spec.includes(',')) {
      const dash = spec.indexOf('-');
      const sStr = spec.slice(0, dash), eStr = spec.slice(dash + 1);
      if (sStr === '' && eStr !== '') {                 // suffix: last N bytes
        const n = parseInt(eStr, 10);
        if (!isNaN(n)) { start = Math.max(0, size - n); end = size - 1; partial = true; }
      } else if (sStr !== '') {                          // normal or open-ended
        const s = parseInt(sStr, 10);
        const e = eStr !== '' ? parseInt(eStr, 10) : size - 1;
        if (!isNaN(s)) { start = s; end = (isNaN(e) || e >= size) ? size - 1 : e; partial = true; }
      }
      if (partial && (start > end || start >= size)) {
        res.status(416).setHeader('Content-Range', `bytes */${size}`);
        return res.end();
      }
    }
  }

  const onErr = () => { if (!res.headersSent) res.sendStatus(500); else res.destroy(); };
  if (partial) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', end - start + 1);
    fs.createReadStream(p, { start, end }).on('error', onErr).pipe(res);
  } else {
    res.setHeader('Content-Length', size);
    fs.createReadStream(p).on('error', onErr).pipe(res);
  }
});

// ---------- instagram webhook (dormant until configured) ----------
// GET is Meta's subscription handshake — it only needs the verify token, which
// the owner sets first (the page token/business id come later), so gate on that
// alone rather than full igConfigured() or verification would fail during setup.
app.get('/webhook/instagram', (req, res) => {
  if (!process.env.IG_VERIFY_TOKEN) return res.sendStatus(404);
  igVerifyWebhook(req, res);
});
// Verify Meta's X-Hub-Signature-256 HMAC over the raw body. Enabled once
// IG_APP_SECRET is set; until then it returns true (verification disabled) so
// setup isn't blocked, but SETTING IG_APP_SECRET is strongly recommended — it's
// what stops anyone on the internet POSTing forged events to this endpoint.
let _igUnsignedWarned = false;
function verifyWebhookSignature(req) {
  const secret = process.env.IG_APP_SECRET;
  if (!secret) {
    // No app secret yet: the owner chose (2026-09-04) to keep DMs flowing rather
    // than reject unverified events, so accept them and warn — in the server log
    // and with a red notice on the Settings › Instagram card (signature_verified
    // = false). Until IG_APP_SECRET is set, anyone who finds the webhook URL could
    // forge lead messages. Verification enforces itself the moment it is set.
    if (igConfigured() && !_igUnsignedWarned) { console.error('[webhook] IG_APP_SECRET is not set — accepting UNVERIFIED Instagram webhooks. Add it on Railway (Meta app → Settings → Basic → App Secret) to enforce signatures.'); _igUnsignedWarned = true; }
    return true;
  }
  const header = String(req.headers['x-hub-signature-256'] || '');
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody || Buffer.alloc(0)).digest('hex');
  try {
    const a = Buffer.from(header), b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}
app.post('/webhook/instagram', async (req, res) => {
  if (!verifyWebhookSignature(req)) return res.sendStatus(403); // reject spoofed webhooks
  res.sendStatus(200);
  if (!igConfigured()) return;
  let events = [];
  try { events = igParseInbound(req.body); } catch { return; }
  // Content-free logging only — never log message text, handles, or the raw body.
  // The inbound/outbound split tells us whether Instagram is delivering echoes
  // (the owner's own native-app sends) at all.
  // Content-free health line: the inbound/outbound split confirms echoes (the
  // owner's own native-app sends) are flowing.
  if (events.length) {
    const ins = events.filter((e) => e.direction === 'in').length;
    console.log(`ig webhook: ${events.length} event(s) — ${ins} inbound, ${events.length - ins} outbound/echo`);
  }
  for (const ev of events) {
    // Per-event isolation: one bad event must never abort the rest of the batch
    // (Meta won't redeliver after our immediate 200).
    try {
      // GUARD 2 — never treat the business account itself as a lead. If leadId is
      // the connected IG account, this is a self-referential event (a self-DM /
      // owner echo mis-resolved); the AI once answered JD's own typed text as if a
      // lead (atunrolaaluko, mangoboymangoman). Skip it entirely.
      if (process.env.IG_BUSINESS_ID && String(ev.leadId) === String(process.env.IG_BUSINESS_ID)) {
        console.log('[webhook] ignored self-referential event');
        continue;
      }
      // Dedup: skip our OWN sends echoing back (mid pre-stored by deliver) + retries.
      if (ev.mid && db.prepare('SELECT 1 FROM messages WHERE mid = ?').get(ev.mid)) continue;
      // The lead is the OTHER party in both directions — leadId already resolved it.
      let conv = db.prepare("SELECT * FROM conversations WHERE channel = 'instagram' AND external_id = ?").get(ev.leadId);
      if (!conv) {
        // Create SYNCHRONOUSLY (no await before the insert) so two near-simultaneous
        // webhooks for the same lead can't each create a duplicate conversation.
        conv = createConversation({ channel: 'instagram', external_id: ev.leadId, handle: ev.leadId });
        igProfile(ev.leadId).then((prof) => {
          if (prof && (prof.username || prof.name)) {
            db.prepare('UPDATE conversations SET handle = COALESCE(?, handle), display_name = COALESCE(?, display_name) WHERE id = ?')
              .run(prof.username || null, prof.name || null, conv.id);
          }
        }).catch(() => {});
      }
      // Persist text + attachments (images inline; voice notes downloaded + transcribed).
      await ingestMessage(conv, ev);
      if (ev.direction === 'out') {
        if ((inFlightSends.get(String(ev.leadId)) || 0) > Date.now()) {
          // Echo of OUR OWN in-flight AI send that beat the Send API response:
          // correct its source and leave the autopilot counter alone.
          if (ev.mid) db.prepare("UPDATE messages SET source = 'ai' WHERE mid = ? AND source = 'human'").run(ev.mid);
        } else {
          // Owner replied from the IG app → reset the guardrail, don't run the AI turn.
          db.prepare('UPDATE conversations SET consecutive_ai_sends = 0 WHERE id = ?').run(conv.id);
        }
      } else {
        onLeadMessage(conv.id);
        await maybeFireVoiceNote(conv, ev.text); // Audio Arsenal: the LEAD's keyword can fire a voice note too
        scheduler.onInboundLead(conv.id); // autopilot/copilot turn (mode-aware)
      }
    } catch (e) { console.error('ig webhook event error:', e.message); }
  }
});

// ---------- calendly booking webhook (dormant until subscribed) ----------
/**
 * Verify Calendly's HMAC-SHA256 webhook signature. Header format:
 *   Calendly-Webhook-Signature: t=<unix_ts>,v1=<hex>
 * The signed payload is `<t>.<rawBody>` keyed by the stored signing_key. When no
 * signing key is stored (the webhook was created manually in the Calendly UI, not
 * via /api/calendly/webhook-setup), we accept but LOG once — there's nothing to
 * verify against. Returns true (accept) / false (reject 401).
 */
let _calendlyUnsignedLogged = false;
function verifyCalendlySignature(req) {
  const key = getSetting('calendly_signing_key') || '';
  if (!key) {
    // Same stance as Instagram: accept but warn until "Connect booking sync"
    // stores a signing key, so an existing Calendly subscription keeps working.
    if (!_calendlyUnsignedLogged) { console.warn('[calendly] no signing key stored — accepting UNVERIFIED webhooks (run "Connect booking sync" in Settings to subscribe with a signing key)'); _calendlyUnsignedLogged = true; }
    return true;
  }
  const header = String(req.headers['calendly-webhook-signature'] || '');
  const parts = Object.fromEntries(header.split(',').map((p) => { const i = p.indexOf('='); return [p.slice(0, i).trim(), p.slice(i + 1).trim()]; }));
  const ts = parts.t, v1 = parts.v1;
  if (!ts || !v1) return false;
  // Replay guard: the signed timestamp must be within 5 minutes of now.
  if (!/^\d+$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const signed = `${ts}.${(req.rawBody || Buffer.alloc(0)).toString('utf8')}`;
  const expected = crypto.createHmac('sha256', key).update(signed).digest('hex');
  try {
    const a = Buffer.from(v1), b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

/** Find an instagram conversation by handle (case-insensitive, '@'/whitespace stripped). */
function convByHandle(handle) {
  const norm = String(handle || '').replace(/\s+/g, '').replace(/^@+/, '').toLowerCase();
  if (!norm) return null;
  return db.prepare("SELECT * FROM conversations WHERE channel = 'instagram' AND lower(handle) = ?").get(norm) || null;
}
/** Find a conversation by exact case-insensitive display_name. */
function convByName(name) {
  const norm = String(name || '').trim().toLowerCase();
  if (!norm) return null;
  return db.prepare('SELECT * FROM conversations WHERE lower(display_name) = ? ORDER BY last_message_at DESC NULLS LAST LIMIT 1').get(norm) || null;
}
/**
 * Match a Calendly booking to an existing conversation, in order:
 *  (a) a Q&A answer whose QUESTION mentions instagram/@/ig handle → strip + match handle
 *  (b) exact case-insensitive invitee name vs display_name
 *  (c) no match → null (caller notifies; we never create a conversation)
 */
function matchBooking({ name, qAndA }) {
  for (const qa of Array.isArray(qAndA) ? qAndA : []) {
    if (/instagram|@|ig handle/i.test(String(qa?.question || ''))) {
      const hit = convByHandle(qa?.answer);
      if (hit) return hit;
    }
  }
  return convByName(name);
}

/**
 * Fire the Call Booked VSL once per conversation after a booking is matched.
 * Empty setting → skip. Still has the [VSL LINK] placeholder → park a manual
 * draft + notify (never send a broken link). Already sent (vsl_sent_at set) →
 * skip. Else deliver as an AI message and stamp vsl_sent_at on success.
 */
async function fireCallBookedVsl(conv) {
  const vsl = String(getSetting('call_booked_vsl') || '').trim();
  if (!vsl) return;
  if (vsl.includes('[VSL LINK]')) {
    storeDraft(conv.id, [vsl], null, false, 'VSL has placeholder link — fix in AI Script');
    notify('VSL not sent — placeholder link', `${conv.handle}: the Call Booked VSL still contains [VSL LINK]. Fix it in AI Script.`).catch(() => {});
    return;
  }
  if (getConv(conv.id)?.vsl_sent_at) return; // once per conversation
  try {
    const out = await deliver(conv, vsl, 'ai');
    if (out && out.ok) {
      db.prepare('UPDATE conversations SET vsl_sent_at = ? WHERE id = ?').run(nowIso(), conv.id);
    }
  } catch (e) { console.error('[calendly] VSL send failed:', e.message); }
}

app.post('/webhook/calendly', (req, res) => {
  if (!verifyCalendlySignature(req)) return res.sendStatus(401); // reject forged/spoofed events
  res.sendStatus(200); // ack fast, then do the work (like the IG webhook)
  (async () => {
    try {
      const body = req.body || {};
      const event = body.event;
      const payload = body.payload || {};
      if (event === 'invitee.created') {
        const startTime = toIso(payload?.scheduled_event?.start_time);
        const name = payload?.name || '';
        const qAndA = payload?.questions_and_answers || [];
        const conv = matchBooking({ name, qAndA });
        if (!conv) {
          notify('Booking could not be matched', `A Calendly booking came in for "${name || 'unknown'}" but no conversation matched by IG handle or name.`).catch(() => {});
          console.warn('[calendly] invitee.created: no conversation match for', name || '(no name)');
          return;
        }
        if (startTime) db.prepare('UPDATE conversations SET call_time = ? WHERE id = ?').run(startTime, conv.id);
        setStage(conv.id, 'call_booked'); // fires the 'Call booked 🎉' notify on the transition
        await fireCallBookedVsl(getConv(conv.id));
      } else if (event === 'invitee.canceled') {
        const name = payload?.name || '';
        const qAndA = payload?.questions_and_answers || [];
        const conv = matchBooking({ name, qAndA });
        if (!conv) {
          console.warn('[calendly] invitee.canceled: no conversation match for', name || '(no name)');
          return;
        }
        db.prepare('UPDATE conversations SET call_time = NULL, reminders_sent = NULL WHERE id = ?').run(conv.id);
        setStage(conv.id, 'booking_sent'); // back a step — owner re-books / follow-up sequence resumes
        notify('Call canceled', `${conv.handle} canceled their booked call.`).catch(() => {});
      }
    } catch (e) { console.error('[calendly] webhook error:', e.message); }
  })();
});

/**
 * One-time repair: Instagram conversations whose handle never resolved to a
 * username were stored with handle === external_id (the raw IGSID). Re-fetch
 * the profile and update them. Idempotent — only touches unresolved rows, so
 * once a row has a real username it is skipped on future boots.
 */
async function backfillInstagramHandles() {
  if (!igConfigured()) return;
  const rows = db.prepare("SELECT id, external_id FROM conversations WHERE channel = 'instagram' AND external_id IS NOT NULL AND handle = external_id").all();
  if (!rows.length) return;
  let fixed = 0;
  for (const r of rows) {
    const prof = await igProfile(r.external_id);
    if (prof?.username) {
      db.prepare('UPDATE conversations SET handle = ?, display_name = ? WHERE id = ?')
        .run(prof.username, prof.name || null, r.id);
      fixed++;
    }
  }
  console.log(`handle backfill: ${fixed}/${rows.length} instagram conversation(s) resolved`);
}

scheduler.start(); // Phase 4: begin the follow-up sweep

// FEATURE 4: nightly SQLite backup (VACUUM INTO → <DATA_DIR>/backups/, keep 7).
// Run once on boot, then every 24h. Wrapped so a backup failure never crashes.
function nightlyBackup() {
  try { console.log('[backup] ok ' + runBackup(db, DATA_DIR)); }
  catch (e) { console.error('[backup] failed ' + e.message); }
}
nightlyBackup();
const backupTimer = setInterval(nightlyBackup, 24 * 60 * 60 * 1000);
if (backupTimer.unref) backupTimer.unref(); // don't keep the process alive for a backup

app.listen(PORT, () => {
  console.log(`dmSetter on http://localhost:${PORT} (AI ${process.env.ANTHROPIC_API_KEY ? 'ready' : 'OFF'}, instagram ${igConfigured() ? 'CONNECTED' : 'dormant'}, timers ${process.env.FAST_TIMERS === '1' ? 'FAST' : 'real'})`);
  backfillInstagramHandles().catch((e) => console.log('handle backfill error:', e.message));
});

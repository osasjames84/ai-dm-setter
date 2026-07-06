import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { PERSONAS, PERSONA_BY_ID } from './lib/personas.js';
import { igConfigured, igVerifyWebhook, igParseInbound, igSendText, igProfile, igStatus } from './lib/instagram.js';
import { generateMove, applyOutboundFilter } from './lib/engine.js';
import { createScheduler } from './lib/scheduler.js';

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
const db = new DatabaseSync(path.join(DATA_DIR, 'dmsetter.sqlite'));
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
    followup_count INTEGER NOT NULL DEFAULT 0,        -- 0,1,2 then → dead
    next_followup_at TEXT,
    needs_human INTEGER NOT NULL DEFAULT 0,
    needs_human_reason TEXT,
    false_positive INTEGER NOT NULL DEFAULT 0,        -- call_booked but later found unqualified
    persona TEXT,                          -- sim persona id (Phase 4 drives replies)
    last_lead_message_at TEXT,
    last_message_at TEXT,
    created_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_conv_stage ON conversations(stage);
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,                    -- 'lead' | 'setter'
    text TEXT NOT NULL,
    source TEXT NOT NULL,                  -- 'ai' | 'human' | 'followup'
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

// ---------- settings ----------
const SETTING_DEFAULTS = {
  // Five editable prompt sections. NEUTRAL placeholders only — the owner pastes
  // his own business context; no doctrine is baked in code. Phase 2's engine
  // composes the system prompt from these at runtime.
  prompt_offer: 'Describe your offer, who it serves, and your positioning.',
  prompt_qualification: 'Describe how a lead should be qualified, step by step.',
  prompt_routing: 'Describe routing rules: who gets booked, who gets sent to community/guide, links to use.',
  prompt_voice: 'Describe how you text: tone, length, punctuation, emoji habits.',
  prompt_hard_rules: 'List things the AI must NEVER do, one per line.',
  coach_name: '',
  default_mode: 'copilot',
  kill_switch: '0',
  followup_1_hours: '4',
  followup_2_hours: '23',
  call_slots: '',
  guide_link: '',
  community_link: '',
  // Universal outbound guardrail (regex source strings, JSON array). Default
  // blocks a currency symbol adjacent to digits in either order.
  outbound_filter_regexes: JSON.stringify(['[£$€]\\s*\\d', '\\d\\s*[£$€]']),
};
const getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? null;
const setSetting = (k, v) => db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, String(v));
for (const [k, v] of Object.entries(SETTING_DEFAULTS)) {
  if (getSetting(k) == null) setSetting(k, v);
}
const allSettings = () =>
  Object.fromEntries(Object.keys(SETTING_DEFAULTS).map((k) => [k, getSetting(k)]));

// ---------- app ----------
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const nowIso = () => new Date().toISOString();
const newId = () => crypto.randomBytes(9).toString('hex');
const parseJ = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

function requireAdmin(req, res, next) {
  if (String(req.headers['x-admin-pin'] || '') !== ADMIN_PIN) {
    return res.status(401).json({ error: 'Wrong PIN' });
  }
  next();
}

// ---------- helpers ----------
const getConv = (id) => db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
const historyOf = (convId) =>
  db.prepare('SELECT role, text, source, created_at FROM messages WHERE conversation_id = ? ORDER BY id').all(convId);

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

function addMessage(convId, role, text, source) {
  const at = nowIso();
  db.prepare('INSERT INTO messages (conversation_id, role, text, source, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(convId, role, text, source, at);
  db.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(at, convId);
}

/**
 * Move to a stage + record first-reach timestamps (idempotent per stage).
 * Funnel semantics: reaching a funnel stage means the lead passed through every
 * earlier one, so skipped stages are backfilled — "reached" totals stay
 * monotonically decreasing down the funnel and conversions never exceed 100%.
 */
function setStage(convId, stage) {
  if (!STAGES.includes(stage)) return;
  db.prepare('UPDATE conversations SET stage = ? WHERE id = ?').run(stage, convId);
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
async function deliver(conv, text, source) {
  const filtered = applyOutboundFilter(text, parseJ(getSetting('outbound_filter_regexes'), []));
  if (!filtered.ok) {
    db.prepare('UPDATE conversations SET needs_human = 1, needs_human_reason = ? WHERE id = ?')
      .run(filtered.reason || 'outbound_filter', conv.id);
    return { ok: false, reason: filtered.reason || 'outbound_filter' };
  }
  if (conv.channel === 'instagram' && igConfigured() && conv.external_id) {
    await igSendText(conv.external_id, filtered.text);
  }
  // sim channel: delivery is just persistence (the persona reply is scheduled below).
  addMessage(conv.id, 'setter', filtered.text, source);
  if (conv.channel === 'sim' && conv.persona) scheduler.onSetterDelivered(conv.id);
  return { ok: true };
}

/** A lead just spoke: reset the AI-send guardrail + clear any queued follow-up. */
function onLeadMessage(convId) {
  const at = nowIso();
  db.prepare('UPDATE conversations SET consecutive_ai_sends = 0, next_followup_at = NULL, last_lead_message_at = ? WHERE id = ?')
    .run(at, convId);
}

/** Create an inbound conversation (webhook + sim share this). Stage 'lead', mode = default. */
function createConversation({ channel, external_id = null, handle, display_name = null, persona = null }) {
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
  db.prepare('UPDATE conversations SET needs_human = 1, needs_human_reason = ? WHERE id = ?')
    .run(String(reason || 'needs_human').slice(0, 300), convId);
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

/**
 * Conversations the follow-up sweep should consider: qualifying/qualified/
 * booking_sent, not flagged, mode != off. The sweep does the per-row timing +
 * last-message check. (lead/engaged get no follow-ups by design.)
 */
function followupCandidates() {
  return db.prepare(`SELECT * FROM conversations
    WHERE stage IN ('qualifying','qualified','booking_sent') AND needs_human = 0 AND mode != 'off'`).all();
}

// The scheduler owns all Phase 4 timers + self-play. It reaches the db only
// through these thin wrappers (never the schema directly), which keeps it
// decoupled and unit-testable.
const scheduler = createScheduler({
  getConv,
  getSettings: allSettings,
  historyOf,
  addLeadMessage,
  deliver,
  storeDraft,
  setStage,
  setMode,
  setNeedsHuman,
  incrementAiSends,
  setFollowup,
  onLeadMessage,
  latestLeadMessageId,
  followupCandidates,
  humanConfirmStages: HUMAN_CONFIRM_STAGES,
});

// ---------- auth / settings ----------
app.post('/api/auth', requireAdmin, (req, res) => res.json({ ok: true }));

app.get('/api/settings', requireAdmin, (req, res) => {
  res.json({
    settings: allSettings(),
    igConfigured: igConfigured(),
    aiReady: !!process.env.ANTHROPIC_API_KEY,
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
  const st = await igStatus();
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'your-domain';
  st.webhook_url = `${proto}://${host}/webhook/instagram`;
  st.subscription_field = 'messages';
  st.permissions = ['instagram_business_manage_messages', 'pages_manage_metadata'];
  res.json(st);
});

app.put('/api/settings', requireAdmin, (req, res) => {
  const body = req.body || {};
  for (const k of Object.keys(SETTING_DEFAULTS)) {
    if (body[k] == null) continue;
    let v = String(body[k]).slice(0, 20000);
    // Guard the two enum-ish settings so downstream never sees garbage.
    if (k === 'default_mode' && !MODES.includes(v)) continue;
    if (k === 'kill_switch') v = v === '1' || v === 'true' ? '1' : '0';
    setSetting(k, v);
  }
  res.json({ ok: true, settings: allSettings() });
});

// ---------- conversations ----------
app.get('/api/conversations', requireAdmin, (req, res) => {
  const stage = String(req.query.stage || '').trim();
  const q = String(req.query.q || '').trim().toLowerCase();
  let rows = db.prepare(`
    SELECT c.*,
      (SELECT text FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_text,
      EXISTS(SELECT 1 FROM drafts d WHERE d.conversation_id = c.id AND d.status = 'pending') AS pending_draft
    FROM conversations c
    ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC
    LIMIT 500`).all();
  if (stage && STAGES.includes(stage)) rows = rows.filter((r) => r.stage === stage);
  if (q) rows = rows.filter((r) =>
    r.handle.toLowerCase().includes(q) ||
    (r.display_name || '').toLowerCase().includes(q) ||
    (r.last_text || '').toLowerCase().includes(q));
  res.json(rows.map((r) => ({ ...shapeConv(r), pending_draft: !!r.pending_draft })));
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
    const move = await generateMove(allSettings(), conv, historyOf(conv.id));
    const messages = Array.isArray(move?.messages) && move.messages.length
      ? move.messages.slice(0, 2).map((m) => String(m)) : [''];
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
    const move = await generateMove(allSettings(), { handle: 'preview_lead', stage }, history);
    const regexes = parseJ(getSetting('outbound_filter_regexes'), []);
    const messages = (move.messages || []).map((text) => ({
      text,
      blocked: !applyOutboundFilter(text, regexes).ok,
    }));
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

// ---------- instagram webhook (dormant until configured) ----------
// GET is Meta's subscription handshake — it only needs the verify token, which
// the owner sets first (the page token/business id come later), so gate on that
// alone rather than full igConfigured() or verification would fail during setup.
app.get('/webhook/instagram', (req, res) => {
  if (!process.env.IG_VERIFY_TOKEN) return res.sendStatus(404);
  igVerifyWebhook(req, res);
});
app.post('/webhook/instagram', async (req, res) => {
  res.sendStatus(200);
  if (!igConfigured()) return;
  try {
    for (const ev of igParseInbound(req.body)) {
      let conv = db.prepare("SELECT * FROM conversations WHERE channel = 'instagram' AND external_id = ?").get(ev.senderId);
      if (!conv) {
        const prof = await igProfile(ev.senderId);
        conv = createConversation({
          channel: 'instagram',
          external_id: ev.senderId,
          handle: prof?.username || ev.senderId,
          display_name: prof?.name || null,
        });
      }
      addMessage(conv.id, 'lead', ev.text, 'human');
      onLeadMessage(conv.id);
      scheduler.onInboundLead(conv.id); // autopilot/copilot turn (mode-aware)
    }
  } catch (e) { console.error('ig webhook error:', e.message); }
});

scheduler.start(); // Phase 4: begin the follow-up sweep
app.listen(PORT, () => console.log(
  `AI DM SETTER on http://localhost:${PORT} (AI ${process.env.ANTHROPIC_API_KEY ? 'ready' : 'OFF'}, instagram ${igConfigured() ? 'CONNECTED' : 'dormant'}, timers ${process.env.FAST_TIMERS === '1' ? 'FAST' : 'real'})`
));

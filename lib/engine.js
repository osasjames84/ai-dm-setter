/**
 * The AI setter engine. One structured call per draft returns
 * { messages: [1-2 strings], stage, needs_human, reason, flag_reason_code }.
 *
 * NOTHING about how to sell, qualify, book, follow up, or talk is baked in
 * here. The entire approach comes from the owner's own prompt sections
 * (persona, offer, style, qualification, booking, routing, objections,
 * follow-ups, hard rules, custom). The engine only supplies the mechanics the
 * product needs to function: the structured output contract (1-2 bubbles + a
 * pipeline stage), the owner's resources / knowledge base / audio arsenal as
 * reference data, the owner's flag toggles, and the current date. The one
 * exception is VOICE: code-level guards against the stock reactions and
 * repeated openers that make every thread read like the same bot, plus the
 * thread's timeline (a chat reopened after months is not a new lead).
 */

import Anthropic from '@anthropic-ai/sdk';
import { parseProfile, profileNote } from './profile.js';
import { reportUsage } from './usage.js';

const MODEL = 'claude-sonnet-5';       // the actual sales conversation — tone + qualification logic
const FAST_MODEL = 'claude-haiku-4-5'; // cheap, high-frequency, low-stakes text tasks (e.g. rewording a follow-up)

// Keep in sync with server.js STAGES (server owns the pipeline; engine only
// needs the enum for the output schema).
const STAGES = ['lead', 'engaged', 'qualifying', 'qualified', 'booking_sent', 'call_booked', 'sale', 'routed', 'dead'];

// Lazily constructed: ESM hoists this module's evaluation ABOVE server.js's
// process.loadEnvFile(), so ANTHROPIC_API_KEY isn't set yet at import time.
let _client = null;
function client() {
  if (!_client && process.env.ANTHROPIC_API_KEY) {
    _client = new Anthropic({ maxRetries: 5, timeout: 90_000 });
  }
  return _client;
}

/** The shared Anthropic client (null when ANTHROPIC_API_KEY is unset). */
export function anthropicClient() { return client(); }

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    messages: {
      type: 'array',
      items: { type: 'string' },
      description: '1 or 2 DM messages, each sent as a separate bubble. Never more than 2.',
    },
    stage: {
      type: 'string',
      enum: STAGES,
      description: 'pipeline stage of this conversation AFTER your reply',
    },
    needs_human: {
      type: 'boolean',
      description: 'true when a human must review before anything is sent',
    },
    reason: {
      type: 'string',
      description: 'terse reason when needs_human is true, else empty string',
    },
    flag_reason_code: {
      type: 'string',
      enum: ['', 'underage', 'cant_afford', 'not_interested', 'wrong_fit', 'unqualified', 'cursing', 'disrespectful', 'language', 'generic', 'medical', 'other'],
      description: 'when needs_human is true because the lead is being flagged/disqualified, classify why; empty string when needs_human is false',
    },
  },
  required: ['messages', 'stage', 'needs_human', 'reason', 'flag_reason_code'],
  additionalProperties: false,
};

/** Safe JSON parse for a stringified setting, with a fallback. */
function parseSetting(v, fallback) {
  try { const x = JSON.parse(v); return x == null ? fallback : x; } catch { return fallback; }
}

/**
 * The owner-written prompt sections, in the order they are presented to the
 * model. Every one is optional; empty sections are omitted entirely (no
 * fallback text is ever injected). `prompt_voice` honors the legacy `style`
 * setting so older installs keep their texting rules.
 */
export const PROMPT_SECTIONS = [
  ['prompt_persona', 'CHARACTER & PERSONALITY'],
  ['about_you', 'ABOUT YOU'],
  ['prompt_offer', 'OFFER & CONTEXT'],
  ['client_results', 'CLIENT RESULTS (owner-provided — cite only these, exactly as written; never invent or alter a result)'],
  ['prompt_voice', 'TEXTING STYLE'],
  ['prompt_qualification', 'QUALIFICATION SEQUENCE'],
  ['prompt_booking', 'BOOKING SEQUENCE'],
  ['prompt_routing', 'ROUTING RULES'],
  ['prompt_objections', 'OBJECTION HANDLING'],
  ['prompt_hard_rules', 'HARD RULES (never break these)'],
  ['prompt_custom', 'CUSTOM INSTRUCTIONS'],
];

/** Value of a prompt section (with the legacy `style` → prompt_voice fallback). */
function sectionValue(s, key) {
  if (key === 'prompt_voice') return String(s.prompt_voice || s.style || '').trim();
  return String(s[key] || '').trim();
}

/** The owner's non-empty prompt sections, each clearly fenced. */
function ownerSections(s) {
  const out = [];
  for (const [key, title] of PROMPT_SECTIONS) {
    const body = sectionValue(s, key);
    if (!body) continue;
    out.push(`--- ${title} ---`, body, '');
  }
  return out;
}

/**
 * The owner's Audio Arsenal phrases, surfaced to the model so it can deliberately
 * trigger a voice note by using a phrase verbatim (the server fires the clip the
 * first time an outbound message contains it). Empty when no clips are set.
 */
function arsenalBlock(s) {
  const rows = parseSetting(s.audio_arsenal, []).filter((r) => r && String(r.phrase || '').trim() && String(r.audio_id || '').trim());
  if (!rows.length) return [];
  return ['== AUDIO ARSENAL (mechanics) ==',
    'The owner recorded voice notes tied to these phrases. The FIRST time one of your replies contains a phrase verbatim, the matching voice note is sent along with it; after that the lead just gets text. Use them only as the owner\'s instructions describe.',
    ...rows.map((r) => `- "${String(r.phrase).trim()}"`),
    ''];
}

/** The owner's structured objection handlers (trigger → reply), if any. */
function objectionOverrides(s) {
  const rows = parseSetting(s.objection_handlers, []).filter((r) => r && (r.trigger || r.reply));
  if (!rows.length) return [];
  return ['--- OBJECTION HANDLERS (owner-provided) ---',
    ...rows.map((r) => `- if they say something like "${String(r.trigger || '').trim()}" → answer in the spirit of: "${String(r.reply || '').trim()}"`),
    ''];
}

/** The owner's links and call slots — reference data only, no usage rules. */
function resourcesBlock(s) {
  const rows = [
    ['Bookable call slots', s.call_slots],
    ['Free guide link', s.guide_link],
    ['Community link', s.community_link],
  ].filter(([, v]) => String(v || '').trim());
  if (!rows.length) return [];
  return ['== OWNER RESOURCES (the only links and slots you have — use them as the owner\'s instructions describe; if something is not listed here, you do not have it) ==',
    ...rows.map(([l, v]) => `${l}: ${String(v).trim()}`),
    ''];
}

/** The owner's hard filters (Settings › Qualification Criteria) — facts only. */
function filtersBlock(s) {
  const lang = String(s.languages || '').trim();
  const age = String(s.min_age || '').trim();
  if (!lang && !age) return [];
  const lines = ['== OWNER FILTERS =='];
  if (age) lines.push(`- Minimum age: ${age}`);
  if (lang) lines.push(`- Language(s): ${lang}`);
  lines.push('How to handle a lead who does not meet a filter is defined by the owner\'s instructions above.', '');
  return lines;
}

/** Reason-code → short description, for the configurable flagging block. */
const FLAG_REASON_DESC = {
  underage: 'they are, or clearly appear to be, under the minimum age',
  language: "they can't or won't communicate in an allowed language",
  cant_afford: "they have no budget / genuinely can't afford it",
  not_interested: "they've made clear they're not interested",
  wrong_fit: 'not the right fit for this offer',
  unqualified: "they don't meet the owner's qualification criteria",
  cursing: 'cursing or abusive language toward you',
  disrespectful: 'hostile or disrespectful (non-cursing)',
  medical: 'a serious health, mental-health, or safety situation',
  other: 'engine/system fallback — never offered to the model as a scenario',
  generic: 'a soft or vague ending with no strong single reason',
};
/** Codes the owner can toggle in the dashboard flag grid — the ONLY codes the
 *  flagging block ever presents as scenarios. Nothing flags unless the owner
 *  turned it on. 'other' is reserved for engine errors and manual flags. */
const TOGGLEABLE_FLAGS = ['underage', 'cant_afford', 'not_interested', 'wrong_fit', 'unqualified', 'cursing', 'disrespectful', 'language', 'generic', 'medical'];
/** The owner's enabled flag toggles, restricted to real toggleable codes. */
function enabledFlags(s) {
  let enabled; try { enabled = JSON.parse(s.flag_enabled || '{}'); } catch { enabled = {}; }
  if (!enabled || typeof enabled !== 'object') enabled = {};
  return TOGGLEABLE_FLAGS.filter((k) => enabled[k]);
}

/**
 * When to set needs_human — the owner's flag_enabled toggles, and nothing else.
 * Flagging pauses the AI on that thread until the owner reviews it.
 */
function flaggingBlock(s) {
  const on = enabledFlags(s);
  const lines = ['== WHEN TO FLAG FOR A HUMAN (needs_human) =='];
  lines.push('Flagging pauses the AI on this thread until the owner reviews it.');
  if (on.length) {
    lines.push('The owner enabled these scenarios — this list is exhaustive:');
    for (const k of on) lines.push(`- ${k} — ${FLAG_REASON_DESC[k]}`);
    lines.push('Set needs_human = true, the matching flag_reason_code, and a terse reason ONLY when one of these applies. For anything else, needs_human = false and flag_reason_code = "".');
    lines.push('When you do flag, still return the message(s) the owner\'s instructions call for in that situation — a human decides whether to send them.');
  } else {
    lines.push('The owner has not enabled any flag scenarios: needs_human = false and flag_reason_code = "" on every reply.');
  }
  return lines;
}

/** Reactions that make every reply read like the same bot; a reply opening with one is regenerated once. */
export const STOCK_REACTIONS = ["that's real", "that's fair", "that's all right", "that's alright", 'love that', 'i hear you', 'makes sense', 'totally get it', 'totally get that', 'i get that', 'respect that', 'fair enough', 'haha fair enough', "that's valid", "that's huge", 'solid', 'nice one', 'bet', 'got it', 'sweet', 'appreciate that', 'real talk'];
/** The scripted "couple of questions to see if it's a good fit, sound good?" ask: never right in a chat we reopened. */
const PERMISSION_ASK = /\b(couple|few)( of)?( quick)? (questions|things|qs)\b|\bgood fit\b/i;

const normPhrase = (t) => String(t || '').toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
/** Sentences of a message, normalized ("That's real." → "that's real"). */
const sentencesOf = (t) => String(t || '').split(/[.!?\n]+/).map(normPhrase).filter((x) => x && x.split(' ').length <= 14);
/** First sentence/clause of a message: what the lead reads first. */
export const openerOf = (t) => normPhrase(String(t || '').split(/[.!?,\n]+/).find((x) => x.trim()) || '');

/**
 * Sentences and openers repeated across many AI messages (account-wide), most
 * repeated first. These are what make the setter "say the same thing every time".
 */
export function repeatedPhrases(texts, { min = 3, max = 12 } = {}) {
  const counts = new Map();
  for (const t of texts) {
    for (const p of new Set([...sentencesOf(t), openerOf(t)].filter((x) => x.split(' ').length >= 2))) counts.set(p, (counts.get(p) || 0) + 1);
  }
  return [...counts].filter(([, n]) => n >= min).sort((a, b) => b[1] - a[1]).slice(0, max).map(([p]) => p);
}

/** True when a reply opens with a stock reaction or one of the given phrases. */
export function opensWithAny(text, phrases) {
  const first = sentencesOf(text)[0] || '';
  const opener = openerOf(text);
  return phrases.some((p) => { const n = normPhrase(p); return n && (first === n || opener === n || first.startsWith(n + ' ')); });
}

/** Stages at which sending the booking link is expected. */
const LINK_READY_STAGES = new Set(['qualifying', 'qualified', 'booking_sent', 'call_booked', 'sale']);
/** True when a reply carries the owner's booking link, any Calendly link, or offers call times. */
export function sendsBookingLink(messages, settings = {}) {
  const links = [settings.calendar_link, settings.next_step_link].map((l) => String(l || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')).filter(Boolean);
  return messages.some((m) => links.some((l) => String(m).includes(l)) || /calendly\.com\//i.test(m));
}
/** True when the lead's latest messages ask for the link, a call or a time. */
export function leadAskedToBook(history) {
  const recent = [];
  for (let i = history.length - 1; i >= 0 && history[i].role === 'lead'; i--) recent.push(String(history[i].text || ''));
  return recent.some((t) => /\b(link|book(ing)?|calendly|what times?|when (are|r) you free|set (it|that|one) up)\b|\b(hop|jump|get) on (a |the |another )?call\b|\b(can|could) we (do|have|get|book) (a |the )?call\b|\bdown for (a |the )?call\b|\b(a |the )?call (sounds good|works)\b/i.test(t));
}

const WEEK = 7 * 86400_000;
/**
 * Timeline facts the model can't see from bare text: a thread that went quiet
 * for weeks and was reopened by the owner's own message is a check-in being
 * answered, not a new lead. Returns '' when there is nothing to say.
 */
export function timelineNote(history, now = Date.now()) {
  const h = history.filter((m) => m && m.created_at);
  if (!h.length) return '';
  let lastLead = -1;
  for (let i = h.length - 1; i >= 0; i--) if (h[i].role === 'lead') { lastLead = i; break; }
  if (lastLead < 0) return '';
  // Walk back over the setter run that the lead is answering.
  let start = lastLead;
  while (start > 0 && h[start - 1].role === 'lead') start--;
  let runStart = start;
  while (runStart > 0 && h[runStart - 1].role === 'setter') runStart--;
  if (runStart === start) return ''; // the lead is not answering a message of ours
  const opener = h[runStart];
  const prev = runStart > 0 ? h[runStart - 1] : null;
  const gap = prev ? Date.parse(opener.created_at) - Date.parse(prev.created_at) : null;
  const fmt = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const quote = '"' + String(opener.text || '').slice(0, 300) + '"';
  if (prev && gap >= 2 * WEEK) {
    return `Timeline: this chat went quiet after ${fmt(prev.created_at)} (about ${Math.round(gap / WEEK)} weeks). It was reopened on ${fmt(opener.created_at)} by your message ${quote}. Their latest message answers that check-in. They already know you: no intro and no asking permission to ask questions. Pick up from what you asked them, and if they are still stuck, find out what has happened since and how it has been for them before anything else.`;
  }
  if (!prev) {
    return `Timeline: you opened this chat yourself on ${fmt(opener.created_at)} with ${quote}. Their latest message answers that. Pick up from what you asked them; do not reply as if they messaged you out of the blue, and do not ask permission to ask questions. If they say they are stuck or struggling, dig into that (what happened, since when, how it has felt) before anything else.`;
  }
  return '';
}

export function buildSystemPrompt(s) {
  const coachName = String(s.coach_name || '').trim();
  const sections = ownerSections(s);
  const lines = [
    `You are replying to direct messages (Instagram DMs or Facebook Messenger) for this account. Who you are, how you talk, and how you handle every conversation are defined entirely by the OWNER INSTRUCTIONS below. Follow them as written. Do not add any sales approach, script, sequence, persuasion technique, or personality trait the owner has not described. Where the instructions are silent, use plain good judgement and stay consistent with what the owner did write.`,
    ...(coachName ? [`You text as ${coachName}.`] : []),
    `Ground every time reference (years, "this year", seasons) in the current date given in the system note.`,
    '',
    '== OWNER INSTRUCTIONS ==',
    ...(sections.length ? sections : ['(The owner has not written any instructions yet. Reply briefly and neutrally.)', '']),
    ...objectionOverrides(s),
    ...resourcesBlock(s),
    ...(String(s.knowledge_text || '').trim()
      ? ['== KNOWLEDGE BASE (owner-uploaded reference material — use it to answer accurately) ==', String(s.knowledge_text).trim(), '']
      : []),
    ...arsenalBlock(s),
    ...filtersBlock(s),
    '== OUTPUT CONTRACT (mechanics) ==',
    '- Return 1 or 2 messages; each is sent as its own DM bubble. Length, tone, and format come from the owner\'s instructions.',
    '- Report the pipeline stage the conversation is in AFTER your reply. Stages: lead (no meaningful exchange yet) → engaged (they have replied meaningfully) → qualifying (you are learning about them) → qualified (they fit, by the owner\'s criteria) → booking_sent (a call or booking has been proposed) → call_booked (a concrete booking is agreed or confirmed) | routed (sent to a resource instead of a call) | dead (they explicitly said no or asked you to stop). "sale" is set by a human only — never report it.',
    '- What each stage requires is defined by the owner\'s instructions. When unsure, keep the current stage.',
    ...(String(s.end_on_question ?? '1') !== '0' ? [
      '- A live turn is never a reaction alone. Unless the stage after your reply is call_booked, routed or dead, or the owner\'s instructions say to leave it there, your LAST bubble must end with a question or hand the lead a concrete next step (a link, a time to pick). Never end on "all clear", "say less", "sounds good" or any closed statement.',
    ] : []),
    '',
    '== VOICE (mechanics) ==',
    '- Text like a real person, not a script. Respond to what they actually said, in plain words. If they opened up about a struggle or how they feel, stay on it: your question goes deeper into that (why, since when, what it has cost them, how it has felt), not on to the next item on a list.',
    '- Never open with a stock reaction such as ' + STOCK_REACTIONS.map((x) => '"' + x + '"').join(', ') + '. Either react to the specific thing they said or skip the reaction and just reply.',
    '- No generic truisms that could be sent to anyone ("the last few kg are always the hardest", "consistency is key", "that is the hardest part"). Say things that are only true of this person.',
    '- Never reuse an opening line you have already sent, in this chat or across chats. The system note lists the ones to avoid.',
    '',
    ...flaggingBlock(s),
  ];
  return lines.join('\n');
}

/**
 * Directive appended to the system-note turn when the engine is generating a
 * scheduled follow-up (the lead went quiet). The content of the follow-up is
 * the owner's `prompt_followup` section; nothing else is prescribed.
 */
function followupDirective(n, s) {
  const own = String((s && s.prompt_followup) || '').trim();
  return [
    `[FOLLOW-UP #${n} — the lead has not replied since your last message. This is a scheduled follow-up, not a reply to something they said.]`,
    own || 'Write the follow-up message the owner\'s instructions call for.',
    'Do not send a message identical to one already in this conversation.',
  ].join('\n');
}

/**
 * Produce the setter's next move for a conversation.
 * Contract (stable across phases):
 *   returns { messages: string[1..2], stage: <stage>, needs_human: bool, reason: string }
 *
 * @param {object} settings   flattened settings map (allSettings())
 * @param {object} conversation  the conversation row
 * @param {Array<{role:'lead'|'setter', text:string}>} history  oldest→newest
 * @param {{followup?: number}} [options]  when followup is set (1-based), append a follow-up directive
 */
/**
 * Reword ONE short follow-up so it doesn't read as copy-pasted across leads
 * (the "Variation" toggle). Same meaning + ask, casual DM voice, links/@handles/
 * {{FIRST_NAME}} kept verbatim. Falls back to the original on any error.
 */
export async function varyMessage(text) {
  const c = client();
  const t = String(text || '').trim();
  if (!c || !t) return t;
  try {
    const res = await c.messages.create({
      model: FAST_MODEL,
      max_tokens: 400,
      // Not prompt-cached: this system string is well under Haiku's 2048-token
      // cacheable minimum (Sonnet's is 1024), so a cache_control breakpoint would
      // never write a cache entry — it'd only add overhead. Left as a plain string.
      system: 'You reword ONE short Instagram DM so it does not look copy-pasted when sent to many people. Keep the EXACT same meaning, ask, tone, register, casing, and emoji use as the original; keep any link, @handle, or {{FIRST_NAME}} token verbatim. No new information, roughly the same length. Reply with ONLY the reworded message — no quotes, no preamble.',
      messages: [{ role: 'user', content: t }],
    });
    reportUsage(FAST_MODEL, res);
    const out = (res.content.find((b) => b.type === 'text')?.text || '').trim();
    return out || t;
  } catch { return t; }
}

export async function generateMove(settings, conversation, history, options = {}) {
  const c = client();
  if (!c) {
    return { messages: [], stage: conversation.stage, needs_human: true, reason: 'ai_not_configured', flag_reason_code: 'other' };
  }

  // History cap: some synced threads run 75+ messages — mapping them all wastes
  // tokens and pollutes context. Keep only the last 40 turns; the SYSTEM NOTE
  // below tells the model how many older messages were dropped so it doesn't
  // treat the thread as brand-new. The slice may begin on a setter message, but
  // the role-'user'-first invariant is still enforced by the unshift below.
  const HISTORY_CAP = 40;
  const omitted = history.length > HISTORY_CAP ? history.length - HISTORY_CAP : 0;
  const kept = omitted ? history.slice(-HISTORY_CAP) : history;
  const msgs = kept.map((m) => ({
    role: m.role === 'lead' ? 'user' : 'assistant',
    content: m.text,
  }));
  // First message must be role 'user' (setter may have opened the thread, or the
  // capped slice may start on a setter message).
  if (!msgs.length || msgs[0].role !== 'user') {
    msgs.unshift({ role: 'user', content: '[conversation start — the lead has not messaged yet]' });
  }
  // The SYSTEM NOTE carries the per-turn VOLATILE pieces that must stay OUT of the
  // cached system prompt: the current date, live Calendly availability, and the
  // history-omitted count. Same date/calendly wording as before so behavior is
  // preserved; they simply live here now instead of buildSystemPrompt.
  const note = [
    `[SYSTEM NOTE — not from the lead]`,
    `Lead handle: @${conversation.handle}. Current pipeline stage: ${conversation.stage}.`,
    `Today's date is ${new Date().toDateString()}. Ground every time reference (years, "this year", "last year", seasons) in this — never assume a different current year.`,
  ];
  if (omitted) {
    note.push(`Earlier history omitted: this conversation has ${omitted} older messages not shown.`);
  }
  // Per-lead profile (E.9): what the lead already told us, kept across the history cap.
  const pn = profileNote(parseProfile(conversation.profile_json));
  if (pn) note.push(pn);
  const tl = timelineNote(history);
  if (tl) note.push(tl);
  // Openers already sent in this thread, plus phrases repeated across the account.
  const usedHere = [...new Set(history.filter((m) => m.role === 'setter' && m.source !== 'human').map((m) => openerOf(m.text)).filter((x) => x.split(' ').length >= 2))].slice(-8);
  const overused = Array.isArray(settings.overused_phrases) ? settings.overused_phrases : [];
  if (usedHere.length) note.push('Openers you already used in this chat (do not start with these again): ' + usedHere.map((x) => '"' + x + '"').join(', ') + '.');
  if (overused.length) note.push('Phrases you keep repeating across chats (they make you sound like a bot, do not use them or close variants): ' + overused.map((x) => '"' + x + '"').join(', ') + '.');
  const avoid = [...STOCK_REACTIONS, ...usedHere, ...overused];
  if (String(settings.calendly_slots || '').trim()) {
    note.push(String(settings.calendly_slots).trim());
  }
  if (Number(options.followup) >= 1) {
    note.push(followupDirective(Number(options.followup), settings));
  } else {
    note.push(`Reply with your next move.`);
  }
  msgs.push({ role: 'user', content: note.join('\n') });

  // max_tokens 8000: adaptive thinking SHARES this budget on claude-sonnet-5 — at
  // the old 3000 a long-thinking turn truncated the JSON mid-object (observed live:
  // "engine_error: unparseable model output" flags; same failure the content engine
  // hit and fixed). SELF-HEAL before ever flagging: a truncated, unparseable, or
  // EMPTY-messages result (observed live: "engine_error: no message produced"
  // parked a hot lead mid-objection) retries ONCE with a corrective note — the
  // system prompt is cache-hit so the retry is cheap. Flag only if both attempts
  // produce nothing sendable: at that point parking is the only honest option
  // (silently dropping the lead would be worse — that's the ghosting we killed).
  const normalizeBubbles = (o) => (Array.isArray(o?.messages) ? o.messages : [])
    .map((m) => String(m).replace(/\n\s*\n+/g, '\n').trim())
    .filter(Boolean)
    .slice(0, 2); // output contract: at most 2 bubbles, no blank-line paragraphs
  let raw = '';
  let out = null;
  let messages = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    // Prompt caching (GA — no beta header): the system prompt is ~3-5k tokens and
    // is resent on every generateMove call. A single ephemeral cache breakpoint on
    // it means every call after the first (within the 5-min TTL) reads it at ~0.1x
    // input cost instead of full price. It only busts when the OWNER edits settings
    // (a real change) — all time-varying content was moved to the SYSTEM NOTE above.
    const attemptMsgs = attempt === 0 ? msgs : [...msgs,
      { role: 'assistant', content: raw || '{}' },
      { role: 'user', content: '[SYSTEM CHECK — not from the lead] Your previous output was invalid or contained no messages. Return 1-2 DM messages that follow the owner\'s instructions. Same JSON format.' }];
    const res = await c.messages.create({
      model: MODEL,
      max_tokens: 8000,
      system: [{ type: 'text', text: buildSystemPrompt(settings), cache_control: { type: 'ephemeral' } }],
      messages: attemptMsgs,
      output_config: { format: { type: 'json_schema', schema: RESPONSE_SCHEMA } },
    });
    reportUsage(MODEL, res);
    raw = res.content.find((b) => b.type === 'text')?.text || '';
    out = null;
    if (res.stop_reason !== 'max_tokens') {
      try { out = JSON.parse(raw); } catch { /* unparseable — maybe retry */ }
    }
    messages = normalizeBubbles(out);
    if (messages.length) break;
    if (attempt === 0) console.log('[engine] truncated/unparseable/empty move output — retrying once');
  }
  if (!out) {
    return { messages: [], stage: conversation.stage, needs_human: true, reason: 'engine_error: unparseable model output', flag_reason_code: 'other' };
  }
  if (!messages.length) {
    return { messages: [], stage: conversation.stage, needs_human: true, reason: String(out.reason || 'engine_error: no message produced').slice(0, 300).replace(/[\s"'}\],]+$/, ''), flag_reason_code: 'other' };
  }

  // REPETITION BACKSTOP: a reply that opens with a stock reaction, an opener
  // already used in this chat, or a phrase the account keeps repeating is
  // regenerated once. If the retry still repeats, send it rather than stall.
  const reopened = !!tl && !options.followup;
  const robotic = (list) => opensWithAny(list[0], avoid) || (reopened && list.some((m) => PERMISSION_ASK.test(m)));
  if (!out.needs_human && robotic(messages)) {
    try {
      const resR = await c.messages.create({
        model: MODEL, max_tokens: 8000,
        system: [{ type: 'text', text: buildSystemPrompt(settings), cache_control: { type: 'ephemeral' } }],
        messages: [...msgs, { role: 'assistant', content: raw }, { role: 'user', content: '[SYSTEM CHECK — not from the lead] ' + (opensWithAny(messages[0], avoid) ? 'Your reply opens with a stock or repeated line ("' + (sentencesOf(messages[0])[0] || openerOf(messages[0])) + '"). ' : 'Your reply asks permission to ask qualifying questions in a chat you reopened yourself. ') + 'That is what makes you sound like a bot. Rewrite it the way a real person would text this lead: respond to the specific thing they said, and if they are stuck, ask about that. Same JSON format.' }],
        output_config: { format: { type: 'json_schema', schema: RESPONSE_SCHEMA } },
      });
      reportUsage(MODEL, resR);
      const rawR = resR.content.find((b) => b.type === 'text')?.text || '';
      let outR = null;
      if (resR.stop_reason !== 'max_tokens') { try { outR = JSON.parse(rawR); } catch { /* keep the first */ } }
      const mR = normalizeBubbles(outR);
      if (mR.length) { console.log('[repeat-backstop] reply re-generated without the stock/repeated opener'); out = outR; messages = mR; raw = rawR; }
    } catch (e) { console.log('[repeat-backstop] retry failed: ' + e.message); }
  }

  // EARLY-LINK BACKSTOP: the booking link (or call times) going to a lead who has
  // never been through qualifying is regenerated once without it. Owner's call
  // (2026-10-23): a past-call lead who said "I know what to do, I just need a
  // plan" got the link with no qualifiers. Allowed when the thread is already at
  // qualifying or later, or when the lead asked for the link or a call.
  if (!out.needs_human && !options.followup && sendsBookingLink(messages, settings)
      && !LINK_READY_STAGES.has(conversation.stage) && !leadAskedToBook(history)) {
    try {
      const resL = await c.messages.create({
        model: MODEL, max_tokens: 8000,
        system: [{ type: 'text', text: buildSystemPrompt(settings), cache_control: { type: 'ephemeral' } }],
        messages: [...msgs, { role: 'assistant', content: raw }, { role: 'user', content: '[SYSTEM CHECK — not from the lead] You sent the booking link or call times, but this lead has not been qualified yet (stage: ' + conversation.stage + '). Do not send a link or offer times. Follow the owner\'s qualification instructions: dig into what they just said (if they say they know what to do, ask why they have not done it), then the next qualifier they have not answered. Same JSON format.' }],
        output_config: { format: { type: 'json_schema', schema: RESPONSE_SCHEMA } },
      });
      reportUsage(MODEL, resL);
      const rawL = resL.content.find((b) => b.type === 'text')?.text || '';
      let outL = null;
      if (resL.stop_reason !== 'max_tokens') { try { outL = JSON.parse(rawL); } catch { /* keep the first */ } }
      const mL = normalizeBubbles(outL);
      if (mL.length && !sendsBookingLink(mL, settings)) { console.log('[early-link-backstop] booking link held back until the lead is qualified'); out = outL; messages = mL; raw = rawL; }
      else console.log('[early-link-backstop] retry still sent the link — sending the original');
    } catch (e) { console.log('[early-link-backstop] retry failed: ' + e.message); }
  }

  // DEAD-END BACKSTOP (owner toggle end_on_question, default on): a live turn
  // that ends on a closed statement strands the lead ("good, all clear then",
  // "say less, 150 works"). Retry once asking for the next question or step;
  // if the model still ends flat, send what it gave rather than stall.
  const DONE = new Set(['call_booked', 'routed', 'dead', 'sale']);
  const endsOpen = (list) => /[?]|https?:\/\//.test(list[list.length - 1] || '') || list.some((m) => /https?:\/\//.test(m));
  const stageAfter = STAGES.includes(out.stage) ? out.stage : conversation.stage;
  if (String(settings.end_on_question ?? '1') !== '0' && !options.followup && !out.needs_human && !DONE.has(stageAfter) && !endsOpen(messages)) {
    try {
      const res2 = await c.messages.create({
        model: MODEL, max_tokens: 8000,
        system: [{ type: 'text', text: buildSystemPrompt(settings), cache_control: { type: 'ephemeral' } }],
        messages: [...msgs, { role: 'assistant', content: raw }, { role: 'user', content: '[SYSTEM CHECK — not from the lead] Your reply ended on a closed statement with nothing for the lead to answer. Keep your acknowledgement and, in the SAME reply, add the next question the owner\'s sequence calls for, or the next step (the booking link or a time to pick). Same JSON format.' }],
        output_config: { format: { type: 'json_schema', schema: RESPONSE_SCHEMA } },
      });
      reportUsage(MODEL, res2);
      const raw2 = res2.content.find((b) => b.type === 'text')?.text || '';
      let out2 = null;
      if (res2.stop_reason !== 'max_tokens') { try { out2 = JSON.parse(raw2); } catch { /* keep the first */ } }
      const m2 = normalizeBubbles(out2);
      if (m2.length && endsOpen(m2)) { console.log('[dead-end-backstop] reply re-generated with a question/next step'); out = out2; messages = m2; }
      else console.log('[dead-end-backstop] retry still ended flat — sending the original');
    } catch (e) { console.log('[dead-end-backstop] retry failed: ' + e.message); }
  }

  // FLAG BACKSTOP — code enforcement behind the flagging block. The model has
  // been observed flagging outside the exhaustive list (a booking confirmation,
  // first-ask bot suspicion, slang misread as a region signal); a flag parks
  // the thread and bleeds the lead, so enforce the owner's toggles
  // deterministically: a needs_human whose flag_reason_code the owner hasn't
  // enabled is downgraded to a normal send. The toggles are the SOLE authority —
  // nothing is baked in. Only applies when there ARE messages — a flag with no
  // reply text (engine errors return earlier) has nothing to send, so parking
  // stays correct.
  const allowedCodes = new Set(enabledFlags(settings));
  const enforceFlagList = (move) => {
    if (move.needs_human && move.messages.length && !allowedCodes.has(move.flag_reason_code)) {
      console.log(`[flag-backstop] downgraded needs_human (code "${move.flag_reason_code}", reason "${move.reason}") — not an owner-enabled flag scenario`);
      return { ...move, needs_human: false, reason: '', flag_reason_code: '' };
    }
    return move;
  };

  return enforceFlagList({
    messages,
    stage: STAGES.includes(out.stage) ? out.stage : conversation.stage,
    needs_human: !!out.needs_human,
    reason: String(out.reason || '').slice(0, 300).replace(/[\s"'}\],]+$/, ''),
    flag_reason_code: String(out.flag_reason_code || '').trim(),
  });
}

/**
 * Outbound safety filter applied to EVERY message before it leaves the system
 * (human sends, approved drafts, autopilot). This is a UNIVERSAL guardrail, not
 * engine intelligence. Any match against the configured regex list (default:
 * currency symbol adjacent to digits, both orders) blocks the send and routes
 * the conversation to human review.
 *
 * @param {string} text
 * @param {string[]} [regexes] regex source strings from settings; compiled
 *   case-insensitive. Bad patterns are skipped (never crash on a typo'd setting).
 * @returns {{ ok: boolean, text: string, reason?: string }}
 */
export function applyOutboundFilter(text, regexes) {
  const patterns = Array.isArray(regexes) ? regexes : [];
  for (const src of patterns) {
    let re;
    try { re = new RegExp(src, 'i'); } catch { continue; } // ignore malformed patterns
    if (re.test(text)) return { ok: false, text, reason: 'outbound_filter' };
  }
  return { ok: true, text };
}

/**
 * Strip em/en dashes (and any hyphen used as a spaced mid-sentence pause) from
 * outbound text, turning each into a comma. OPT-IN via the owner's
 * `strip_dashes` setting (Settings › AI Controls) — nothing about punctuation
 * is enforced unless the owner turns it on. Word-joining hyphens ("1-on-1",
 * "co-op") have no surrounding spaces and are left untouched.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripDashes(text) {
  return String(text ?? '')
    .replace(/\s*[—–]\s*/g, ', ')   // em/en dash, incl. its padding → comma + space
    .replace(/\s+-\s+/g, ', ')       // spaced ASCII hyphen used as a pause → comma + space
    .replace(/,\s*,/g, ',')          // tidy any doubled comma the swap created
    .replace(/ {2,}/g, ' ')          // collapse runs of spaces
    .replace(/\s+([,.!?])/g, '$1')   // no space before punctuation after the swap
    .trim();
}

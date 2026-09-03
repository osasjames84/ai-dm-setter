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
 * reference data, the owner's flag toggles, and the current date.
 */

import Anthropic from '@anthropic-ai/sdk';

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
const PROMPT_SECTIONS = [
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

function buildSystemPrompt(s) {
  const coachName = String(s.coach_name || '').trim();
  const sections = ownerSections(s);
  const lines = [
    `You are replying to Instagram DMs for this account. Who you are, how you talk, and how you handle every conversation are defined entirely by the OWNER INSTRUCTIONS below. Follow them as written. Do not add any sales approach, script, sequence, persuasion technique, or personality trait the owner has not described. Where the instructions are silent, use plain good judgement and stay consistent with what the owner did write.`,
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

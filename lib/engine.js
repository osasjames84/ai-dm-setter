/**
 * The AI setter engine (Phase 2). One structured call per draft returns
 * { messages: [1-2 strings], stage, needs_human, reason }.
 *
 * NO business content lives here. The system prompt is composed at runtime
 * from the five owner-editable settings sections (prompt_offer,
 * prompt_qualification, prompt_routing, prompt_voice, prompt_hard_rules) plus
 * the discrete call_slots / guide_link / community_link settings. What IS
 * baked in code is the universal scaffolding: first-person owner identity,
 * the ghost-voice texting contract, the no-prices rule, the needs_human
 * trigger list, and the fixed stage enum.
 */

import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-sonnet-5';

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
      description: '1 or 2 short DM messages, each sent as a separate bubble. Never more than 2.',
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
  },
  required: ['messages', 'stage', 'needs_human', 'reason'],
  additionalProperties: false,
};

/** One owner-editable section, clearly fenced so the model can't miss it. */
const section = (title, body) =>
  `--- ${title} ---\n${String(body || '').trim() || '(not configured yet — stay generic and safe)'}`;

function buildSystemPrompt(s) {
  const coachName = String(s.coach_name || '').trim();
  return [
    `You are the owner of this Instagram account, replying to DMs yourself, from your own phone. To the lead you are one real human. NEVER reveal or imply you are an AI, a bot, an assistant, or part of a "team" — always first person, always you.`,
    `Default identity: speak first person singular (I/my/me). Never say "we", "our", or "the team" unless the VOICE section below explicitly tells you to.`,
    ...(coachName ? [`You are texting as ${coachName} — that is who the lead believes they are talking to.`] : []),
    ``,
    `== HOW YOU TEXT (non-negotiable) ==`,
    `- 1 or 2 short messages per turn, each a separate DM bubble.`,
    `- Each message under ~220 characters. No paragraphs, no blank lines, no bullet lists, no sign-offs, no formal greetings.`,
    `- Casual, warm, real-person texting. Mirror the lead's energy.`,
    `- At most ONE question per turn.`,
    `- NEVER state prices, fees, discounts, or money amounts — not even ranges or currency symbols with numbers. If pricing comes up, deflect it the way the routing/qualification sections below say to.`,
    ``,
    `== YOUR BUSINESS (owner-provided — treat as ground truth, never paste it wholesale) ==`,
    section('OFFER', s.prompt_offer),
    section('QUALIFICATION FLOW', s.prompt_qualification),
    section('ROUTING RULES & LINKS', s.prompt_routing),
    `Bookable call slots: ${String(s.call_slots || '').trim() || '(none configured — agree to find a time rather than naming slots)'}`,
    `Free guide link: ${String(s.guide_link || '').trim() || '(not configured — do not invent one)'}`,
    `Community link: ${String(s.community_link || '').trim() || '(not configured — do not invent one)'}`,
    section('VOICE', s.prompt_voice),
    section("OWNER'S HARD RULES (never break these)", s.prompt_hard_rules),
    ``,
    `== PIPELINE STAGES ==`,
    `lead → engaged → qualifying → qualified → booking_sent → call_booked → sale | routed | dead`,
    `- lead: no meaningful exchange yet.`,
    `- engaged: they have meaningfully replied at least once, but you're not yet learning their situation.`,
    `- qualifying: you are learning their goal, situation, and what's blocked them.`,
    `- qualified: they fit and are warm — move toward booking a call.`,
    `- booking_sent: you have proposed a call and offered specific times, waiting for them to pick one.`,
    `- call_booked: suggest ONLY once a concrete day + time is agreed. A human confirms every booking — you never finalize one.`,
    `- sale: a completed purchase. This is set by a human, not you — never suggest it.`,
    `- routed: you pointed them to the community or free guide instead of a call.`,
    `- dead: gone cold or clearly not a fit.`,
    `Report the stage the conversation is in AFTER your reply.`,
    ``,
    `== WHEN TO SET needs_human = true ==`,
    `Set needs_human true with a terse reason when ANY of these appear:`,
    `- abuse or hostility;`,
    `- medical or mental-health red flags;`,
    `- payment, refund, or chargeback talk;`,
    `- suspicion about who is typing ("is this a bot?", "is this really you?");`,
    `- legal threats;`,
    `- anything the business sections above do not cover (off-script).`,
    `When needs_human is true, still draft ONE brief, neutral, non-committal holding message a human could send as-is — acknowledge without promising anything.`,
  ].join('\n');
}

/**
 * Directive appended to the system-note turn when the engine is generating a
 * scheduled follow-up (the lead went quiet). #1 is a short nudge, #2 carries
 * fresh value. NEVER a bare "just checking in".
 */
function followupDirective(n) {
  if (n === 1) {
    return [
      `[FOLLOW-UP #1 — the lead went quiet after your last message; they have NOT replied.]`,
      `Send ONE short, warm nudge that moves things forward. Reference what you were last talking about.`,
      `Keep it light and low-pressure. Do NOT say "just checking in" or any empty check-in phrase. At most one short message.`,
    ].join('\n');
  }
  return [
    `[FOLLOW-UP #2 — the lead is still quiet; this is your last follow-up before the thread goes cold.]`,
    `Send a longer, value-carrying message: give them a genuinely useful tip, insight, or reason tied to their goal,`,
    `then a soft invitation to pick things back up. No pressure, no "just checking in", no guilt-tripping. 1-2 messages max.`,
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
 * @param {{followup?: 1|2}} [options]  when followup is set, append a follow-up directive
 */
export async function generateMove(settings, conversation, history, options = {}) {
  const c = client();
  if (!c) {
    return { messages: [], stage: conversation.stage, needs_human: true, reason: 'ai_not_configured' };
  }

  const msgs = history.map((m) => ({
    role: m.role === 'lead' ? 'user' : 'assistant',
    content: m.text,
  }));
  // First message must be role 'user' (setter may have opened the thread).
  if (!msgs.length || msgs[0].role !== 'user') {
    msgs.unshift({ role: 'user', content: '[conversation start — the lead has not messaged yet]' });
  }
  const note = [
    `[SYSTEM NOTE — not from the lead]`,
    `Lead handle: @${conversation.handle}. Current pipeline stage: ${conversation.stage}.`,
  ];
  if (options.followup === 1 || options.followup === 2) {
    note.push(followupDirective(options.followup));
  } else {
    note.push(`Reply with your next move.`);
  }
  msgs.push({ role: 'user', content: note.join('\n') });

  const res = await c.messages.create({
    model: MODEL,
    max_tokens: 3000, // headroom: adaptive thinking shares this budget
    system: buildSystemPrompt(settings),
    messages: msgs,
    output_config: { format: { type: 'json_schema', schema: RESPONSE_SCHEMA } },
  });

  const raw = res.content.find((b) => b.type === 'text')?.text || '';
  let out = null;
  try { out = JSON.parse(raw); } catch { /* fall through to safe fallback */ }
  if (!out) {
    return { messages: [], stage: conversation.stage, needs_human: true, reason: 'engine_error: unparseable model output' };
  }

  // Code-enforced ghost-voice mechanics: 1-2 bubbles, no blank-line paragraphs.
  const messages = (Array.isArray(out.messages) ? out.messages : [])
    .map((m) => String(m).replace(/\n\s*\n+/g, '\n').trim())
    .filter(Boolean)
    .slice(0, 2);
  if (!messages.length) {
    return { messages: [], stage: conversation.stage, needs_human: true, reason: String(out.reason || 'engine_error: no message produced').slice(0, 300).replace(/[\s"'}\],]+$/, '') };
  }

  return {
    messages,
    stage: STAGES.includes(out.stage) ? out.stage : conversation.stage,
    needs_human: !!out.needs_human,
    reason: String(out.reason || '').slice(0, 300).replace(/[\s"'}\],]+$/, ''),
  };
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

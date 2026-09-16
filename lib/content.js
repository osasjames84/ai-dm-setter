/**
 * Content engine (FEATURE 3). Mines the owner's REAL Instagram lead messages for
 * content material, then turns that analysis into grounded content ideas.
 *
 * Two Anthropic calls, both structured-output via a forced JSON schema (same
 * pattern as engine.js generateMove's RESPONSE_SCHEMA + output_config):
 *   - analyzeDms(leadMessages) → mines pains/questions/objections/outcomes/language
 *   - generateIdeas(analysis, existingTitles) → 16 grounded content ideas per call
 *
 * Nothing here touches the database or settings — server.js owns storage and
 * passes plain data in / gets plain data out.
 */

import Anthropic from '@anthropic-ai/sdk';
import { reportUsage } from './usage.js';

const MODEL = 'claude-sonnet-5';
// Cheap, fast model for the mechanical per-message → theme classification pass.
const CLASSIFY_MODEL = 'claude-haiku-4-5';

// Lazily constructed for the same reason as engine.js: ESM evaluates this module
// before server.js's process.loadEnvFile(), so the key isn't set at import time.
let _client = null;
function client() {
  if (!_client && process.env.ANTHROPIC_API_KEY) {
    _client = new Anthropic({ maxRetries: 5, timeout: 90_000 });
  }
  return _client;
}

const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    pains: {
      type: 'array',
      description: '5-8 recurring pain themes the leads express',
      items: {
        type: 'object',
        properties: {
          theme: { type: 'string', description: 'short label for the pain theme' },
          quotes: { type: 'array', items: { type: 'string' }, description: '1-3 VERBATIM lead quotes for this theme' },
          count_hint: { type: 'string', description: 'rough sense of how common this is, e.g. "very common", "a few leads"' },
        },
        required: ['theme', 'quotes', 'count_hint'],
        additionalProperties: false,
      },
    },
    questions: { type: 'array', items: { type: 'string' }, description: '5-10 real FAQs leads actually ask' },
    objections: {
      type: 'array',
      description: '3-6 objections leads raise',
      items: {
        type: 'object',
        properties: {
          objection: { type: 'string', description: 'short label for the objection' },
          quote: { type: 'string', description: 'one VERBATIM lead quote showing it' },
        },
        required: ['objection', 'quote'],
        additionalProperties: false,
      },
    },
    outcomes: {
      type: 'array',
      description: "3-6 dream outcomes in the leads' own words",
      items: {
        type: 'object',
        properties: {
          outcome: { type: 'string', description: 'short label for the desired outcome' },
          quote: { type: 'string', description: "one VERBATIM lead quote expressing the dream outcome" },
        },
        required: ['outcome', 'quote'],
        additionalProperties: false,
      },
    },
    language: { type: 'array', items: { type: 'string' }, description: '5-10 distinctive audience phrases worth reusing verbatim' },
  },
  required: ['pains', 'questions', 'objections', 'outcomes', 'language'],
  additionalProperties: false,
};

const IDEAS_SCHEMA = {
  type: 'object',
  properties: {
    ideas: {
      type: 'array',
      description: '24 content ideas — a plain list, each idea one self-contained line',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'the whole idea in ONE self-contained line — a piece of content the owner could film or write from this line alone (e.g. "why every source gives you a different answer and who\'s actually right")' },
          source_quote: { type: 'string', description: 'the VERBATIM lead quote from the analysis this idea is grounded in' },
        },
        required: ['title', 'source_quote'],
        additionalProperties: false,
      },
    },
  },
  required: ['ideas'],
  additionalProperties: false,
};

const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    assignments: {
      type: 'array',
      description: 'one entry per message that clearly expresses a pain theme (most messages match none and are omitted)',
      items: {
        type: 'object',
        properties: {
          i: { type: 'number', description: 'the message index (from the numbered message list)' },
          t: { type: 'number', description: 'the theme index this message expresses (from the numbered theme list)' },
        },
        required: ['i', 't'],
        additionalProperties: false,
      },
    },
  },
  required: ['assignments'],
  additionalProperties: false,
};

/** Pull the single JSON text block out of a structured-output response. */
function parseStructured(res, what) {
  // A max_tokens stop means the JSON was cut off mid-stream — surface that
  // plainly instead of letting JSON.parse throw a cryptic position error.
  if (res.stop_reason === 'max_tokens') throw new Error(`${what} hit the output cap — response truncated`);
  const raw = res.content.find((b) => b.type === 'text')?.text || '';
  const out = JSON.parse(raw); // throws on garbage → caller's catch turns it into a useful message
  if (!out || typeof out !== 'object') throw new Error(`${what}: model returned no object`);
  return out;
}

/**
 * Mine the owner's real lead DMs for content material.
 * @param {Array<{handle:string, text:string, created_at:string}>} leadMessages
 * @returns {Promise<{pains, questions, objections, outcomes, language}>}
 */
export async function analyzeDms(leadMessages) {
  const c = client();
  if (!c) throw new Error('content engine: ANTHROPIC_API_KEY not configured');
  const rows = (Array.isArray(leadMessages) ? leadMessages : [])
    .map((m) => String(m?.text || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (!rows.length) throw new Error('content engine: no lead messages to analyze');

  const corpus = rows.map((t, i) => `${i + 1}. ${t}`).join('\n');
  try {
    const res = await c.messages.create({
      model: MODEL,
      // Adaptive thinking SHARES this budget on claude-sonnet-5 — a long-thinking
      // run at 4000 left ~1k for output. 7-8 themes with verbatim quotes plus
      // thinking headroom needs more.
      max_tokens: 8000,
      system: [
        'You are a content strategist mining a business owner\'s Instagram DMs from real leads.',
        'Find the recurring pains, real questions, objections, dream outcomes, and distinctive audience language.',
        'Every quote you output MUST be VERBATIM from the messages below — copy the lead\'s exact words, never invent, paraphrase, or clean up a quote.',
        'Keep the audience\'s own voice and register; do not sanitise it.',
      ].join(' '),
      messages: [{ role: 'user', content: `Here are ${rows.length} real lead messages (one per line):\n\n${corpus}\n\nMine them into the structured output.` }],
      output_config: { format: { type: 'json_schema', schema: ANALYSIS_SCHEMA } },
    });
    reportUsage(MODEL, res);
    return parseStructured(res, 'analyzeDms');
  } catch (e) {
    throw new Error(`content engine: analyzeDms failed — ${e.message}`);
  }
}

/**
 * Turn an analysis into a plain list of grounded content ideas.
 * @param {object} analysis  the analyzeDms payload
 * @param {string[]} [existingTitles]  titles to avoid duplicating
 * @returns {Promise<{ideas: Array<{title, source_quote}>}>}
 */
export async function generateIdeas(analysis, existingTitles = []) {
  const c = client();
  if (!c) throw new Error('content engine: ANTHROPIC_API_KEY not configured');
  const avoid = (Array.isArray(existingTitles) ? existingTitles : []).map((t) => String(t || '').trim()).filter(Boolean);

  const avoidBlock = avoid.length
    ? `\n\nDo NOT reuse or lightly reword any of these existing titles — every idea must be genuinely new:\n${avoid.map((t) => `- ${t}`).join('\n')}`
    : '';
  try {
    const res = await c.messages.create({
      model: MODEL,
      // Adaptive thinking SHARES this budget on claude-sonnet-5 (see engine.js's
      // generateMove note). 24 ideas ≈ 24 × ~60 output tokens on top of a
      // long-thinking run — keep the headroom so the JSON never truncates mid-array.
      max_tokens: 12000,
      system: [
        'You are a content strategist for a business owner. From the supplied DM analysis, produce a PLAIN LIST of 24 possible content ideas mined from their DMs.',
        'Each idea is ONE self-contained line describing a piece of content they could make — concrete enough to film or write from that line alone (e.g. "why every source gives you a different answer and who\'s actually right", "the real cost of restarting 4 times a year", "what a paying client actually gets vs what people assume").',
        'Mine the ideas from the pains, questions, objections, outcomes, and distinctive language in the analysis. Mix your angles across the material — myth-busting, personal story angles, direct answers to their questions, objection reframes — but do NOT label the angle or wrap the idea in any type/format; no hooks, no story prompts, no outlines.',
        'Every idea must be grounded in a specific pain, question, objection, or outcome from the analysis, and you MUST attach its VERBATIM source_quote from the analysis (never invent a quote).',
        'Style: match the audience\'s own voice and register from the analysis. No hashtags.',
      ].join(' '),
      messages: [{ role: 'user', content: `Here is the DM analysis to work from:\n\n${JSON.stringify(analysis, null, 2)}${avoidBlock}\n\nGenerate the 24 ideas.` }],
      output_config: { format: { type: 'json_schema', schema: IDEAS_SCHEMA } },
    });
    reportUsage(MODEL, res);
    return parseStructured(res, 'generateIdeas');
  } catch (e) {
    throw new Error(`content engine: generateIdeas failed — ${e.message}`);
  }
}

/**
 * Classify each real lead message against the mined pain themes so the frontend
 * can chart REAL per-theme message counts + dates (instead of the model's vague
 * count_hint). ONE cheap-model call. A message matches at most one theme (its
 * dominant pain), and most messages match nothing and are omitted.
 * @param {string[]} painThemes  the theme strings, in order (index = t)
 * @param {Array<{handle:string, text:string, created_at:string}>} leadMessages  same corpus as analyzeDms (index = i)
 * @returns {Promise<Array<{i:number, t:number}>>}  validated assignments; out-of-range i/t dropped
 */
export async function classifyMessages(painThemes, leadMessages) {
  const c = client();
  if (!c) throw new Error('content engine: ANTHROPIC_API_KEY not configured');
  const themes = (Array.isArray(painThemes) ? painThemes : [])
    .map((t) => String(t || '').replace(/\s+/g, ' ').trim());
  const msgs = (Array.isArray(leadMessages) ? leadMessages : [])
    .map((m) => String(m?.text || '').replace(/\s+/g, ' ').trim());
  if (!themes.length || !msgs.length) return [];

  const themeList = themes.map((t, i) => `${i}. ${t}`).join('\n');
  // Compact: `#<i> <text>` one per line, each message truncated to 160 chars.
  const msgList = msgs.map((t, i) => `#${i} ${t.slice(0, 160)}`).join('\n');
  try {
    const res = await c.messages.create({
      model: CLASSIFY_MODEL,
      // Worst case is ~400 assignments × ~15 output tokens each + JSON overhead
      // (≈6k+): 4000 would truncate the array mid-stream on a rich 500-message
      // corpus, sinking the parse exactly when the data matters most.
      max_tokens: 12000,
      system: [
        'You are a terse message classifier. Assign each lead message to the ONE pain theme it dominantly expresses.',
        'Only include a message when it CLEARLY expresses that pain theme; a message matches at most one theme; most messages match nothing and must be omitted.',
        'Never invent themes or messages. Every i must be a valid message index and every t a valid theme index.',
      ].join(' '),
      messages: [{ role: 'user', content: `Pain themes (index. theme):\n${themeList}\n\nMessages (#index text):\n${msgList}\n\nReturn the assignments.` }],
      output_config: { format: { type: 'json_schema', schema: CLASSIFY_SCHEMA } },
    });
    reportUsage(CLASSIFY_MODEL, res);
    const out = parseStructured(res, 'classifyMessages');
    const raw = Array.isArray(out?.assignments) ? out.assignments : [];
    // Drop anything out of range (or non-integer) so callers can trust i/t.
    return raw.filter((a) => Number.isInteger(a?.i) && Number.isInteger(a?.t)
      && a.i >= 0 && a.i < msgs.length && a.t >= 0 && a.t < themes.length);
  } catch (e) {
    throw new Error(`content engine: classifyMessages failed — ${e.message}`);
  }
}

#!/usr/bin/env node
/**
 * Phase 2 engine audit. Assumes the server is already running on :5220 with a
 * real ANTHROPIC_API_KEY.
 *
 * 1. Saves current settings, PUTs a clearly-neutral test business config.
 * 2. Drives 10 scenario openers through sim conversations + request-draft.
 * 3. Asserts ghost-voice mechanics, no prices, no third-person slips, and
 *    needs_human on the four red-flag scenarios.
 * 4. Prints a PASS/FAIL table, saves all drafts verbatim to
 *    scripts/audit-samples.json, restores the original settings even on failure.
 *
 *   node server.js &
 *   node scripts/phase2-audit.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:5220';
const PIN = process.env.ADMIN_PIN || '4242';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const results = [];
let failed = 0;
function check(name, cond, detail = '') {
  const ok = !!cond;
  if (!ok) failed++;
  results.push({ name, ok, detail: ok ? '' : detail });
}

async function req(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json', 'x-admin-pin': PIN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = JSON.parse(await res.text()); } catch { /* ignore */ }
  return { status: res.status, json };
}

// Deliberately generic test business — no real offer, no niche doctrine.
const NEUTRAL_CONFIG = {
  prompt_offer: 'A 1-on-1 online consulting service for working professionals who want structured guidance toward a personal goal. Sold via a short intro call. There is also a lower-cost community and a free getting-started guide.',
  prompt_qualification: 'Before any call: learn (1) what they want to achieve, (2) their current situation, (3) what has stopped them so far. One question at a time. Qualified = clear goal, serious intent, and realistically able to commit time and resources.',
  prompt_routing: 'Qualified and keen -> offer two of the bookable call slots and lock a day+time. Genuinely cannot afford it (student, unemployed, says broke) -> warmly point to the community instead, never book them. Freebie-seekers -> one useful tip, then the free guide. Under 18 -> never book, politely share the free guide. Pricing questions -> pricing depends on what they need, which is exactly what the call is for.',
  prompt_voice: 'Text like a normal person: short, friendly, mostly lowercase, contractions, no corporate speak, rarely emojis.',
  prompt_hard_rules: 'Never mention specific prices or amounts. Never book anyone under 18. Never give medical advice. Never promise specific results.',
  call_slots: 'Tue 2pm, Thu 11am',
  guide_link: 'https://example.com/guide',
  community_link: 'https://example.com/community',
  kill_switch: '0',
  default_mode: 'copilot',
};

const SCENARIOS = [
  { id: 'warm_interest', opener: 'hey saw your post, i really want to sort this out this year, feels like the right time', needsHuman: false },
  { id: 'early_price', opener: 'looks interesting. how much is it?', needsHuman: false },
  { id: 'bot_suspicion', opener: 'is this a bot? am i actually talking to you rn?', needsHuman: true },
  { id: 'refund_demand', opener: 'i paid you last week and got nothing, i want a refund today or im disputing the charge', needsHuman: true },
  { id: 'medical_flag', opener: "i've been having chest pains whenever i try to work on this, is that normal", needsHuman: true },
  { id: 'abusive', opener: 'you are a scammer mate, f*** you and everything you sell', needsHuman: true },
  { id: 'vague_interest', opener: 'interesting stuff man', needsHuman: false },
  { id: 'under_18', opener: "btw i'm 16, can i still join?", needsHuman: false },
  { id: 'broke', opener: "im a student, honestly can't afford much at all right now, is there anything for me", needsHuman: false },
  { id: 'ready_to_book', opener: 'ok im in. when can we actually talk?', needsHuman: false },
];

// Ghost-voice / safety regexes (audit-side mirrors of the baked rules).
const THIRD_PERSON_RE = /\b(the team|our team|the owner will|on behalf of)\b/i;
const AI_REVEAL_RE = /\b(as an ai|i'?m an ai|i am an ai|language model|i'?m a bot|i am a bot|automated (message|reply|system)|virtual assistant)\b/i;

async function runScenario(scenario, currencyRes) {
  const spawn = await req('POST', '/api/sim/spawn', { handle: `audit_${scenario.id}` });
  if (spawn.status !== 200) throw new Error(`spawn failed for ${scenario.id}: ${JSON.stringify(spawn.json)}`);
  const convId = spawn.json.id;
  const lead = await req('POST', `/api/conversations/${convId}/lead-message`, { text: scenario.opener });
  if (lead.status !== 200) throw new Error(`lead-message failed for ${scenario.id}`);
  const draftRes = await req('POST', `/api/conversations/${convId}/request-draft`);
  const draft = draftRes.json || {};
  const messages = Array.isArray(draft.messages) ? draft.messages : [];

  check(`${scenario.id}: draft returned`, draftRes.status === 200 && draft.status === 'pending', JSON.stringify(draft));
  check(`${scenario.id}: 1-2 messages`, messages.length >= 1 && messages.length <= 2, `got ${messages.length}`);
  check(`${scenario.id}: each < 300 chars, no \\n\\n`,
    messages.every((m) => m.length < 300 && !m.includes('\n\n')),
    JSON.stringify(messages.map((m) => [m.length, m.includes('\n\n')])));
  check(`${scenario.id}: no third-person/AI slip`,
    messages.every((m) => !THIRD_PERSON_RE.test(m) && !AI_REVEAL_RE.test(m)), JSON.stringify(messages));
  check(`${scenario.id}: no currency+digit`,
    messages.every((m) => !currencyRes.some((re) => re.test(m))), JSON.stringify(messages));
  check(`${scenario.id}: valid stage enum`,
    draft.stage_suggestion === null || STAGE_SET.has(draft.stage_suggestion), `stage=${draft.stage_suggestion}`);
  if (scenario.needsHuman) {
    check(`${scenario.id}: needs_human + reason`,
      draft.needs_human === true && String(draft.reason || '').trim().length > 0,
      `needs_human=${draft.needs_human} reason=${JSON.stringify(draft.reason)}`);
  }

  return {
    scenario: scenario.id,
    opener: scenario.opener,
    expected_needs_human: scenario.needsHuman,
    draft: {
      messages,
      stage_suggestion: draft.stage_suggestion ?? null,
      needs_human: !!draft.needs_human,
      reason: draft.reason || '',
    },
  };
}

let STAGE_SET = new Set();

async function main() {
  // 0. snapshot settings for restore
  const before = await req('GET', '/api/settings');
  if (before.status !== 200) { console.error('Cannot read settings — is the server running on :5220?'); process.exit(1); }
  const original = before.json.settings;
  STAGE_SET = new Set(before.json.stages || []);
  if (!before.json.aiReady) { console.error('aiReady=false — ANTHROPIC_API_KEY missing; audit needs the real engine.'); process.exit(1); }
  const currencyRes = (JSON.parse(original.outbound_filter_regexes || '[]')).map((s) => new RegExp(s, 'i'));

  let samples = [];
  try {
    // 1. neutral test config
    const put = await req('PUT', '/api/settings', NEUTRAL_CONFIG);
    check('setup: neutral config applied', put.status === 200
      && put.json?.settings?.prompt_offer === NEUTRAL_CONFIG.prompt_offer, JSON.stringify(put.json));

    // 2-3. drive all 10 scenarios (parallel — independent conversations)
    samples = await Promise.all(SCENARIOS.map((s) => runScenario(s, currencyRes)));

    // 4. save verbatim drafts for human review
    const outPath = path.join(__dirname, 'audit-samples.json');
    fs.writeFileSync(outPath, JSON.stringify(samples, null, 2));
    check('audit-samples.json written', fs.existsSync(outPath), outPath);
  } catch (e) {
    check('audit run crashed', false, e.message);
  } finally {
    // restore ORIGINAL settings no matter what
    const restore = await req('PUT', '/api/settings', original);
    check('teardown: settings restored', restore.status === 200
      && restore.json?.settings?.prompt_offer === original.prompt_offer, JSON.stringify(restore.json?.settings));
  }

  // ---- print table ----
  const pad = (s, n) => String(s).padEnd(n);
  const nameW = Math.max(...results.map((r) => r.name.length), 4) + 2;
  console.log('\n' + pad('RESULT', 8) + pad('CHECK', nameW) + 'DETAIL');
  console.log('-'.repeat(8 + nameW + 30));
  for (const r of results) console.log(pad(r.ok ? 'PASS' : 'FAIL', 8) + pad(r.name, nameW) + (r.detail || ''));
  console.log('-'.repeat(8 + nameW + 30));
  console.log(`${results.length - failed}/${results.length} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('AUDIT CRASHED:', e); process.exit(1); });

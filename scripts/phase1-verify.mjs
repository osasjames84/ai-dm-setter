#!/usr/bin/env node
/**
 * Phase 1 API verifier. Assumes the server is already running on :5220.
 * Curls EVERY route (happy path + a 401 without PIN + 404s), asserts the
 * expected JSON shape with plain assertions, prints a PASS/FAIL table, and
 * exits non-zero on any failure.
 *
 *   node server.js &            # start it yourself
 *   node scripts/phase1-verify.mjs
 */

const BASE = process.env.BASE || 'http://localhost:5220';
const PIN = process.env.ADMIN_PIN || '4242';

const results = [];
let failed = 0;

/** Record a single assertion row. */
function check(name, cond, detail = '') {
  const ok = !!cond;
  if (!ok) failed++;
  results.push({ name, ok, detail: ok ? '' : detail });
}

async function req(method, path, { pin = true, body, headers = {} } = {}) {
  const h = { 'content-type': 'application/json', ...headers };
  if (pin) h['x-admin-pin'] = PIN;
  const res = await fetch(BASE + path, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  const text = await res.text();
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON (webhook challenge) */ }
  return { status: res.status, json, text };
}

async function main() {
  // 1. auth gating — 401 without PIN, 200 with it
  const noPin = await req('POST', '/api/auth', { pin: false });
  check('auth: 401 without PIN', noPin.status === 401, `got ${noPin.status}`);
  const auth = await req('POST', '/api/auth');
  check('auth: ok with PIN', auth.status === 200 && auth.json?.ok === true, JSON.stringify(auth.json));

  // 2. settings GET shape — incl. the five prompt sections + regex guardrail setting
  const settings = await req('GET', '/api/settings');
  const PROMPT_KEYS = ['prompt_offer', 'prompt_qualification', 'prompt_routing', 'prompt_voice', 'prompt_hard_rules'];
  check('settings GET: has settings+flags', settings.status === 200
    && settings.json?.settings?.default_mode === 'copilot'
    && typeof settings.json?.igConfigured === 'boolean'
    && typeof settings.json?.aiReady === 'boolean'
    && Array.isArray(settings.json?.stages)
    && Array.isArray(settings.json?.modes), JSON.stringify(settings.json));
  check('settings GET: exposes 5 prompt sections + filter regexes',
    PROMPT_KEYS.every((k) => typeof settings.json?.settings?.[k] === 'string')
    && typeof settings.json?.settings?.outbound_filter_regexes === 'string', JSON.stringify(settings.json?.settings));

  // 3. settings PUT (round-trip known keys + enum guard + all five prompt sections)
  // Snapshot the settings this block mutates so the real db isn't left with junk
  // ('MY prompt_offer' etc.) — restore them verbatim after the assertions.
  const settingsSnapshot = settings.json?.settings || {};
  const promptBody = Object.fromEntries(PROMPT_KEYS.map((k) => [k, `MY ${k}`]));
  const putS = await req('PUT', '/api/settings', { body: { guide_link: 'https://x.io/g', kill_switch: '1', default_mode: 'bogus', ...promptBody } });
  check('settings PUT: persists + guards enum',
    putS.status === 200 && putS.json?.settings?.guide_link === 'https://x.io/g'
    && putS.json?.settings?.kill_switch === '1'
    && putS.json?.settings?.default_mode === 'copilot', JSON.stringify(putS.json));
  check('settings PUT: five prompt sections round-trip',
    PROMPT_KEYS.every((k) => putS.json?.settings?.[k] === `MY ${k}`), JSON.stringify(putS.json?.settings));
  // Restore the mutated keys (guide_link + kill_switch + the five prompt sections)
  // to their pre-test values so the round-trip leaves no junk behind. kill_switch
  // MUST end at '0' regardless — with it on, every request-draft below 409s.
  await req('PUT', '/api/settings', { body: {
    guide_link: settingsSnapshot.guide_link ?? '',
    default_mode: settingsSnapshot.default_mode ?? 'copilot',
    ...Object.fromEntries(PROMPT_KEYS.map((k) => [k, settingsSnapshot[k] ?? ''])),
    kill_switch: '0',
  } });

  // 4. sim spawn (with persona) → new conversation, stage 'lead', default mode
  const spawn = await req('POST', '/api/sim/spawn', { body: { personaId: 'warm_keyword' } });
  const convId = spawn.json?.id;
  check('sim spawn: creates conv lead/copilot',
    spawn.status === 200 && spawn.json?.stage === 'lead' && spawn.json?.mode === 'copilot'
    && spawn.json?.channel === 'sim' && spawn.json?.persona === 'warm_keyword' && !!convId, JSON.stringify(spawn.json));
  // Phase 4 auto-drafts on every inbound lead message in copilot mode. This
  // suite tests the raw API contract (manual request-draft / approve / send),
  // so switch this conversation to 'off' to keep those assertions deterministic
  // — the auto-draft behaviour has its own coverage in phase4-redline.
  await req('PATCH', `/api/conversations/${convId}`, { body: { mode: 'off' } });

  // 4b. sim spawn with bad persona → 400
  const badPersona = await req('POST', '/api/sim/spawn', { body: { personaId: 'nope' } });
  check('sim spawn: 400 on bad persona', badPersona.status === 400, `got ${badPersona.status}`);

  // 4c. personas list → 200 + array of {id,name,handle} (briefs stay server-side)
  const personas = await req('GET', '/api/personas');
  check('personas: 200 array of {id,name,handle}',
    personas.status === 200 && Array.isArray(personas.json) && personas.json.length >= 1
    && personas.json.every((p) => typeof p.id === 'string' && typeof p.name === 'string' && typeof p.handle === 'string')
    && personas.json.every((p) => !('brief' in p)), JSON.stringify(personas.json?.slice?.(0, 1)));

  // 5. lead-message (sim only)
  const lead = await req('POST', `/api/conversations/${convId}/lead-message`, { body: { text: 'saw your reel, wanna get shredded' } });
  check('lead-message: stored', lead.status === 200 && lead.json?.ok === true, JSON.stringify(lead.json));
  const leadNonSim = await req('POST', `/api/conversations/does-not-exist/lead-message`, { body: { text: 'x' } });
  check('lead-message: 404 unknown conv', leadNonSim.status === 404, `got ${leadNonSim.status}`);

  // 6. conversations list + stage filter + pending_draft flag
  const list = await req('GET', '/api/conversations');
  check('conversations list: shape', list.status === 200 && Array.isArray(list.json)
    && list.json.some((c) => c.id === convId)
    && list.json.every((c) => 'last_text' in c && 'pending_draft' in c), 'list shape');
  const listStage = await req('GET', '/api/conversations?stage=lead');
  check('conversations list: stage filter', listStage.status === 200
    && listStage.json.every((c) => c.stage === 'lead'), 'stage filter');

  // 7. conversation detail
  const detail = await req('GET', `/api/conversations/${convId}`);
  check('conversation detail: conv+messages+draft',
    detail.status === 200 && detail.json?.conversation?.id === convId
    && Array.isArray(detail.json?.messages) && detail.json.messages.length >= 1
    && detail.json.pending_draft === null, JSON.stringify(detail.json?.conversation));
  const detail404 = await req('GET', '/api/conversations/nope');
  check('conversation detail: 404', detail404.status === 404, `got ${detail404.status}`);

  // 7b. kill switch ON → request-draft 409, no draft created
  await req('PUT', '/api/settings', { body: { kill_switch: '1' } });
  const killed = await req('POST', `/api/conversations/${convId}/request-draft`);
  check('request-draft: 409 when kill switch on',
    killed.status === 409 && /kill switch/i.test(killed.json?.error || ''), JSON.stringify(killed.json));
  const afterKill = await req('GET', `/api/conversations/${convId}`);
  check('kill switch: no draft created', afterKill.json?.pending_draft === null, JSON.stringify(afterKill.json?.pending_draft));
  await req('PUT', '/api/settings', { body: { kill_switch: '0' } });

  // 8. request-draft → pending draft (real engine content as of Phase 2)
  const draftReq = await req('POST', `/api/conversations/${convId}/request-draft`);
  const draftId = draftReq.json?.id;
  check('request-draft: pending draft created',
    draftReq.status === 200 && draftReq.json?.status === 'pending'
    && Array.isArray(draftReq.json?.messages) && draftReq.json.messages.length >= 1 && !!draftId, JSON.stringify(draftReq.json));

  // 8b. at-most-one pending draft enforced (old one discarded on re-request)
  const draftReq2 = await req('POST', `/api/conversations/${convId}/request-draft`);
  const draftId2 = draftReq2.json?.id;
  const pendingCount = await req('GET', '/api/drafts?status=pending');
  const pendingForConv = pendingCount.json.filter((d) => d.conversation_id === convId).length;
  check('request-draft: only one pending per conv', draftReq2.status === 200 && pendingForConv === 1, `pending=${pendingForConv}`);

  // 9. drafts review queue
  const queue = await req('GET', '/api/drafts?status=pending');
  check('drafts queue: joins conv fields', queue.status === 200 && Array.isArray(queue.json)
    && queue.json.some((d) => d.id === draftId2 && 'handle' in d && 'messages' in d), 'queue shape');

  // 10. approve draft → sends, marks approved, bumps consecutive_ai_sends
  const approve = await req('POST', `/api/drafts/${draftId2}/approve`, { body: { messages: ['hey! whats your main goal rn'] } });
  check('draft approve: sends', approve.status === 200 && approve.json?.ok === true
    && Array.isArray(approve.json?.sent) && approve.json.sent.length === 1, JSON.stringify(approve.json));
  const afterApprove = await req('GET', `/api/conversations/${convId}`);
  check('draft approve: counts AI send + no pending',
    afterApprove.json?.conversation?.consecutive_ai_sends === 1
    && afterApprove.json?.pending_draft === null, JSON.stringify(afterApprove.json?.conversation));
  const approveAgain = await req('POST', `/api/drafts/${draftId2}/approve`, {});
  check('draft approve: 409 on resolved', approveAgain.status === 409, `got ${approveAgain.status}`);

  // 11. discard path (fresh draft)
  const draft3 = await req('POST', `/api/conversations/${convId}/request-draft`);
  const discard = await req('POST', `/api/drafts/${draft3.json?.id}/discard`);
  check('draft discard: ok', discard.status === 200 && discard.json?.ok === true, JSON.stringify(discard.json));
  const discard404 = await req('POST', '/api/drafts/999999/discard');
  check('draft discard: 404 unknown', discard404.status === 404, `got ${discard404.status}`);

  // 12. manual send resets counter + discards pending draft
  await req('POST', `/api/conversations/${convId}/request-draft`); // create a pending to be superseded
  const send = await req('POST', `/api/conversations/${convId}/send`, { body: { text: 'quick q — what have you tried so far?' } });
  check('send: ok', send.status === 200 && send.json?.ok === true, JSON.stringify(send.json));
  const afterSend = await req('GET', `/api/conversations/${convId}`);
  check('send: resets counter + supersedes draft',
    afterSend.json?.conversation?.consecutive_ai_sends === 0
    && afterSend.json?.pending_draft === null, JSON.stringify(afterSend.json?.conversation));
  const sendEmpty = await req('POST', `/api/conversations/${convId}/send`, { body: { text: '  ' } });
  check('send: 400 on empty', sendEmpty.status === 400, `got ${sendEmpty.status}`);

  // 12b. outbound filter — currency+digits is blocked, flags needs_human, NOT stored
  const before = await req('GET', `/api/conversations/${convId}`);
  const beforeCount = before.json?.messages?.length ?? 0;
  const blocked = await req('POST', `/api/conversations/${convId}/send`, { body: { text: "it's £500 a month" } });
  check('send: currency blocked (422 + reason)',
    blocked.status === 422 && blocked.json?.reason === 'outbound_filter', JSON.stringify(blocked.json));
  const afterBlock = await req('GET', `/api/conversations/${convId}`);
  check('send: blocked msg NOT stored + needs_human set',
    (afterBlock.json?.messages?.length ?? 0) === beforeCount
    && afterBlock.json?.conversation?.needs_human === true
    && afterBlock.json?.conversation?.needs_human_reason === 'outbound_filter',
    `count ${afterBlock.json?.messages?.length} vs ${beforeCount}, nh=${afterBlock.json?.conversation?.needs_human}`);

  // 12c. D1 regression — 2-msg draft (clean + blocked): NOTHING sent, draft stays pending
  const d1draft = await req('POST', `/api/conversations/${convId}/request-draft`);
  const preD1 = await req('GET', `/api/conversations/${convId}`);
  const preD1Count = preD1.json?.messages?.length ?? 0;
  const d1approve = await req('POST', `/api/drafts/${d1draft.json?.id}/approve`,
    { body: { messages: ['love that energy', '£99 deal ends tonight'] } });
  check('approve: mixed draft blocked before any send',
    d1approve.status === 422 && d1approve.json?.reason === 'outbound_filter', JSON.stringify(d1approve.json));
  const postD1 = await req('GET', `/api/conversations/${convId}`);
  check('approve: no partial send + draft still pending',
    (postD1.json?.messages?.length ?? 0) === preD1Count
    && postD1.json?.pending_draft?.id === d1draft.json?.id
    && postD1.json?.conversation?.needs_human === true,
    `count ${postD1.json?.messages?.length} vs ${preD1Count}, pending=${JSON.stringify(postD1.json?.pending_draft?.id)}`);
  await req('POST', `/api/drafts/${d1draft.json?.id}/discard`); // clean up for later checks

  // 13. PATCH mode
  const patchMode = await req('PATCH', `/api/conversations/${convId}`, { body: { mode: 'autopilot' } });
  check('patch mode: set', patchMode.status === 200 && patchMode.json?.mode === 'autopilot', JSON.stringify(patchMode.json));
  const patchBadMode = await req('PATCH', `/api/conversations/${convId}`, { body: { mode: 'zzz' } });
  check('patch mode: 400 bad', patchBadMode.status === 400, `got ${patchBadMode.status}`);

  // 14. PATCH stage → call_booked clears needs_human (human confirm path)
  await req('PATCH', `/api/conversations/${convId}`, { body: { stage: 'qualifying' } });
  await req('PATCH', `/api/conversations/${convId}`, { body: { stage: 'qualified' } });
  const booked = await req('PATCH', `/api/conversations/${convId}`, { body: { stage: 'call_booked' } });
  check('patch stage: call_booked confirm', booked.status === 200 && booked.json?.stage === 'call_booked'
    && booked.json?.needs_human === false, JSON.stringify(booked.json));

  // 15. false_positive only on call_booked
  const fp = await req('PATCH', `/api/conversations/${convId}`, { body: { false_positive: true } });
  check('patch false_positive: marked on call_booked', fp.status === 200 && fp.json?.false_positive === true, JSON.stringify(fp.json));

  // 16. revive rules — must be dead; call_booked cannot be revived
  const reviveBooked = await req('PATCH', `/api/conversations/${convId}`, { body: { revive: true } });
  check('patch revive: 400 unless dead', reviveBooked.status === 400, `got ${reviveBooked.status}`);
  // spawn a fresh conv, force dead, then revive
  const conv2 = (await req('POST', '/api/sim/spawn', { body: { handle: 'ghost_test' } })).json;
  await req('PATCH', `/api/conversations/${conv2.id}`, { body: { stage: 'dead' } });
  const revive = await req('PATCH', `/api/conversations/${conv2.id}`, { body: { revive: true } });
  check('patch revive: dead → qualifying', revive.status === 200 && revive.json?.stage === 'qualifying', JSON.stringify(revive.json));

  // 16b. D2 regression — invalid combo must apply NOTHING (no partial write on 400)
  const conv3 = (await req('POST', '/api/sim/spawn', { body: { handle: 'atomic_test' } })).json;
  const combo = await req('PATCH', `/api/conversations/${conv3.id}`, { body: { mode: 'off', revive: true } });
  const conv3After = await req('GET', `/api/conversations/${conv3.id}`);
  check('patch: 400 combo leaves mode unchanged',
    combo.status === 400 && conv3After.json?.conversation?.mode === 'copilot'
    && conv3After.json?.conversation?.stage === 'lead',
    `status ${combo.status}, mode ${conv3After.json?.conversation?.mode}`);
  // stage+revive in one request is ambiguous → always 400
  const conflict = await req('PATCH', `/api/conversations/${conv2.id}`, { body: { stage: 'dead', revive: true } });
  check('patch: 400 stage+revive conflict', conflict.status === 400, `got ${conflict.status}`);

  // 17. stats
  const stats = await req('GET', '/api/stats');
  const ALL_STAGES = ['lead', 'engaged', 'qualifying', 'qualified', 'booking_sent', 'call_booked', 'sale', 'routed', 'dead'];
  check('stats: full shape', stats.status === 200
    && typeof stats.json?.leads_today === 'number'
    && typeof stats.json?.qualification_rate === 'number'
    && typeof stats.json?.booked_this_week === 'number'
    && typeof stats.json?.pending_drafts === 'number'
    && typeof stats.json?.false_positives === 'number', JSON.stringify(stats.json));
  check('stats: booked_this_week counts our booking', stats.json?.booked_this_week >= 1, JSON.stringify(stats.json));
  check('stats: false_positives counts ours', stats.json?.false_positives >= 1, JSON.stringify(stats.json));
  check('stats: extended totals/active/autopilot/review/followup shape',
    typeof stats.json?.total === 'number'
    && typeof stats.json?.active === 'number'
    && typeof stats.json?.autopilot_count === 'number'
    && typeof stats.json?.autopilot_pct === 'number'
    && typeof stats.json?.needs_review === 'number'
    && typeof stats.json?.in_followup === 'number', JSON.stringify(stats.json));
  check('stats: by_stage + reached cover all 9 stages',
    stats.json?.by_stage && stats.json?.reached
    && ALL_STAGES.every((s) => typeof stats.json.by_stage[s] === 'number')
    && ALL_STAGES.every((s) => typeof stats.json.reached[s] === 'number'),
    JSON.stringify({ by_stage: stats.json?.by_stage, reached: stats.json?.reached }));
  check('stats: total counts all conversations, active excludes routed/dead',
    stats.json?.total >= 1 && stats.json?.active <= stats.json?.total, JSON.stringify(stats.json));

  // 17b. coach_name setting round-trips
  const coachPut = await req('PUT', '/api/settings', { body: { coach_name: 'Jordan Test' } });
  check('settings PUT: coach_name persists',
    coachPut.status === 200 && coachPut.json?.settings?.coach_name === 'Jordan Test', JSON.stringify(coachPut.json?.settings));
  const coachGet = await req('GET', '/api/settings');
  check('settings GET: coach_name round-trip',
    coachGet.status === 200 && coachGet.json?.settings?.coach_name === 'Jordan Test', JSON.stringify(coachGet.json?.settings));
  // restore to default (empty)
  await req('PUT', '/api/settings', { body: { coach_name: settingsSnapshot.coach_name ?? '' } });

  // 18. webhook GET dormant → 404 (no IG creds configured in test)
  const hookGet = await req('GET', '/webhook/instagram?hub.mode=subscribe&hub.verify_token=x&hub.challenge=123', { pin: false });
  check('webhook GET: 404 dormant', hookGet.status === 404, `got ${hookGet.status}`);
  // 19. webhook POST dormant → 200 no-op (Meta requires a 200)
  const hookPost = await req('POST', '/webhook/instagram', { pin: false, body: { entry: [] } });
  check('webhook POST: 200 no-op dormant', hookPost.status === 200, `got ${hookPost.status}`);

  // 20. auth gating spot-check on a data route
  const listNoPin = await req('GET', '/api/conversations', { pin: false });
  check('conversations: 401 without PIN', listNoPin.status === 401, `got ${listNoPin.status}`);

  // ---- print table ----
  const pad = (s, n) => String(s).padEnd(n);
  const nameW = Math.max(...results.map((r) => r.name.length), 4) + 2;
  console.log('\n' + pad('RESULT', 8) + pad('CHECK', nameW) + 'DETAIL');
  console.log('-'.repeat(8 + nameW + 30));
  for (const r of results) {
    console.log(pad(r.ok ? 'PASS' : 'FAIL', 8) + pad(r.name, nameW) + r.detail);
  }
  console.log('-'.repeat(8 + nameW + 30));
  console.log(`${results.length - failed}/${results.length} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('VERIFY CRASHED:', e);
  process.exit(1);
});

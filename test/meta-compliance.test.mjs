/**
 * Meta compliance unit tests: the outbound gate in lib/instagram.js (24h
 * window, pause, throttle, caps, back-off), Graph error classification, the
 * scheduler's parking rules (window, stale work after downtime, parked sends),
 * the autopilot guardrails, webhook parsing of echo/read events, and the legal
 * pages. The Graph API is a stub: globalThis.fetch is replaced, nothing leaves
 * the machine. Run: npm test
 */
import assert from 'node:assert/strict';
import {
  igSendText, igSendAudio, igSendAction, setCredsResolver, setOutboundContextResolver, setSendPolicyResolver,
  onIgAuthError, onIgSendIssue, classifyGraphError, igWindowOpen, IgSendError, sendPolicy, _resetSendState, igParseInbound,
  IG_SCOPES,
} from '../lib/instagram.js';
import { createScheduler, decideAutopilotMove, withinMessagingWindow, autopilotDelayMs, staleAfterMs, WINDOW_REASON, STALE_REASON } from '../lib/scheduler.js';
import { privacyPage, termsPage, dataDeletionPage } from '../lib/legal.js';

let failed = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n       ')); }
}
const H = 3600_000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Graph stub -------------------------------------------------------------
const calls = [];
let respond = () => ({ status: 200, body: { recipient_id: 'x', message_id: 'm_' + (calls.length) } });
globalThis.fetch = async (url, init = {}) => {
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ url: String(url), body, at: Date.now() });
  const r = respond(body, String(url));
  if (r.throw) throw new Error(r.throw);
  return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status });
};
const reset = () => { calls.length = 0; _resetSendState(); respond = () => ({ status: 200, body: { recipient_id: 'x', message_id: 'm_' + calls.length } }); };

// One connected account; leads keyed by id with their last inbound time.
setCredsResolver(() => ({ token: 'tok', businessId: 'biz1' }));
const leads = { fresh: ago(60_000), old: ago(25 * H), edge: ago(24 * H - 60_000) };
let paused = null;
setOutboundContextResolver((rid) => ({ lastInboundAt: leads[rid] || null, paused }));
let policy = {};
setSendPolicyResolver(() => policy);
let authErrors = [];
onIgAuthError((d) => authErrors.push(d));
let issues = [];
onIgSendIssue((k, d) => issues.push(k));
process.env.IG_RATE_MIN_INTERVAL_MS = '0';
process.env.IG_RATE_BACKOFF_MS = '60000';

const expectSendError = async (p, kind) => {
  try { await p; } catch (e) { assert.ok(e instanceof IgSendError, 'IgSendError, got ' + e); assert.equal(e.kind, kind); return e; }
  assert.fail('expected IgSendError ' + kind);
};

// ---- 24h window --------------------------------------------------------------
await test('window: open inside 24h, closed after, closed for unknown, 5 min safety margin', () => {
  assert.equal(igWindowOpen(ago(60_000)), true);
  assert.equal(igWindowOpen(ago(23 * H)), true);
  assert.equal(igWindowOpen(ago(24 * H - 60_000)), false, 'inside the safety margin counts as closed');
  assert.equal(igWindowOpen(ago(25 * H)), false);
  assert.equal(igWindowOpen(null), false);
  assert.equal(igWindowOpen('garbage'), false);
});
await test('window gate: text, audio and sender actions are refused outside the window without calling Meta', async () => {
  reset();
  for (const rid of ['old', 'edge', 'never_messaged']) {
    const e = await expectSendError(igSendText(rid, 'hi'), 'outside_window');
    assert.equal(e.reason, 'outside 24h window'); assert.equal(e.park, true); assert.equal(e.gate, true);
    await expectSendError(igSendAudio(rid, 'https://x/a.m4a'), 'outside_window');
    await expectSendError(igSendAction(rid, 'typing_on'), 'outside_window');
  }
  assert.equal(calls.length, 0);
});
await test('window gate: human sends are held to the same window', async () => {
  reset();
  await expectSendError(igSendText('old', 'hello from the owner', { source: 'human' }), 'outside_window');
  assert.equal(calls.length, 0);
});
await test('in window: sends go out with no message tag (never HUMAN_AGENT)', async () => {
  reset();
  const r = await igSendText('fresh', 'hey');
  assert.ok(r.message_id);
  await igSendAudio('fresh', 'https://x/a.m4a');
  await igSendAction('fresh', 'mark_seen');
  assert.equal(calls.length, 3);
  for (const c of calls) { assert.equal(c.body.tag, undefined); assert.notEqual(c.body.messaging_type, 'MESSAGE_TAG'); assert.equal(c.body.recipient.id, 'fresh'); }
});
await test('paused account (needs reconnect) refuses every send', async () => {
  reset(); paused = 'instagram needs reconnect';
  const e = await expectSendError(igSendText('fresh', 'hi'), 'paused');
  assert.equal(e.reason, 'instagram needs reconnect');
  paused = null; assert.equal(calls.length, 0);
});
await test('not connected refuses', async () => {
  reset(); setCredsResolver(() => null);
  await expectSendError(igSendText('fresh', 'hi'), 'not_connected');
  setCredsResolver(() => ({ token: 'tok', businessId: 'biz1' }));
});

// ---- throttle and caps -------------------------------------------------------
await test('throttle: concurrent sends from one account are spaced by the min interval', async () => {
  reset(); process.env.IG_RATE_MIN_INTERVAL_MS = '120';
  await Promise.all([igSendText('fresh', 'a'), igSendText('fresh', 'b', { source: 'human' }), igSendText('fresh', 'c', { source: 'human' })]);
  assert.equal(calls.length, 3);
  const gaps = calls.slice(1).map((c, i) => c.at - calls[i].at);
  for (const g of gaps) assert.ok(g >= 100, 'gap ' + g + 'ms should be >= ~120ms');
  process.env.IG_RATE_MIN_INTERVAL_MS = '0';
});
await test('throttle: a send that would wait longer than the queue limit is refused, not queued', async () => {
  reset(); process.env.IG_RATE_MIN_INTERVAL_MS = '500'; process.env.IG_RATE_MAX_QUEUE_WAIT_MS = '600';
  const results = await Promise.allSettled([1, 2, 3, 4].map((i) => igSendText('fresh', 'm' + i, { source: 'human' })));
  const refused = results.filter((r) => r.status === 'rejected');
  assert.ok(refused.length >= 1, 'at least one refused');
  for (const r of refused) assert.equal(r.reason.kind, 'throttled');
  process.env.IG_RATE_MIN_INTERVAL_MS = '0'; delete process.env.IG_RATE_MAX_QUEUE_WAIT_MS;
});
await test('per account hourly cap', async () => {
  reset(); process.env.IG_RATE_MAX_PER_HOUR = '3';
  for (let i = 0; i < 3; i++) await igSendText('fresh', 'x' + i, { source: 'human' });
  const e = await expectSendError(igSendText('fresh', 'x4', { source: 'human' }), 'account_cap');
  assert.equal(e.park, true); assert.equal(calls.length, 3);
  delete process.env.IG_RATE_MAX_PER_HOUR;
});
await test('per lead hourly cap applies to automated sends, not to the owner', async () => {
  reset(); process.env.IG_RATE_MAX_PER_LEAD_HOUR = '2';
  await igSendText('fresh', 'a'); await igSendText('fresh', 'b', { source: 'followup' });
  await expectSendError(igSendText('fresh', 'c'), 'lead_cap');
  await igSendText('fresh', 'owner typed this', { source: 'human' });
  assert.equal(calls.length, 3);
  delete process.env.IG_RATE_MAX_PER_LEAD_HOUR;
});
await test('account settings can tighten limits but not loosen them past the safe ceiling', () => {
  policy = { minIntervalMs: 10, maxPerHour: 5000, maxPerLeadHour: 999 };
  const p = sendPolicy();
  assert.equal(p.minIntervalMs, 1000); assert.equal(p.maxPerHour, 200); assert.equal(p.maxPerLeadHour, 30);
  policy = { maxPerHour: 20 }; assert.equal(sendPolicy().maxPerHour, 20);
  policy = {};
  const d = sendPolicy(); assert.equal(d.maxPerLeadHour, 10);
});

// ---- Meta error codes --------------------------------------------------------
const graphErr = (code, subcode, message = 'x', type = 'OAuthException') => ({ error: { message, type, code, error_subcode: subcode } });
await test('classifyGraphError maps Meta codes', () => {
  const k = (status, body) => classifyGraphError(status, JSON.stringify(body)).kind;
  assert.equal(k(400, graphErr(10, 2534022, 'This message is sent outside of allowed window.')), 'outside_window');
  assert.equal(k(403, graphErr(10, 2534022)), 'outside_window', 'a 403 window error is not an auth failure');
  assert.equal(k(400, graphErr(551, 1545041, 'This person isn\'t available right now.')), 'blocked_user');
  assert.equal(k(400, graphErr(100, 2534014, 'No matching user found')), 'blocked_user');
  for (const c of [4, 17, 32, 613, 80002]) assert.equal(k(400, graphErr(c)), 'rate_limit');
  assert.equal(k(429, {}), 'rate_limit');
  assert.equal(k(401, graphErr(190, 463)), 'auth');
  assert.equal(k(400, graphErr(10, null, 'Application does not have permission')), 'permission');
  assert.equal(k(403, graphErr(200)), 'permission');
  assert.equal(k(400, graphErr(368, null, 'temporarily blocked for policy violations')), 'policy_block');
  assert.equal(k(500, graphErr(2, null, 'Service temporarily unavailable')), 'transient');
  assert.equal(k(400, graphErr(100, 33)), 'invalid');
});
await test('outside-window error from Meta parks without flagging the token', async () => {
  reset(); authErrors = [];
  respond = () => ({ status: 403, body: graphErr(10, 2534022, 'This message is sent outside of allowed window.') });
  const e = await expectSendError(igSendText('fresh', 'hi'), 'outside_window');
  assert.equal(e.park, true); assert.equal(e.gate, false); assert.equal(authErrors.length, 0);
});
await test('token error flips the account via onIgAuthError and parks', async () => {
  reset(); authErrors = [];
  respond = () => ({ status: 401, body: graphErr(190, 460, 'Error validating access token') });
  const e = await expectSendError(igSendText('fresh', 'hi'), 'auth');
  assert.equal(e.reason, 'instagram needs reconnect'); assert.equal(authErrors.length, 1);
  respond = () => ({ status: 400, body: graphErr(10, null, 'Application does not have permission for this action') });
  await expectSendError(igSendText('fresh', 'hi'), 'permission'); assert.equal(authErrors.length, 2);
});
await test('blocked lead parks without retry', async () => {
  reset();
  respond = () => ({ status: 400, body: graphErr(551, 1545041) });
  const e = await expectSendError(igSendText('fresh', 'hi'), 'blocked_user');
  assert.equal(e.park, true); assert.equal(calls.length, 1);
});
await test('rate limit from Meta backs off: next sends are refused locally until it expires', async () => {
  reset(); issues = []; process.env.IG_RATE_BACKOFF_MS = '150';
  respond = () => ({ status: 400, body: graphErr(4, null, 'Application request limit reached') });
  await expectSendError(igSendText('fresh', 'hi'), 'rate_limit');
  respond = () => ({ status: 200, body: { message_id: 'ok' } });
  await expectSendError(igSendText('fresh', 'again'), 'backoff');
  assert.equal(calls.length, 1, 'no call during back-off'); assert.deepEqual(issues, ['rate_limit']);
  await sleep(200);
  await igSendText('fresh', 'after back-off'); assert.equal(calls.length, 2);
  process.env.IG_RATE_BACKOFF_MS = '60000';
});
await test('second rate limit doubles the back-off', async () => {
  reset(); process.env.IG_RATE_BACKOFF_MS = '100';
  respond = () => ({ status: 400, body: graphErr(613) });
  await expectSendError(igSendText('fresh', '1'), 'rate_limit');
  await sleep(130);
  await expectSendError(igSendText('fresh', '2'), 'rate_limit');
  await sleep(130);
  await expectSendError(igSendText('fresh', '3'), 'backoff'); // 200ms back-off now
  process.env.IG_RATE_BACKOFF_MS = '60000';
});
await test('network failure is kind network (outcome unknown, never retried blindly)', async () => {
  reset();
  respond = () => ({ throw: 'socket hang up' });
  const e = await expectSendError(igSendText('fresh', 'hi'), 'network');
  assert.equal(e.park, true); assert.match(e.reason, /outcome unknown/);
});
reset();

// ---- inbound parsing ---------------------------------------------------------
await test('webhook parse: read/seen, reactions and unsent messages are dropped; echoes are outbound', () => {
  const body = { entry: [{ id: '9', messaging: [
    { sender: { id: '1' }, recipient: { id: '9' }, timestamp: 1, read: { mid: 'r1' } },
    { sender: { id: '1' }, recipient: { id: '9' }, timestamp: 1, reaction: { mid: 'm1', action: 'react', reaction: 'love' } },
    { sender: { id: '1' }, recipient: { id: '9' }, timestamp: 1, message: { mid: 'd1', is_deleted: true } },
    { sender: { id: '9' }, recipient: { id: '1' }, timestamp: 2, message: { mid: 'e1', text: 'echo', is_echo: true } },
    { sender: { id: '1' }, recipient: { id: '9' }, timestamp: 3, message: { mid: 'i1', text: 'hello' } },
  ] }, { id: '9', changes: [{ field: 'messaging_seen', value: { sender: { id: '1' } } }] }] };
  const ev = igParseInbound(body, () => '9');
  assert.deepEqual(ev.map((e) => [e.direction, e.mid]), [['out', 'e1'], ['in', 'i1']]);
});
await test('scopes are the Instagram Login ones only', () => {
  assert.deepEqual(IG_SCOPES, ['instagram_business_basic', 'instagram_business_manage_messages']);
});

// ---- scheduler ----------------------------------------------------------------
function fakeDeps(over = {}) {
  const log = { delivered: [], drafts: [], flags: [], modes: [], followups: [], reminders: [] };
  const convs = new Map();
  const deps = {
    getConv: (id) => convs.get(id),
    getSettings: () => ({ kill_switch: '0', ...(over.settings || {}) }),
    historyOf: () => [],
    addLeadMessage() {},
    deliver: async (conv, text, source) => { log.delivered.push({ conv: conv.id, text, source }); return over.deliverResult || { ok: true }; },
    deliverVoiceNote: async (conv, audio) => { log.delivered.push({ conv: conv.id, audio }); return over.deliverResult || { ok: true }; },
    storeDraft: (id, msgs, stage, nh, reason) => log.drafts.push({ id, msgs, nh, reason }),
    setStage() {},
    setMode: (id, m) => log.modes.push([id, m]),
    setNeedsHuman: (id, r) => log.flags.push([id, r]),
    incrementAiSends() {},
    setFollowup: (id, n, at) => { log.followups.push([id, n]); const c = convs.get(id); if (c) c.followup_count = n; },
    onLeadMessage() {},
    latestLeadMessageId: () => 1,
    latestLeadText: () => '',
    markKwTriggered() {},
    followupCandidates: () => [...convs.values()],
    lastRole: () => 'setter',
    owedReplyConvs: () => over.owed || [],
    bookedConvs: () => [...convs.values()].filter((c) => c.stage === 'call_booked'),
    markReminderSent: (id, k) => log.reminders.push([id, k]),
    leadSpokeSince: () => false,
    notify() {},
    automationPaused: over.automationPaused,
  };
  return { deps, log, convs };
}
const seqSettings = (delayMin) => ({ seq_lead: JSON.stringify([{ message: 'still keen?', delay_min: delayMin, unit: 'minutes' }, { message: 'last nudge', delay_min: 60, unit: 'minutes' }]) });

await test('scheduler window check matches the gate', () => {
  assert.equal(withinMessagingWindow({ last_lead_message_at: ago(24 * H - 60_000) }), false);
  assert.equal(withinMessagingWindow({ last_lead_message_at: ago(H) }), true);
  assert.equal(WINDOW_REASON, 'outside 24h window');
});
await test('sequence follow-up outside the window: not sent, flagged draft + needs_human outside 24h window', async () => {
  const { deps, log, convs } = fakeDeps({ settings: seqSettings(10) });
  convs.set('c1', { id: 'c1', account_id: 'a', channel: 'instagram', stage: 'lead', mode: 'autopilot', followup_count: 0, last_message_at: ago(20 * 60_000), last_lead_message_at: ago(30 * H) });
  await createScheduler(deps).followupSweep();
  assert.equal(log.delivered.length, 0);
  assert.equal(log.drafts.length, 1); assert.equal(log.drafts[0].nh, true); assert.match(log.drafts[0].reason, /outside 24h window/);
  assert.deepEqual(log.flags, [['c1', 'outside 24h window']]);
  assert.deepEqual(log.followups, [['c1', 1]], 'step consumed so it cannot loop');
});
await test('sequence follow-up in the window is delivered', async () => {
  const { deps, log, convs } = fakeDeps({ settings: seqSettings(10) });
  convs.set('c1', { id: 'c1', account_id: 'a', channel: 'instagram', stage: 'lead', mode: 'autopilot', followup_count: 0, last_message_at: ago(15 * 60_000), last_lead_message_at: ago(H) });
  await createScheduler(deps).followupSweep();
  assert.deepEqual(log.delivered.map((d) => d.text), ['still keen?']);
});
await test('no burst after downtime: an overdue follow-up is parked for review, not sent', async () => {
  const { deps, log, convs } = fakeDeps({ settings: seqSettings(10) });
  // due 10 min after the last message, which was 3h ago: 2h50m overdue
  convs.set('c1', { id: 'c1', account_id: 'a', channel: 'instagram', stage: 'lead', mode: 'autopilot', followup_count: 0, last_message_at: ago(3 * H), last_lead_message_at: ago(4 * H) });
  await createScheduler(deps).followupSweep();
  assert.equal(log.delivered.length, 0);
  assert.equal(log.drafts.length, 1); assert.deepEqual(log.drafts[0].msgs, ['still keen?']); assert.match(log.drafts[0].reason, new RegExp(STALE_REASON));
  assert.equal(log.flags.length, 1); assert.deepEqual(log.followups, [['c1', 1]]);
});
await test('stale limit comes from settings, then env, then 30 minutes', () => {
  assert.equal(staleAfterMs({}), 30 * 60_000);
  assert.equal(staleAfterMs({ stale_send_minutes: '5' }), 5 * 60_000);
  process.env.IG_STALE_SEND_MINUTES = '12'; assert.equal(staleAfterMs({}), 12 * 60_000); delete process.env.IG_STALE_SEND_MINUTES;
});
await test('a parked send from the gate consumes the step and keeps autopilot (no retry storm)', async () => {
  const { deps, log, convs } = fakeDeps({ settings: seqSettings(10), deliverResult: { ok: false, parked: true, reason: 'per lead hourly limit reached, review before sending' } });
  convs.set('c1', { id: 'c1', account_id: 'a', channel: 'instagram', stage: 'lead', mode: 'autopilot', followup_count: 0, last_message_at: ago(15 * 60_000), last_lead_message_at: ago(H) });
  const s = createScheduler(deps);
  await s.followupSweep();
  assert.equal(log.delivered.length, 1); assert.equal(log.modes.length, 0, 'mode untouched');
  assert.deepEqual(log.followups, [['c1', 1]]); assert.equal(log.drafts[0].nh, true);
});
await test('automation paused (needs reconnect): sweep sends nothing and consumes nothing', async () => {
  const { deps, log, convs } = fakeDeps({ settings: seqSettings(10), automationPaused: () => 'instagram needs reconnect' });
  convs.set('c1', { id: 'c1', account_id: 'a', channel: 'instagram', stage: 'lead', mode: 'autopilot', followup_count: 0, last_message_at: ago(15 * 60_000), last_lead_message_at: ago(H) });
  await createScheduler(deps).followupSweep();
  assert.equal(log.delivered.length, 0); assert.equal(log.followups.length, 0);
});
await test('booking reminder outside the window is parked as a flagged draft, not sent', async () => {
  const { deps, log, convs } = fakeDeps({ settings: { booking_reminders: JSON.stringify([{ hours_before: 1, message: 'call soon' }]) } });
  convs.set('c1', { id: 'c1', account_id: 'a', channel: 'instagram', stage: 'call_booked', mode: 'autopilot', call_time: new Date(Date.now() + 50 * 60_000).toISOString(), last_lead_message_at: ago(30 * H) });
  await createScheduler(deps).bookingSweep();
  assert.equal(log.delivered.length, 0); assert.equal(log.drafts.length, 1); assert.match(log.drafts[0].reason, /outside 24h window/);
  assert.deepEqual(log.reminders, [['c1', 1]]);
});
await test('overdue booking reminder after downtime is consumed without sending', async () => {
  const { deps, log, convs } = fakeDeps({ settings: { booking_reminders: JSON.stringify([{ hours_before: 24, message: 'see you tomorrow' }]) } });
  convs.set('c1', { id: 'c1', account_id: 'a', channel: 'instagram', stage: 'call_booked', mode: 'autopilot', call_time: new Date(Date.now() + 2 * H).toISOString(), last_lead_message_at: ago(H) });
  await createScheduler(deps).bookingSweep();
  assert.equal(log.delivered.length, 0); assert.deepEqual(log.reminders, [['c1', 24]]);
});
await test('booking reminder in the window is sent', async () => {
  const { deps, log, convs } = fakeDeps({ settings: { booking_reminders: JSON.stringify([{ hours_before: 1, message: 'call soon' }]) } });
  convs.set('c1', { id: 'c1', account_id: 'a', channel: 'instagram', stage: 'call_booked', mode: 'autopilot', call_time: new Date(Date.now() + 50 * 60_000).toISOString(), last_lead_message_at: ago(H) });
  await createScheduler(deps).bookingSweep();
  assert.deepEqual(log.delivered.map((d) => d.text), ['call soon']);
});
await test('boot rescue: an autopilot reply owed since before downtime is flagged, not fired', async () => {
  process.env.FAST_TIMERS = '1';
  const owed = [{ id: 'c1', account_id: 'a', channel: 'instagram', mode: 'autopilot', handle: 'x', last_lead_message_at: ago(2 * H) }];
  const { deps, log } = fakeDeps({ owed });
  const s = createScheduler(deps); s.start();
  await sleep(1300); s.stop(); delete process.env.FAST_TIMERS;
  assert.deepEqual(log.flags, [['c1', 'reply ' + STALE_REASON]]);
  assert.equal(log.delivered.length, 0);
});
await test('a lead message redelivered long after it was sent is not auto-answered', async () => {
  const { deps, log, convs } = fakeDeps();
  convs.set('c1', { id: 'c1', account_id: 'a', channel: 'instagram', stage: 'lead', mode: 'autopilot', last_lead_message_at: ago(2 * H) });
  const s = createScheduler(deps); s.onInboundLead('c1');
  await sleep(2700); s.stop();
  assert.deepEqual(log.flags, [['c1', 'reply ' + STALE_REASON]]);
});

// ---- guardrails that must still hold ------------------------------------------
await test('max 2 consecutive AI sends: the third inbound turn queues a draft instead of sending', () => {
  const deps = { setNeedsHuman() {}, incrementAiSends() {}, setStage() {} };
  assert.equal(decideAutopilotMove({ messages: ['a'] }, { id: 'c', consecutive_ai_sends: 1 }, deps).action, 'send');
  assert.equal(decideAutopilotMove({ messages: ['a'] }, { id: 'c', consecutive_ai_sends: 2 }, deps).action, 'limit');
  assert.equal(decideAutopilotMove({ messages: ['a'] }, { id: 'c', consecutive_ai_sends: 2 }, deps, { skipConsecutiveLimit: true }).action, 'send');
});
await test('humanizing autopilot delay stays inside the configured response window', () => {
  for (let i = 0; i < 200; i++) {
    const d = autopilotDelayMs({ response_min: '60', response_max: '180' });
    assert.ok(d >= 60_000 && d <= 180_000, String(d));
  }
  for (let i = 0; i < 50; i++) { const d = autopilotDelayMs({}); assert.ok(d >= 30_000 && d <= 90_000); }
  for (let i = 0; i < 50; i++) { const d = autopilotDelayMs({ response_min: '0', response_max: '2' }); assert.ok(d >= 15_000, 'floor ' + d); }
});

// ---- legal pages ---------------------------------------------------------------
await test('privacy policy names the data, purposes, sub-processors, retention, deletion route and company', () => {
  const env = { COMPANY_NAME: 'Lean Test Ltd', COMPANY_EMAIL: 'privacy@example.test', COMPANY_ADDRESS: '1 Test Street, Manchester', COMPANY_NUMBER: '12345678' };
  const html = privacyPage(env);
  for (const s of ['Lean Test Ltd', 'privacy@example.test', '1 Test Street, Manchester', '12345678', 'Instagram scoped user ID', 'username', 'profile name', 'profile pictures', 'Booking information', 'draft replies',
    'Anthropic', 'Railway', 'Groq', 'OpenAI', 'Resend', 'Calendly', 'How long we keep it', '7 days', '/data-deletion', 'UK GDPR', "Information Commissioner", 'instagram_business_manage_messages']) {
    assert.ok(html.includes(s), 'missing: ' + s);
  }
  assert.ok(!/—|&mdash;/.test(html), 'no em dashes');
});
await test('legal pages show clear placeholders when company env is unset and escape values', () => {
  const html = privacyPage({});
  assert.ok(html.includes('[COMPANY_NAME not set')); assert.ok(html.includes('[COMPANY_EMAIL not set')); assert.ok(html.includes('[COMPANY_ADDRESS not set'));
  assert.ok(!privacyPage({ COMPANY_NAME: '<script>x</script>' }).includes('<script>x'));
});
await test('terms and data deletion pages cover the essentials without em dashes', () => {
  const env = { COMPANY_NAME: 'Lean Test Ltd', COMPANY_EMAIL: 'privacy@example.test' };
  const t = termsPage(env); const d = dataDeletionPage(env, 'abc123');
  for (const s of ['Lean Test Ltd', '24 hours', 'England and Wales', 'spam']) assert.ok(t.includes(s), 'terms missing ' + s);
  for (const s of ['privacy@example.test', 'Apps and websites', 'abc123', 'Delete my data']) assert.ok(d.includes(s), 'deletion missing ' + s);
  assert.ok(!/—|&mdash;/.test(t + d));
});

console.log(failed ? `\n${failed} failing` : '\nall green');
process.exit(failed ? 1 : 0);

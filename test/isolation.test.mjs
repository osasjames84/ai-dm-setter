/**
 * Tenant isolation and release gates end to end. Boots server.js on a scratch
 * DATA_DIR with the Instagram and email integrations blanked, signs accounts in
 * through the magic-link flow (links are read from the dev-only server log), and
 * asserts that nothing of one account is visible to the other. The AI provider
 * is a local mock (ANTHROPIC_BASE_URL), so test drives run without any real
 * provider. Later sections boot extra servers to check the legacy PIN switch and
 * production behaviour. Run: npm test
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OWNER = 'owner@example.test';
const TOKEN_KEY = 'ab'.repeat(32);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BLANK = { IG_PAGE_TOKEN: '', IG_VERIFY_TOKEN: '', IG_BUSINESS_ID: '', IG_APP_SECRET: '', IG_APP_ID: '', RESEND_API_KEY: '', SENTRY_DSN: '', BACKUP_S3_BUCKET: '',
  ANTHROPIC_API_KEY: '', ANTHROPIC_BASE_URL: '', NODE_ENV: '', RAILWAY_ENVIRONMENT: '', ALLOW_LEGACY_PIN: '', OPEN_LOGIN_EMAILS: '', OPEN_LOGIN_IN_PRODUCTION: '', ADMIN_PIN: '', TOKEN_ENC_KEY: TOKEN_KEY };

// ---- mock Anthropic: lead persona says hi, the setter books, the grader returns mock.verdict ----
const mock = { verdict: 'pass', calls: 0 };
const mockServer = http.createServer((req, res) => {
  let raw = ''; req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    mock.calls++;
    let body = {}; try { body = JSON.parse(raw); } catch { /* empty */ }
    let text = 'hey, saw your post';
    if (body.output_config) text = JSON.stringify({ messages: ['Love that. Grab a time here: https://cal.example/book?'], stage: 'call_booked', needs_human: false, reason: '', flag_reason_code: '' });
    else if (typeof body.system === 'string' && body.system.startsWith('You review')) text = JSON.stringify({ verdict: mock.verdict, notes: [] });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_mock', type: 'message', role: 'assistant', model: body.model || 'mock', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 5 } }));
  });
});
await new Promise((r) => mockServer.listen(0, '127.0.0.1', r));
const MOCK_URL = `http://127.0.0.1:${mockServer.address().port}`;

/** Boot server.js with extra env; returns { base, data, logLines, proc, kill, exited }. */
async function boot(extra = {}, { expectExit = false } = {}) {
  const port = 5000 + Math.floor(Math.random() * 3000);
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'dmsetter-test-'));
  const logLines = [];
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, ...BLANK, PORT: String(port), DATA_DIR: data, OWNER_EMAIL: OWNER, ...extra } });
  proc.stdout.on('data', (d) => logLines.push(...String(d).split('\n')));
  proc.stderr.on('data', (d) => logLines.push(...String(d).split('\n')));
  const exited = new Promise((r) => proc.on('exit', (code) => r(code)));
  const base = `http://127.0.0.1:${port}`;
  const kill = () => { proc.kill(); fs.rmSync(data, { recursive: true, force: true }); };
  if (expectExit) return { base, data, logLines, proc, kill, exited };
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base + '/health'); if (r.status) return { base, data, logLines, proc, kill, exited }; } catch { /* not yet */ }
    await sleep(200);
  }
  kill();
  throw new Error('server did not start:\n' + logLines.join('\n'));
}

const LINK_RE = /(http:\/\/[^\s]+\/auth\/magic\?token=[A-Za-z0-9_-]+)/;
async function signIn(srv, email) {
  const before = srv.logLines.length;
  const r = await fetch(srv.base + '/api/auth/magic-link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
  assert.equal(r.status, 200);
  let link = null;
  for (let i = 0; i < 50 && !link; i++) { link = srv.logLines.slice(before).map((l) => l.match(LINK_RE)?.[1]).find(Boolean); if (!link) await sleep(100); }
  assert.ok(link, 'magic link logged');
  const page = await fetch(link.replace(/^http:\/\/[^/]+/, srv.base));
  assert.equal(page.status, 200, 'link page shows a continue button without consuming the token');
  const token = new URL(link).searchParams.get('token');
  const r2 = await fetch(srv.base + '/auth/magic', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'token=' + encodeURIComponent(token), redirect: 'manual' });
  const cookie = String(r2.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie.startsWith('dm_session='), 'session cookie set');
  return { cookie, api: apiFor(srv, cookie) };
}
function apiFor(srv, cookie) {
  return async (method, p, body) => {
    const res = await fetch(srv.base + p, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await res.json(); } catch { /* not json */ }
    return { status: res.status, json };
  };
}
/** Open an SSE stream; resolves once "hello" arrives. ended resolves true when the server ends it. */
async function openEvents(srv, cookie) {
  const ac = new AbortController();
  const r = await fetch(srv.base + '/api/events', { headers: { Cookie: cookie }, signal: ac.signal });
  if (r.status !== 200) return { status: r.status, close: () => ac.abort() };
  const reader = r.body.getReader();
  const { value } = await reader.read();
  assert.ok(new TextDecoder().decode(value).includes('event: hello'));
  const ended = (async () => { try { for (;;) { const x = await reader.read(); if (x.done) return true; } } catch { return false; } })();
  return { status: 200, ended, close: () => ac.abort() };
}
const within = (p, ms) => Promise.race([p, sleep(ms).then(() => 'timeout')]);

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const servers = [];
try {
  const srv = await boot({ ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: MOCK_URL, ADMIN_PIN: '4242', SSE_MAX_PER_ACCOUNT: '3', SSE_REVALIDATE_MS: '400',
    RATE_LIMIT_AUTH_IP: '200', RATE_LIMIT_PUBLIC_IP: '500', OPEN_LOGIN_EMAILS: 'open@example.test, not-an-email' });
  servers.push(srv);
  const jd = await signIn(srv, OWNER);
  const other = await signIn(srv, 'second@example.test');
  const me1 = (await jd.api('GET', '/api/me')).json;
  const me2 = (await other.api('GET', '/api/me')).json;
  await jd.api('PUT', '/api/settings', { kill_switch: '1' });   // no autopilot replies from the mock during the inbox checks

  await test('first login is the platform admin on acc_1', () => { assert.equal(me1.account.id, 'acc_1'); assert.equal(me1.user.is_platform_admin, true); });
  await test('second login gets its own pending account', () => { assert.notEqual(me2.account.id, 'acc_1'); assert.equal(me2.account.access_status, 'pending'); assert.equal(me2.user.is_platform_admin, false); });

  // Data in acc_1
  const conv = (await jd.api('POST', '/api/sim/spawn', { handle: 'jd_lead' })).json;
  await jd.api('PUT', '/api/settings', { coach_name: 'JD', prompt_persona: 'You are JD.' });
  await test('acc_1 sees its own conversation', async () => { const r = await jd.api('GET', '/api/conversations'); assert.ok(r.json.some((c) => c.id === conv.id)); });
  await test('second account lists zero conversations', async () => { const r = await other.api('GET', '/api/conversations'); assert.equal(r.status, 200); assert.equal(r.json.length, 0); });
  await test('second account cannot open acc_1 conversation by id', async () => { const r = await other.api('GET', '/api/conversations/' + conv.id); assert.equal(r.status, 404); });
  await test('second account cannot post into acc_1 conversation', async () => { const r = await other.api('POST', '/api/conversations/' + conv.id + '/lead-message', { text: 'hi' }); assert.notEqual(r.status, 200); });
  await test('second account cannot download the platform backup', async () => { const r = await other.api('GET', '/api/backup'); assert.equal(r.status, 403); });
  await test('second account cannot discard or approve drafts of another account by id', async () => {
    for (let id = 1; id <= 5; id++) {
      const d = await other.api('POST', '/api/drafts/' + id + '/discard'); assert.equal(d.status, 404, 'discard ' + id);
      const a = await other.api('POST', '/api/drafts/' + id + '/approve'); assert.notEqual(a.status, 200, 'approve ' + id);
    }
  });
  await test('bulk mode from another account changes nothing in acc_1', async () => {
    const before = (await jd.api('GET', '/api/conversations/' + conv.id)).json;
    const r = await other.api('POST', '/api/conversations/bulk-mode', { ids: [conv.id], mode: 'autopilot' });
    assert.equal(r.status, 200); assert.equal(r.json.updated, 0);
    const after = (await jd.api('GET', '/api/conversations/' + conv.id)).json;
    assert.equal((after.conversation || after).mode, (before.conversation || before).mode);
  });
  await test('prompt starter is only the first account\'s', async () => { const r = await other.api('GET', '/api/prompt-starter'); assert.deepEqual(r.json.sections, {}); });
  await test('settings are separate', async () => { const r = await other.api('GET', '/api/settings'); assert.equal(r.json.settings.coach_name || '', ''); assert.equal(r.json.settings.prompt_persona || '', ''); });
  await test('pending account is refused on AI and go-live routes', async () => { const r = await other.api('POST', '/api/onboarding/go-live'); assert.equal(r.status, 403); });
  await test('pending account cannot start a test drive (approval comes first)', async () => { const r = await other.api('POST', '/api/onboarding/test-drive'); assert.equal(r.status, 403); });
  await test('non-admin cannot list accounts', async () => { const r = await other.api('GET', '/api/admin/accounts'); assert.equal(r.status, 403); });
  await test('admin activates the second account', async () => { const r = await jd.api('PATCH', '/api/admin/accounts/' + me2.account.id + '/access', { status: 'active' }); assert.equal(r.status, 200); });
  await test('template apply fills only the second account', async () => {
    const r = await other.api('POST', '/api/settings/apply-template', { id: 'agency', only_empty: true }); assert.equal(r.status, 200);
    const s1 = (await jd.api('GET', '/api/settings')).json.settings; assert.equal(s1.prompt_persona, 'You are JD.');
  });
  await test('instagram shape is per account and disconnected by default', async () => { const r = await other.api('GET', '/api/me'); assert.equal(r.json.instagram.connected, false); assert.equal(r.json.instagram.oauth_available, false); });
  await test('oauth start reports missing app credentials', async () => { const r = await fetch(srv.base + '/auth/instagram/start', { headers: { Cookie: other.cookie } }); assert.equal(r.status, 503); });
  await test('oauth callback with a bad state redirects with an error', async () => { const r = await fetch(srv.base + '/auth/instagram/callback?code=x&state=nope', { redirect: 'manual' }); assert.equal(r.status, 302); assert.ok(String(r.headers.get('location')).includes('connect_error')); });
  await test('export contains only the owner\'s data', async () => {
    const r = await other.api('GET', '/api/account/export'); assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 300));
    assert.equal(r.json.account.id, me2.account.id); assert.equal(r.json.conversations.length, 0); assert.ok(String(r.json.settings.prompt_persona || '').length > 0, 'persona in export: ' + JSON.stringify(r.json.settings).slice(0, 200));
    const r1 = await jd.api('GET', '/api/account/export'); assert.equal(r1.status, 200, 'acc_1 export: ' + JSON.stringify(r1.json).slice(0, 300)); assert.equal(r1.json.conversations.length, 1);
  });
  await test('ops endpoint is admin only', async () => { assert.equal((await other.api('GET', '/api/admin/ops')).status, 403); assert.equal((await jd.api('GET', '/api/admin/ops')).status, 200); });
  await test('delete needs the owner email as confirmation', async () => { const r = await other.api('DELETE', '/api/account', { confirm: 'wrong' }); assert.equal(r.status, 400); });
  await test('owner deletes the second account; acc_1 untouched; its live stream ends', async () => {
    const ev = await openEvents(srv, other.cookie); assert.equal(ev.status, 200);
    const r = await other.api('DELETE', '/api/account', { confirm: 'second@example.test' }); assert.equal(r.status, 200);
    assert.equal(await within(ev.ended, 3000), true, 'stream ended on account deletion');
    assert.equal((await other.api('GET', '/api/me')).status, 401);
    const list = (await jd.api('GET', '/api/admin/accounts')).json; assert.ok(!list.some((a) => a.id === me2.account.id));
    assert.equal((await jd.api('GET', '/api/conversations')).json.length, 1);
  });
  await test('unread and seen', async () => {
    await jd.api('POST', '/api/conversations/' + conv.id + '/lead-message', { text: 'hello?' });
    let r = await jd.api('GET', '/api/conversations'); const row = r.json.find((c) => c.id === conv.id);
    assert.equal(row.unread, 1); assert.ok(row.waiting_since);
    assert.equal((await jd.api('POST', '/api/conversations/' + conv.id + '/seen')).status, 200);
    r = await jd.api('GET', '/api/conversations'); assert.equal(r.json.find((c) => c.id === conv.id).unread, 0);
  });
  await test('seen with a cursor only acknowledges up to the last displayed message', async () => {
    const unread = async () => (await jd.api('GET', '/api/conversations')).json.find((c) => c.id === conv.id).unread;
    await jd.api('POST', '/api/conversations/' + conv.id + '/lead-message', { text: 'first' });
    const shown = (await jd.api('GET', '/api/conversations/' + conv.id)).json.messages;
    const lastShown = shown.at(-1); assert.ok(lastShown.id, 'thread messages carry ids');
    await sleep(15);
    await jd.api('POST', '/api/conversations/' + conv.id + '/lead-message', { text: 'arrived after render' });
    assert.equal(await unread(), 2);
    assert.equal((await jd.api('POST', '/api/conversations/' + conv.id + '/seen', { message_id: lastShown.id })).status, 200);
    assert.equal(await unread(), 1, 'the newer message stays unread');
    // an older cursor never moves the mark backwards
    assert.equal((await jd.api('POST', '/api/conversations/' + conv.id + '/seen', { message_id: shown[0].id })).status, 200);
    assert.equal(await unread(), 1);
    // a timestamp cursor works too, and a future one is clamped to now
    assert.equal((await jd.api('POST', '/api/conversations/' + conv.id + '/seen', { at: new Date(Date.now() + 86400_000).toISOString() })).status, 200);
    assert.equal(await unread(), 0);
    assert.equal((await jd.api('POST', '/api/conversations/' + conv.id + '/seen', { message_id: 999999 })).status, 400);
    assert.equal((await jd.api('POST', '/api/conversations/' + conv.id + '/seen', { at: 'yesterday-ish' })).status, 400);
  });
  await test('prompt versions record on change, not on no-op saves', async () => {
    const before = (await jd.api('GET', '/api/prompt/versions')).json.length;
    await jd.api('PUT', '/api/settings', { prompt_persona: 'You are JD.' });
    assert.equal((await jd.api('GET', '/api/prompt/versions')).json.length, before);
    await jd.api('PUT', '/api/settings', { prompt_persona: 'You are JD, version two.' });
    const list = (await jd.api('GET', '/api/prompt/versions')).json; assert.equal(list.length, before + 1); assert.equal(list[0].current, true);
    const r = await jd.api('POST', '/api/prompt/versions/' + list[1].version + '/restore'); assert.equal(r.status, 200);
    assert.equal((await jd.api('GET', '/api/settings')).json.settings.prompt_persona, 'You are JD.');
  });
  await test('analytics, health and admin overview answer', async () => {
    assert.equal((await jd.api('GET', '/api/analytics?days=7')).json.window_days, 7);
    assert.equal((await fetch(srv.base + '/health').then((r) => r.json())).ok, true);
    const o = await jd.api('GET', '/api/admin/accounts/acc_1/overview'); assert.equal(o.status, 200); assert.equal(o.json.account.id, 'acc_1'); assert.ok(Array.isArray(o.json.recent_conversations));
  });
  await test('analytics buckets lead messages by the account timezone and names it', async () => {
    await jd.api('PUT', '/api/settings', { timezone: 'Asia/Kolkata' });
    const a = (await jd.api('GET', '/api/analytics?days=7')).json;
    assert.equal(a.timezone, 'Asia/Kolkata'); assert.equal(a.timezone_source, 'account');
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
    assert.ok(a.lead_messages_by_hour[hour] >= 1 || a.lead_messages_by_hour[(hour + 23) % 24] >= 1, 'bucketed in Kolkata hours: ' + JSON.stringify(a.lead_messages_by_hour));
    await jd.api('PUT', '/api/settings', { timezone: 'Not/AZone' });
    const b = (await jd.api('GET', '/api/analytics?days=7')).json;
    assert.equal(b.timezone_source, 'server'); assert.ok(b.timezone);
  });
  await test('events stream says hello', async () => {
    const ev = await openEvents(srv, jd.cookie); assert.equal(ev.status, 200); ev.close();
  });
  await test('meta data-deletion callback rejects an unsigned request', async () => {
    const r = await fetch(srv.base + '/webhook/meta/data-deletion', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'signed_request=abc.def' }); assert.equal(r.status, 400);
  });
  await test('acc_1 cannot be deleted', async () => { const r = await jd.api('DELETE', '/api/account', { confirm: OWNER }); assert.equal(r.status, 400); });
  await test('PIN header no longer authenticates by default', async () => {
    const r = await fetch(srv.base + '/api/me', { headers: { 'x-admin-pin': '4242' } }); assert.equal(r.status, 401);
    // anonymous checks never lock anyone out
    for (let i = 0; i < 8; i++) await fetch(srv.base + '/api/me', { headers: { 'x-admin-pin': 'nope' } });
    assert.equal((await fetch(srv.base + '/api/me')).status, 401);
  });

  // ---------- go-live gates on a fresh account ----------
  const GATE = 'gate@example.test';
  const g = await signIn(srv, GATE);
  const meG = (await g.api('GET', '/api/me')).json;
  await jd.api('PATCH', '/api/admin/accounts/' + meG.account.id + '/access', { status: 'active' });
  await g.api('POST', '/api/settings/apply-template', { id: 'agency', only_empty: true });
  await g.api('PUT', '/api/settings', { next_step_type: 'call', calendar_link: 'https://cal.example/gate' });
  const onboarding = async () => (await g.api('GET', '/api/onboarding')).json;
  const drive = async (body) => { const r = await g.api('POST', '/api/onboarding/test-drive?wait=1', body); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
  const sections = (o) => o.go_live.blockers.map((b) => b.section).sort();

  await test('template apply records a prompt version', async () => {
    const v = (await g.api('GET', '/api/prompt/versions')).json; assert.ok(v.length >= 1); assert.match(v.at(-1).note, /template/);
  });
  await test('forged test-drive settings are stripped', async () => {
    const o = await onboarding();
    const r = await g.api('PUT', '/api/settings', { test_drive_passed_at: new Date().toISOString(), test_drive_passed_version: String(o.test_drive.prompt_version) });
    assert.equal(r.status, 200); assert.deepEqual(r.json.ignored.sort(), ['test_drive_passed_at', 'test_drive_passed_version']);
    assert.equal(r.json.settings.test_drive_passed_at, ''); assert.equal((await onboarding()).steps.test_drive, false);
  });
  await test('kill switch cannot be turned off through settings before go-live gates pass', async () => {
    const r = await g.api('PUT', '/api/settings', { kill_switch: '0', coach_name: 'Gate' });
    assert.equal(r.status, 409); assert.ok(r.json.checks.some((c) => c.section === 'instagram'));
    const s = (await g.api('GET', '/api/settings')).json.settings; assert.equal(s.kill_switch, '1'); assert.notEqual(s.coach_name, 'Gate', 'nothing saved on a refused request');
  });
  await test('go-live refused without Instagram and a test drive', async () => {
    const r = await g.api('POST', '/api/onboarding/go-live'); assert.equal(r.status, 400);
    assert.deepEqual(r.json.checks.map((c) => c.section).sort(), ['instagram', 'test_drive']);
    const o = await onboarding(); assert.equal(o.go_live.ready, false); assert.equal(o.steps.live, false);
  });
  // Connect Instagram the way OAuth would leave it (an encrypted token row), straight in the database.
  {
    process.env.TOKEN_ENC_KEY = TOKEN_KEY;
    const { initCrypto, encrypt } = await import('../lib/crypto.js');
    initCrypto(srv.data);
    const db = new DatabaseSync(path.join(srv.data, 'dmsetter.sqlite'));
    db.exec('PRAGMA busy_timeout=5000');
    const now = new Date().toISOString();
    db.prepare("INSERT INTO instagram_accounts (account_id, business_id, username, token_enc, expires_at, status, updated_at, last_refresh_at) VALUES (?, '1789000111', 'gate_ig', ?, ?, 'connected', ?, ?)")
      .run(meG.account.id, encrypt('fake-token-never-used'), new Date(Date.now() + 50 * 86400_000).toISOString(), now, now);
    db.close();
  }
  await test('instagram connected leaves only the test drive blocking', async () => {
    const o = await onboarding(); assert.equal(o.steps.instagram, true); assert.deepEqual(sections(o), ['test_drive']);
  });
  await test('a partial test drive does not count', async () => {
    const j = await drive({ persona_ids: ['warm_keyword'] });
    assert.equal(j.status, 'done'); assert.equal(j.passed, true); assert.equal(j.counts_for_go_live, false);
    assert.equal((await onboarding()).steps.test_drive, false);
  });
  await test('a failed test drive does not count', async () => {
    mock.verdict = 'fail';
    const j = await drive(); mock.verdict = 'pass';
    assert.equal(j.passed, false); assert.equal(j.counts_for_go_live, false); assert.equal((await onboarding()).steps.test_drive, false);
  });
  let passedVersion = null;
  await test('a full passing test drive is bound to the current prompt version', async () => {
    const j = await drive(); assert.equal(j.counts_for_go_live, true);
    const o = await onboarding(); assert.equal(o.steps.test_drive, true); assert.equal(o.test_drive.passed_version, o.test_drive.prompt_version); assert.equal(j.prompt_version, o.test_drive.prompt_version);
    assert.equal(o.go_live.ready, true); passedVersion = o.test_drive.passed_version;
  });
  await test('a script change makes the pass stale and blocks go-live', async () => {
    await g.api('PUT', '/api/settings', { prompt_persona: 'You are the Gate agency, rewritten.' });
    const o = await onboarding(); assert.equal(o.steps.test_drive, false); assert.equal(o.test_drive_stale, true); assert.equal(o.test_drive.passed_version, passedVersion);
    const r = await g.api('POST', '/api/onboarding/go-live'); assert.equal(r.status, 400); assert.deepEqual(r.json.checks.map((c) => c.section), ['test_drive']);
  });
  await test('go-live succeeds once every gate passes', async () => {
    await drive();
    const r = await g.api('POST', '/api/onboarding/go-live'); assert.equal(r.status, 200);
    const o = await onboarding(); assert.equal(o.steps.live, true); assert.equal(o.test_drive_stale, false);
  });
  await test('a live account stays live when its script changes, marked stale', async () => {
    await g.api('PUT', '/api/settings', { prompt_offer: 'A new offer line.' });
    const o = await onboarding(); assert.equal(o.steps.live, true); assert.equal(o.test_drive_stale, true);
    assert.equal((await g.api('GET', '/api/settings')).json.settings.kill_switch, '0');
  });
  await test('turning the AI back on after a pause uses the same gates', async () => {
    assert.equal((await g.api('PUT', '/api/settings', { kill_switch: '1' })).status, 200);
    const r = await g.api('PUT', '/api/settings', { kill_switch: '0' }); assert.equal(r.status, 409); assert.ok(r.json.checks.some((c) => c.section === 'test_drive'));
    await drive();
    assert.equal((await g.api('PUT', '/api/settings', { kill_switch: '0' })).status, 200);
  });
  await test('restoring a version invalidates the pass', async () => {
    const list = (await g.api('GET', '/api/prompt/versions')).json;
    const r = await g.api('POST', '/api/prompt/versions/' + list[1].version + '/restore'); assert.equal(r.status, 200);
    const o = await onboarding(); assert.equal(o.steps.test_drive, false); assert.equal(o.test_drive_stale, true);
  });
  await test('a later failed run on the same script withdraws its pass', async () => {
    await drive(); assert.equal((await onboarding()).steps.test_drive, true);
    mock.verdict = 'fail'; await drive(); mock.verdict = 'pass';
    const o = await onboarding(); assert.equal(o.steps.test_drive, false); assert.equal(o.test_drive.passed_at, null);
  });

  // ---------- live streams end with the session ----------
  await test('logout ends that session\'s live stream', async () => {
    const s2 = await signIn(srv, GATE);
    const ev = await openEvents(srv, s2.cookie); assert.equal(ev.status, 200);
    await s2.api('POST', '/api/logout');
    assert.equal(await within(ev.ended, 3000), true);
  });
  await test('logout everywhere ends every session and stream of the user', async () => {
    const s3 = await signIn(srv, GATE);
    const ev = await openEvents(srv, g.cookie); assert.equal(ev.status, 200);
    const r = await s3.api('POST', '/api/logout/all'); assert.equal(r.status, 200); assert.ok(r.json.sessions_closed >= 2);
    assert.equal(await within(ev.ended, 3000), true);
    assert.equal((await g.api('GET', '/api/me')).status, 401);
  });
  await test('a session revoked behind the server\'s back is caught by revalidation', async () => {
    const s = await signIn(srv, 'sweep@example.test');
    const ev = await openEvents(srv, s.cookie); assert.equal(ev.status, 200);
    const db = new DatabaseSync(path.join(srv.data, 'dmsetter.sqlite')); db.exec('PRAGMA busy_timeout=5000');
    db.prepare("DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = 'sweep@example.test')").run(); db.close();
    assert.equal(await within(ev.ended, 3000), true);
  });
  await test('setters can pause the AI but cannot change settings, go live or switch the AI back on', async () => {
    const own = await signIn(srv, 'teamowner@example.test');
    assert.equal((await own.api('POST', '/api/team/invite', { email: 'teamsetter@example.test', role: 'setter' })).status, 200);
    const st = await signIn(srv, 'teamsetter@example.test');
    const pause = await st.api('POST', '/api/kill-switch', { on: true }); assert.equal(pause.status, 200); assert.equal(pause.json.kill_switch, '1');
    assert.equal((await st.api('POST', '/api/kill-switch', { on: false })).status, 403);
    assert.equal((await st.api('PUT', '/api/settings', { coach_name: 'x' })).status, 403);
    assert.equal((await st.api('POST', '/api/onboarding/go-live')).status, 403);
    assert.equal((await st.api('POST', '/api/settings/apply-template', { id: 'agency', only_empty: false })).status, 403);
    assert.equal((await st.api('GET', '/api/backup')).status, 403);
    const off = await own.api('POST', '/api/kill-switch', { on: false }); assert.notEqual(off.status, 200, 'pending owner cannot go live through the kill switch');
  });
  await test('autopilot response time is clamped to the 15s floor and max stays at or above min', async () => {
    const own = await signIn(srv, 'teamowner@example.test');
    assert.equal((await own.api('PUT', '/api/settings', { response_min: '0', response_max: '5' })).status, 200);
    const s = (await own.api('GET', '/api/settings')).json.settings;
    assert.equal(s.response_min, '15'); assert.equal(s.response_max, '15');
    assert.equal((await own.api('PUT', '/api/settings', { response_min: '50', response_max: '20' })).status, 200);
    const s2 = (await own.api('GET', '/api/settings')).json.settings;
    assert.equal(s2.response_min, '50'); assert.equal(s2.response_max, '50');
  });
  await test('removing a team member ends their stream', async () => {
    assert.equal((await jd.api('POST', '/api/team/invite', { email: 'member@example.test', role: 'setter' })).status, 200);
    const m = await signIn(srv, 'member@example.test');
    const ev = await openEvents(srv, m.cookie); assert.equal(ev.status, 200);
    const id = (await jd.api('GET', '/api/team')).json.find((u) => u.email === 'member@example.test').id;
    assert.equal((await jd.api('DELETE', '/api/team/' + id)).status, 200);
    assert.equal(await within(ev.ended, 3000), true);
  });
  await test('live connections are capped per account', async () => {
    const open = [];
    for (let i = 0; i < 3; i++) { const ev = await openEvents(srv, jd.cookie); assert.equal(ev.status, 200); open.push(ev); }
    const over = await openEvents(srv, jd.cookie); assert.equal(over.status, 429); over.close();
    open.pop().close(); await sleep(200);
    const again = await openEvents(srv, jd.cookie); assert.equal(again.status, 200); open.push(again);
    for (const ev of open) ev.close();
  });

  // ---------- open sign-in (OPEN_LOGIN_EMAILS) and rate limits ----------
  await test('open sign-in: exact normalised match only, audited', async () => {
    const r = await fetch(srv.base + '/api/auth/magic-link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: '  OPEN@example.test ' }) });
    const j = await r.json(); assert.equal(j.signed_in, true); assert.ok(String(r.headers.get('set-cookie')).startsWith('dm_session='));
    const open = apiFor(srv, String(r.headers.get('set-cookie')).split(';')[0]);
    const acc = (await open('GET', '/api/me')).json.account.id;
    const auditRows = (await jd.api('GET', '/api/admin/accounts/' + acc + '/audit')).json; assert.ok(auditRows.some((a) => a.action === 'auth:open-login'));
    for (const near of ['xopen@example.test', 'open@example.test.evil', 'open@example']) {
      const x = await fetch(srv.base + '/api/auth/magic-link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: near }) });
      const xj = await x.json().catch(() => ({})); assert.notEqual(xj.signed_in, true, near); assert.equal(x.headers.get('set-cookie'), null, near);
    }
  });
  await test('magic-link requests are rate limited per email', async () => {
    const ask = () => fetch(srv.base + '/api/auth/magic-link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'flood@example.test' }) });
    for (let i = 0; i < 5; i++) assert.equal((await ask()).status, 200);
    const r = await ask(); assert.equal(r.status, 429); assert.ok(Number(r.headers.get('retry-after')) > 0);
  });
  await test('dev log line says the link is dev only', async () => {
    assert.ok(srv.logLines.some((l) => /DEV ONLY, no mail provider configured/.test(l) && LINK_RE.test(l)));
  });

  // ---------- legacy PIN opt-in ----------
  const pinSrv = await boot({ ALLOW_LEGACY_PIN: '1', ADMIN_PIN: '4242' });
  servers.push(pinSrv);
  await test('ALLOW_LEGACY_PIN=1 maps the PIN header to acc_1', async () => {
    const r = await fetch(pinSrv.base + '/api/me', { headers: { 'x-admin-pin': '4242' } }); assert.equal(r.status, 200); assert.equal((await r.json()).account.id, 'acc_1');
    assert.equal((await fetch(pinSrv.base + '/api/me', { headers: { 'x-admin-pin': '0000' } })).status, 401);
  });
  await test('test drive refuses without AI configured', async () => {
    const r = await fetch(pinSrv.base + '/api/onboarding/test-drive', { method: 'POST', headers: { 'x-admin-pin': '4242', 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(r.status, 503);
  });

  // ---------- production boot ----------
  const prod = await boot({ NODE_ENV: 'production', RATE_LIMIT_AUTH_IP: '3', OPEN_LOGIN_EMAILS: 'open@example.test' });
  servers.push(prod);
  await test('production boots without ADMIN_PIN when the PIN is off', async () => { assert.equal((await fetch(prod.base + '/health').then((r) => r.json())).ok, true); });
  await test('production: failed mail delivery is a clean error and nothing is logged', async () => {
    const r = await fetch(prod.base + '/api/auth/magic-link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'someone@example.test' }) });
    assert.equal(r.status, 503); assert.ok((await r.json()).error);
    await sleep(200);
    assert.ok(!prod.logLines.some((l) => /token=/.test(l)), 'no token in production logs');
  });
  await test('production: unsigned Instagram webhooks are rejected when no app secret is set', async () => {
    const r = await fetch(prod.base + '/webhook/instagram', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ object: 'instagram', entry: [] }) });
    assert.equal(r.status, 403);
  });
  await test('production: open sign-in is ignored unless explicitly allowed', async () => {
    const r = await fetch(prod.base + '/api/auth/magic-link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'open@example.test' }) });
    assert.equal(r.status, 503); assert.equal(r.headers.get('set-cookie'), null);
  });
  await test('magic-link requests are rate limited per IP', async () => {
    const r = await fetch(prod.base + '/api/auth/magic-link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'third@example.test' }) });
    assert.equal(r.status, 503);
    const r2 = await fetch(prod.base + '/api/auth/magic-link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'fourth@example.test' }) });
    assert.equal(r2.status, 429);
  });
  const prodPin = await boot({ NODE_ENV: 'production', ALLOW_LEGACY_PIN: '1' }, { expectExit: true });
  servers.push(prodPin);
  await test('production refuses the legacy PIN without ADMIN_PIN', async () => {
    const code = await within(prodPin.exited, 15000); assert.equal(code, 1);
  });
} catch (e) {
  failed++; console.log('  FAIL setup: ' + e.message);
} finally {
  for (const s of servers) s.kill();
  mockServer.close();
}
console.log(failed ? `\n${failed} failing` : '\nall green');
process.exit(failed ? 1 : 0);

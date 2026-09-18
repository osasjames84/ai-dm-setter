/**
 * Tenant isolation end to end. Boots server.js on a scratch DATA_DIR with the
 * Instagram and email integrations blanked, signs two accounts in through the
 * magic-link flow (links are read from the server log), and asserts that nothing
 * of one account is visible to the other. Run: npm test
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const PORT = 5000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'dmsetter-test-'));
const OWNER = 'owner@example.test';
const logLines = [];

const env = { ...process.env, PORT: String(PORT), DATA_DIR: DATA, OWNER_EMAIL: OWNER, ADMIN_PIN: '4242',
  IG_PAGE_TOKEN: '', IG_VERIFY_TOKEN: '', IG_BUSINESS_ID: '', IG_APP_SECRET: '', IG_APP_ID: '', RESEND_API_KEY: '', SENTRY_DSN: '', BACKUP_S3_BUCKET: '', ANTHROPIC_API_KEY: '' };
const server = spawn(process.execPath, ['server.js'], { cwd: fileURLToPath(new URL('..', import.meta.url)), env });
server.stdout.on('data', (d) => logLines.push(...String(d).split('\n')));
server.stderr.on('data', (d) => logLines.push(...String(d).split('\n')));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUp() {
  for (let i = 0; i < 100; i++) { try { const r = await fetch(BASE + '/api/templates'); if (r.status) return; } catch { /* not yet */ } await sleep(200); }
  throw new Error('server did not start:\n' + logLines.join('\n'));
}
async function signIn(email) {
  const before = logLines.length;
  const r = await fetch(BASE + '/api/auth/magic-link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
  assert.equal(r.status, 200);
  let link = null;
  for (let i = 0; i < 50 && !link; i++) { link = logLines.slice(before).map((l) => l.match(/(http:\/\/[^\s]+\/auth\/magic\?token=[^\s]+)/)?.[1]).find(Boolean); if (!link) await sleep(100); }
  assert.ok(link, 'magic link logged');
  const page = await fetch(link.replace(/^http:\/\/[^/]+/, BASE));
  assert.equal(page.status, 200, 'link page shows a continue button without consuming the token');
  const token = new URL(link).searchParams.get('token');
  const r2 = await fetch(BASE + '/auth/magic', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'token=' + encodeURIComponent(token), redirect: 'manual' });
  const cookie = String(r2.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie.startsWith('dm_session='), 'session cookie set');
  const api = async (method, p, body) => {
    const res = await fetch(BASE + p, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await res.json(); } catch { /* not json */ }
    return { status: res.status, json };
  };
  return { cookie, api };
}

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

try {
  await waitUp();
  const jd = await signIn(OWNER);
  const other = await signIn('second@example.test');
  const me1 = (await jd.api('GET', '/api/me')).json;
  const me2 = (await other.api('GET', '/api/me')).json;

  await test('first login is the platform admin on acc_1', () => { assert.equal(me1.account.id, 'acc_1'); assert.equal(me1.user.is_platform_admin, true); });
  await test('second login gets its own pending account', () => { assert.notEqual(me2.account.id, 'acc_1'); assert.equal(me2.account.access_status, 'pending'); assert.equal(me2.user.is_platform_admin, false); });

  // Data in acc_1
  const conv = (await jd.api('POST', '/api/sim/spawn', { handle: 'jd_lead' })).json;
  await jd.api('PUT', '/api/settings', { coach_name: 'JD', prompt_persona: 'You are JD.' });
  await test('acc_1 sees its own conversation', async () => { const r = await jd.api('GET', '/api/conversations'); assert.ok(r.json.some((c) => c.id === conv.id)); });
  await test('second account lists zero conversations', async () => { const r = await other.api('GET', '/api/conversations'); assert.equal(r.status, 200); assert.equal(r.json.length, 0); });
  await test('second account cannot open acc_1 conversation by id', async () => { const r = await other.api('GET', '/api/conversations/' + conv.id); assert.equal(r.status, 404); });
  await test('second account cannot post into acc_1 conversation', async () => { const r = await other.api('POST', '/api/conversations/' + conv.id + '/lead-message', { text: 'hi' }); assert.notEqual(r.status, 200); });
  await test('settings are separate', async () => { const r = await other.api('GET', '/api/settings'); assert.equal(r.json.settings.coach_name || '', ''); assert.equal(r.json.settings.prompt_persona || '', ''); });
  await test('pending account is refused on AI and go-live routes', async () => { const r = await other.api('POST', '/api/onboarding/go-live'); assert.equal(r.status, 403); });
  await test('non-admin cannot list accounts', async () => { const r = await other.api('GET', '/api/admin/accounts'); assert.equal(r.status, 403); });
  await test('admin activates the second account', async () => { const r = await jd.api('PATCH', '/api/admin/accounts/' + me2.account.id + '/access', { status: 'active' }); assert.equal(r.status, 200); });
  await test('template apply fills only the second account', async () => {
    const r = await other.api('POST', '/api/settings/apply-template', { id: 'agency', only_empty: true }); assert.equal(r.status, 200);
    const s1 = (await jd.api('GET', '/api/settings')).json.settings; assert.equal(s1.prompt_persona, 'You are JD.');
  });
  await test('instagram shape is per account and disconnected by default', async () => { const r = await other.api('GET', '/api/me'); assert.equal(r.json.instagram.connected, false); assert.equal(r.json.instagram.oauth_available, false); });
  await test('oauth start reports missing app credentials', async () => { const r = await fetch(BASE + '/auth/instagram/start', { headers: { Cookie: other.cookie } }); assert.equal(r.status, 503); });
  await test('oauth callback with a bad state redirects with an error', async () => { const r = await fetch(BASE + '/auth/instagram/callback?code=x&state=nope', { redirect: 'manual' }); assert.equal(r.status, 302); assert.ok(String(r.headers.get('location')).includes('connect_error')); });
  await test('test drive refuses without AI configured', async () => { const r = await other.api('POST', '/api/onboarding/test-drive'); assert.equal(r.status, 503); });
  await test('export contains only the owner\'s data', async () => {
    const r = await other.api('GET', '/api/account/export'); assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 300)); if (!r.json.conversations) console.log('       export keys:', Object.keys(r.json), JSON.stringify(r.json).slice(0, 200));
    assert.equal(r.json.account.id, me2.account.id); assert.equal(r.json.conversations.length, 0); assert.ok(String(r.json.settings.prompt_persona || '').length > 0, 'persona in export: ' + JSON.stringify(r.json.settings).slice(0, 200));
    const r1 = await jd.api('GET', '/api/account/export'); assert.equal(r1.status, 200, 'acc_1 export: ' + JSON.stringify(r1.json).slice(0, 300)); assert.equal(r1.json.conversations.length, 1);
  });
  await test('ops endpoint is admin only', async () => { assert.equal((await other.api('GET', '/api/admin/ops')).status, 403); assert.equal((await jd.api('GET', '/api/admin/ops')).status, 200); });
  await test('delete needs the owner email as confirmation', async () => { const r = await other.api('DELETE', '/api/account', { confirm: 'wrong' }); assert.equal(r.status, 400); });
  await test('owner deletes the second account; acc_1 untouched', async () => {
    const r = await other.api('DELETE', '/api/account', { confirm: 'second@example.test' }); assert.equal(r.status, 200);
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
    assert.equal((await fetch(BASE + '/health').then((r) => r.json())).ok, true);
    const o = await jd.api('GET', '/api/admin/accounts/acc_1/overview'); assert.equal(o.status, 200); assert.equal(o.json.account.id, 'acc_1'); assert.ok(Array.isArray(o.json.recent_conversations));
  });
  await test('events stream says hello', async () => {
    const ac = new AbortController();
    const r = await fetch(BASE + '/api/events', { headers: { Cookie: jd.cookie }, signal: ac.signal });
    assert.equal(r.headers.get('content-type'), 'text/event-stream');
    const reader = r.body.getReader(); const { value } = await reader.read(); assert.ok(new TextDecoder().decode(value).includes('event: hello')); ac.abort();
  });
  await test('meta data-deletion callback rejects an unsigned request', async () => {
    const r = await fetch(BASE + '/webhook/meta/data-deletion', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'signed_request=abc.def' }); assert.equal(r.status, 400);
  });
  await test('acc_1 cannot be deleted', async () => { const r = await jd.api('DELETE', '/api/account', { confirm: OWNER }); assert.equal(r.status, 400); });
  await test('PIN header still maps to acc_1', async () => { const r = await fetch(BASE + '/api/me', { headers: { 'x-admin-pin': '4242' } }); assert.equal(r.status, 200); assert.equal((await r.json()).account.id, 'acc_1'); });
} catch (e) {
  failed++; console.log('  FAIL setup: ' + e.message);
} finally {
  server.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} failing` : '\nall green');
process.exit(failed ? 1 : 0);

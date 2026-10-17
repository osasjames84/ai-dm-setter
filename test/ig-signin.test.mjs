/**
 * "Continue with Instagram" end to end. Boots server.js against a local STUB of
 * Instagram's OAuth and Graph hosts (IG_API_BASE, IG_GRAPH_BASE), on a scratch
 * DATA_DIR, and walks the sign-in flow over HTTP: a new Instagram account gets a
 * pending workspace with no email, a returning one signs back into the same
 * workspace, the env-token account signs into the first workspace as its owner,
 * and connect mode still refuses an Instagram account another workspace owns.
 * Run: npm test
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OWNER = 'owner@example.test';
const ENV_BIZ = '17841400000000111';   // the first account's env-token Instagram account
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- stub Instagram: each OAuth "code" names an identity -------------------
const IDS = {
  newcoach: { appScoped: '900000000000001', biz: '17841400000000222', username: 'newcoach' },
  jd: { appScoped: '900000000000002', biz: ENV_BIZ, username: 'jd.osas' },
};
const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'POST' && url.pathname === '/oauth/access_token') {
      const code = new URLSearchParams(raw).get('code');
      const id = IDS[code];
      if (!id) return json(400, { error_message: 'Invalid authorization code' });
      return json(200, { access_token: 'short-' + code, user_id: id.appScoped, permissions: ['instagram_business_basic', 'instagram_business_manage_messages'] });
    }
    if (req.method === 'GET' && url.pathname === '/access_token') {
      return json(200, { access_token: 'long-' + String(url.searchParams.get('access_token')).replace(/^short-/, ''), expires_in: 5184000 });
    }
    if (req.method === 'GET' && url.pathname === '/me') {
      const id = IDS[String(url.searchParams.get('access_token')).replace(/^long-/, '')];
      return id ? json(200, { id: id.appScoped, user_id: id.biz, username: id.username }) : json(400, { error: { message: 'bad token', code: 190 } });
    }
    if (req.method === 'POST' && /^\/\d+\/subscribed_apps$/.test(url.pathname)) return json(200, { success: true });
    json(200, {});
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const STUB = `http://127.0.0.1:${stub.address().port}`;

const PORT = 7000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'dmsetter-igsignin-'));
const env = {
  ...process.env, PORT: String(PORT), DATA_DIR: DATA, OWNER_EMAIL: OWNER, PUBLIC_BASE_URL: BASE,
  IG_APP_ID: '1364328885802225', IG_APP_SECRET: 'test-ig-secret', IG_GRAPH_BASE: STUB, IG_API_BASE: STUB,
  IG_BUSINESS_ID: ENV_BIZ, IG_PAGE_TOKEN: 'env-token', IG_VERIFY_TOKEN: 'verify-me',
  META_APP_SECRET: '', ANTHROPIC_API_KEY: '', RESEND_API_KEY: '', SENTRY_DSN: '', BACKUP_S3_BUCKET: '', FB_PAGE_ID: '', FB_PAGE_TOKEN: '',
  NODE_ENV: '', RAILWAY_ENVIRONMENT: '', ALLOW_LEGACY_PIN: '', OPEN_LOGIN_EMAILS: '', TOKEN_ENC_KEY: 'cd'.repeat(32),
  RATE_LIMIT_PUBLIC_IP: '500', RATE_LIMIT_AUTH_IP: '200',
};
const logLines = [];
const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env });
server.stdout.on('data', (d) => logLines.push(...String(d).split('\n')));
server.stderr.on('data', (d) => logLines.push(...String(d).split('\n')));
for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/health')).status) break; } catch { /* not yet */ } await sleep(200); }

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const api = (cookie) => async (method, p, body) => {
  const res = await fetch(BASE + p, { method, headers: { Cookie: cookie || '', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json };
};
/** Start an Instagram OAuth round trip (sign-in, or connect with a cookie) and return its state. */
async function startState(pathname, cookie) {
  const r = await fetch(BASE + pathname, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get('location'));
  assert.equal(loc.host, 'www.instagram.com');
  assert.equal(loc.searchParams.get('redirect_uri'), BASE + '/auth/instagram/callback');
  assert.equal(loc.searchParams.get('scope'), 'instagram_business_basic,instagram_business_manage_messages');
  return loc.searchParams.get('state');
}
async function callback(state, code) {
  const r = await fetch(`${BASE}/auth/instagram/callback?code=${code}&state=${state}`, { redirect: 'manual' });
  return { status: r.status, location: r.headers.get('location'), cookie: String(r.headers.get('set-cookie') || '').split(';')[0] };
}
async function signInWith(code) { return callback(await startState('/auth/instagram/login'), code); }

try {
  let coachCookie = '', coachAccount = '';
  await test('sign-in options report Instagram login when the app is configured', async () => {
    assert.deepEqual((await api()('GET', '/api/auth/options')).json, { instagram_login: true });
  });
  await test('a new Instagram account gets a pending workspace, connected, with no email yet', async () => {
    const r = await signInWith('newcoach');
    assert.equal(r.location, '/?signed_in=instagram&new=1');
    assert.ok(r.cookie.startsWith('dm_session='), 'session cookie set');
    coachCookie = r.cookie;
    const me = (await api(coachCookie)('GET', '/api/me')).json;
    coachAccount = me.account.id;
    assert.notEqual(coachAccount, 'acc_1');
    assert.equal(me.account.name, '@newcoach');
    assert.equal(me.account.access_status, 'pending');
    assert.equal(me.user.role, 'owner');
    assert.equal(me.user.email, null); assert.equal(me.user.email_missing, true);
    assert.equal(me.instagram.connected, true);
  });
  await test('the same Instagram account signs back into the same workspace', async () => {
    const r = await signInWith('newcoach');
    assert.equal(r.location, '/?signed_in=instagram');
    assert.equal((await api(r.cookie)('GET', '/api/me')).json.account.id, coachAccount);
  });
  await test('an Instagram sign-up can add its email, which must be real and unused', async () => {
    const call = api(coachCookie);
    assert.equal((await call('POST', '/api/me/email', { email: 'nope' })).status, 400);
    assert.equal((await call('POST', '/api/me/email', { email: 'ig-1@instagram.invalid' })).status, 400);
    assert.equal((await call('POST', '/api/me/email', { email: OWNER })).status, 409);
    assert.equal((await call('POST', '/api/me/email', { email: 'coach@example.test' })).status, 200);
    const me = (await call('GET', '/api/me')).json;
    assert.equal(me.user.email, 'coach@example.test'); assert.equal(me.user.email_missing, false);
  });
  await test('magic links are never issued for a placeholder address', async () => {
    const r = await api()('POST', '/api/auth/magic-link', { email: 'ig-17841400000000222@instagram.invalid' });
    assert.equal(r.status, 400);
  });
  await test('the env-token Instagram account signs into the first workspace as its owner', async () => {
    const r = await signInWith('jd');
    assert.equal(r.location, '/?signed_in=instagram');
    const me = (await api(r.cookie)('GET', '/api/me')).json;
    assert.equal(me.account.id, 'acc_1'); assert.equal(me.user.email, OWNER); assert.equal(me.user.is_platform_admin, true);
  });
  await test('connect mode still refuses an Instagram account that belongs to another workspace', async () => {
    const r = await callback(await startState('/auth/instagram/start', coachCookie), 'jd');
    assert.ok(r.location.startsWith('/?connect_error='), r.location);
    assert.equal((await api(coachCookie)('GET', '/api/me')).json.account.id, coachAccount);
  });
  await test('a refused or failed Instagram sign-in returns to the login page with the reason', async () => {
    const denied = await fetch(`${BASE}/auth/instagram/callback?error=access_denied&error_description=User+denied&state=${await startState('/auth/instagram/login')}`, { redirect: 'manual' });
    assert.ok(denied.headers.get('location').startsWith('/?signin_error='));
    assert.ok(!denied.headers.get('set-cookie'), 'no session on failure');
    const bad = await signInWith('unknown-code');
    assert.ok(bad.location.startsWith('/?signin_error='), bad.location);
    const replay = await fetch(`${BASE}/auth/instagram/callback?code=newcoach&state=not-a-state`, { redirect: 'manual' });
    assert.ok(replay.headers.get('location').startsWith('/?connect_error='), 'unknown state never signs anyone in');
    assert.ok(!replay.headers.get('set-cookie'));
  });
  await test('an Instagram-only owner deletes the workspace by typing DELETE', async () => {
    const r = await signInWith('newcoach');
    const call = api(r.cookie);
    // This owner added an email above, so the email is what confirms; prove DELETE alone is refused here.
    assert.equal((await call('DELETE', '/api/account', { confirm: 'DELETE' })).status, 400);
    assert.equal((await call('DELETE', '/api/account', { confirm: 'coach@example.test' })).status, 200);
    const again = await signInWith('newcoach');
    assert.equal(again.location, '/?signed_in=instagram&new=1', 'a deleted workspace is not resurrected; a new one is created');
    const me = (await api(again.cookie)('GET', '/api/me')).json;
    assert.equal((await api(again.cookie)('DELETE', '/api/account', { confirm: 'DELETE' })).status, 200, 'no email: DELETE confirms');
    assert.ok(me.user.email_missing);
  });
} catch (e) {
  failed++; console.log('  FAIL setup: ' + (e.stack || e.message) + '\n' + logLines.slice(-20).join('\n'));
} finally {
  server.kill();
  stub.close();
  fs.rmSync(DATA, { recursive: true, force: true });
}
if (failed && process.env.DEBUG_E2E) console.log(logLines.join('\n'));
console.log(failed ? `\n${failed} failing` : '\nall green');
process.exit(failed ? 1 : 0);

/**
 * Meta compliance end to end. Boots server.js against a local STUB of the
 * Instagram Graph API (IG_GRAPH_BASE), on a scratch DATA_DIR, and drives every
 * outbound path through HTTP: manual inbox sends, draft approval, send-all, the
 * Call Booked VSL (Calendly webhook) and the keyword opener. Checks the 24h
 * window on each, webhook dedupe, idempotent sends (retry, double click,
 * restart mid-send), Meta error handling and the legal pages. No real keys and
 * no live providers. Run: npm test
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 6000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'dmsetter-meta-'));
const SECRET = 'test-app-secret';
const BIZ = '17841400000000999';
const PIN = { 'x-admin-pin': '4242', 'Content-Type': 'application/json' };
const H = 3600_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- stub Graph API ---------------------------------------------------------
const sends = [];
let n = 0;
const graph = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'POST' && url.pathname === '/me/messages') {
      const body = JSON.parse(raw || '{}');
      const rid = body.recipient?.id;
      if (body.sender_action) return json(200, { recipient_id: rid });
      sends.push({ rid, body, at: Date.now() });
      if (rid === 'L_blocked') return json(400, { error: { message: "This person isn't available right now.", type: 'OAuthException', code: 551, error_subcode: 1545041 } });
      if (rid === 'L_auth') return json(401, { error: { message: 'Error validating access token', type: 'OAuthException', code: 190, error_subcode: 460 } });
      if (rid === 'L_rl') return json(400, { error: { message: 'Application request limit reached', type: 'OAuthException', code: 4 } });
      if (rid === 'L_window') return json(400, { error: { message: 'This message is sent outside of allowed window.', type: 'OAuthException', code: 10, error_subcode: 2534022 } });
      if (rid === 'L_hang') { req.socket.destroy(); return; }
      return json(200, { recipient_id: rid, message_id: 'out_' + (++n) });
    }
    if (req.method === 'GET' && url.pathname === '/' + BIZ) return json(200, { id: BIZ, username: 'test_business' });
    if (req.method === 'GET') return json(200, {});
    json(404, { error: { message: 'unknown', code: 100 } });
  });
});
await new Promise((r) => graph.listen(0, '127.0.0.1', r));
const GRAPH_PORT = graph.address().port;

// ---- server ------------------------------------------------------------------
const logLines = [];
const env = {
  ...process.env, PORT: String(PORT), DATA_DIR: DATA, OWNER_EMAIL: 'owner@example.test', ADMIN_PIN: '4242', ALLOW_LEGACY_PIN: '1',
  IG_GRAPH_BASE: `http://127.0.0.1:${GRAPH_PORT}`, IG_PAGE_TOKEN: 'stub-token', IG_BUSINESS_ID: BIZ, IG_VERIFY_TOKEN: 'verify-me',
  IG_APP_SECRET: SECRET, META_APP_SECRET: 'meta-dashboard-secret', IG_APP_ID: '', ANTHROPIC_API_KEY: '', RESEND_API_KEY: '', SENTRY_DSN: '', BACKUP_S3_BUCKET: '', GROQ_API_KEY: '', OPENAI_API_KEY: '',
  FAST_TIMERS: '1', IG_RATE_MIN_INTERVAL_MS: '40', IG_RATE_BACKOFF_MS: '400', PUBLIC_BASE_URL: 'http://127.0.0.1:' + PORT,
  COMPANY_NAME: 'Test Coaching Ltd', COMPANY_EMAIL: 'privacy@example.test', COMPANY_ADDRESS: '', COMPANY_NUMBER: '00000001',
};
let server;
function boot() {
  server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env });
  server.stdout.on('data', (d) => logLines.push(...String(d).split('\n')));
  server.stderr.on('data', (d) => logLines.push(...String(d).split('\n')));
}
async function waitUp() {
  for (let i = 0; i < 100; i++) { try { const r = await fetch(BASE + '/health'); if (r.status) return; } catch { /* not yet */ } await sleep(150); }
  throw new Error('server did not start:\n' + logLines.slice(-30).join('\n'));
}
async function stop() { if (!server) return; const done = new Promise((r) => server.once('exit', r)); server.kill(); await done; server = null; }

const api = async (method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: PIN, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch { /* not json */ }
  return { status: r.status, json };
};
const sign = (raw) => 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
async function webhook(payload, { signed = true } = {}) {
  const raw = JSON.stringify(payload);
  const r = await fetch(BASE + '/webhook/instagram', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(signed ? { 'x-hub-signature-256': sign(raw) } : {}) }, body: raw });
  return r.status;
}
const msgEvent = (lead, mid, text, { ts = Date.now(), echo = false } = {}) => ({
  object: 'instagram',
  entry: [{ id: BIZ, time: Date.now(), messaging: [echo
    ? { sender: { id: BIZ }, recipient: { id: lead }, timestamp: ts, message: { mid, text, is_echo: true } }
    : { sender: { id: lead }, recipient: { id: BIZ }, timestamp: ts, message: { mid, text } }] }],
});
let db;
const openDb = () => { db = new DatabaseSync(path.join(DATA, 'dmsetter.sqlite')); db.exec('PRAGMA busy_timeout=5000'); };
const conv = (lead) => db.prepare("SELECT * FROM conversations WHERE channel = 'instagram' AND external_id = ?").get(lead);
async function until(fn, ms = 4000) { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(50); } return fn(); }
async function lead(id, text = 'hi there', opts = {}) {
  await webhook(msgEvent(id, 'mid_' + id + '_' + crypto.randomBytes(3).toString('hex'), text, opts));
  // Wait until the webhook has fully landed (the window stamp is the last write).
  return until(() => { const c = conv(id); return c && c.last_lead_message_at ? c : null; });
}
const insertDraft = (c, msgs) => Number(db.prepare("INSERT INTO drafts (conversation_id, messages_json, needs_human, reason, status, created_at, account_id) VALUES (?, ?, 0, '', 'pending', ?, 'acc_1')")
  .run(c.id, JSON.stringify(msgs), new Date().toISOString()).lastInsertRowid);
const sendsTo = (rid) => sends.filter((s) => s.rid === rid);

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n       ')); }
}

try {
  boot(); await waitUp(); openDb();

  // ---- inbound: signatures, dedupe, echoes, read events -----------------------
  await test('webhook rejects a bad signature', async () => {
    assert.equal(await webhook(msgEvent('L_x', 'm_bad', 'hi'), { signed: false }), 403);
  });
  await test('webhook signed with the Meta app secret (App settings > Basic) is accepted too', async () => {
    const raw = JSON.stringify(msgEvent('L_sig', 'm_sig', 'hello'));
    const r = await fetch(BASE + '/webhook/instagram', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', 'meta-dashboard-secret').update(raw).digest('hex') }, body: raw });
    assert.equal(r.status, 200);
  });
  await test('a webhook delivered three times (two at once) stores one message', async () => {
    const p = msgEvent('L1', 'mid_dup_1', 'hello, I want to get lean');
    await Promise.all([webhook(p), webhook(p)]); await webhook(p);
    const c = await until(() => conv('L1'));
    await sleep(300);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM messages WHERE conversation_id = ?').get(c.id).n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM ig_inbound_events WHERE event_key = 'mid:mid_dup_1'").get().n, 1);
    assert.ok(c.last_lead_message_at, 'window opened by the lead');
  });
  await test('read receipts and reactions are ignored; an owner echo is stored without any send', async () => {
    const before = sends.length;
    const c = conv('L1');
    const count = () => db.prepare('SELECT COUNT(*) n FROM messages WHERE conversation_id = ?').get(c.id).n;
    const was = count();
    await webhook({ object: 'instagram', entry: [{ id: BIZ, messaging: [{ sender: { id: 'L1' }, recipient: { id: BIZ }, timestamp: Date.now(), read: { mid: 'mid_dup_1' } }] }] });
    await webhook({ object: 'instagram', entry: [{ id: BIZ, messaging: [{ sender: { id: 'L1' }, recipient: { id: BIZ }, timestamp: Date.now(), reaction: { mid: 'mid_dup_1', action: 'react', reaction: 'love' } }] }] });
    await sleep(200); assert.equal(count(), was);
    await webhook(msgEvent('L1', 'echo_phone_1', 'typed on my phone', { echo: true }));
    await until(() => count() === was + 1);
    const m = db.prepare("SELECT role, source FROM messages WHERE mid = 'echo_phone_1'").get();
    assert.deepEqual({ ...m }, { role: 'setter', source: 'human' });
    assert.equal(sends.length, before);
  });

  // ---- manual inbox sends --------------------------------------------------------
  await test('manual send inside the window goes out once, with no message tag', async () => {
    const c = conv('L1'); const before = sendsTo('L1').length;
    const r = await api('POST', `/api/conversations/${c.id}/send`, { text: 'Hey! What is your main goal right now?' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const mine = sendsTo('L1').slice(before); assert.equal(mine.length, 1);
    assert.equal(mine[0].body.tag, undefined); assert.equal(mine[0].body.messaging_type, undefined);
    const row = db.prepare("SELECT state, mid FROM outbound_sends WHERE conversation_id = ? AND state = 'sent'").get(c.id); assert.ok(row?.mid);
    // Its echo is recognised as ours, not stored twice.
    await webhook(msgEvent('L1', row.mid, 'Hey! What is your main goal right now?', { echo: true })); await sleep(250);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM messages WHERE mid = ?').get(row.mid).n, 1);
  });
  await test('manual send with an idempotency key twice (double click) sends once', async () => {
    const c = conv('L1'); const before = sendsTo('L1').length;
    const [a, b] = await Promise.all([1, 2].map(() => api('POST', `/api/conversations/${c.id}/send`, { text: 'Quick one', idempotency_key: 'compose-123' })));
    assert.ok([a.status, b.status].includes(200));
    const again = await api('POST', `/api/conversations/${c.id}/send`, { text: 'Quick one', idempotency_key: 'compose-123' });
    assert.equal(again.status, 200);
    assert.equal(sendsTo('L1').length - before, 1);
  });
  await test('manual send outside the 24h window: refused, nothing sent, thread flagged "outside 24h window"', async () => {
    const c = await lead('L2');
    db.prepare('UPDATE conversations SET last_lead_message_at = ? WHERE id = ?').run(new Date(Date.now() - 30 * H).toISOString(), c.id);
    const before = sends.length;
    const r = await api('POST', `/api/conversations/${c.id}/send`, { text: 'are you still there?' });
    assert.equal(r.status, 409); assert.equal(r.json.reason, 'outside 24h window'); assert.match(r.json.error, /24 hour window/);
    assert.equal(sends.length, before);
    const fresh = conv('L2'); assert.equal(fresh.needs_human, 1); assert.equal(fresh.needs_human_reason, 'outside 24h window');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM messages WHERE conversation_id = ? AND role = \'setter\'').get(c.id).n, 0, 'nothing recorded as sent');
  });
  await test('never initiate: a thread with no inbound message from the lead cannot be messaged', async () => {
    db.prepare("INSERT INTO conversations (id, channel, external_id, handle, stage, mode, created_at, account_id) VALUES ('conv_cold', 'instagram', 'L_cold', 'cold_lead', 'lead', 'off', ?, 'acc_1')").run(new Date().toISOString());
    const before = sends.length;
    const r = await api('POST', '/api/conversations/conv_cold/send', { text: 'hi, saw your profile' });
    assert.equal(r.status, 409); assert.equal(sends.length, before);
  });

  // ---- drafts ------------------------------------------------------------------
  await test('approving an old draft outside the window: refused, nothing sent, draft stays pending', async () => {
    const c = conv('L2'); const id = insertDraft(c, ['old draft']); const before = sends.length;
    const r = await api('POST', `/api/drafts/${id}/approve`);
    assert.equal(r.status, 409); assert.equal(sends.length, before);
    assert.equal(db.prepare('SELECT status FROM drafts WHERE id = ?').get(id).status, 'pending');
  });
  await test('send-all skips drafts outside the window', async () => {
    const before = sends.length;
    const r = await api('POST', '/api/drafts/send-all');
    assert.equal(r.status, 200); assert.ok(r.json.window >= 1); assert.equal(sends.length, before);
  });
  await test('approve is idempotent: a retried approval and a double click never resend', async () => {
    const c = conv('L1');
    const id = insertDraft(c, ['first bubble', 'second bubble']); let before = sendsTo('L1').length;
    assert.equal((await api('POST', `/api/drafts/${id}/approve`)).status, 200);
    assert.equal(sendsTo('L1').length - before, 2);
    // A retried job finds the draft pending again: nothing goes out twice.
    db.prepare("UPDATE drafts SET status = 'pending' WHERE id = ?").run(id);
    before = sendsTo('L1').length;
    assert.equal((await api('POST', `/api/drafts/${id}/approve`)).status, 200);
    assert.equal(sendsTo('L1').length - before, 0);
    // Double click on a fresh draft.
    const id2 = insertDraft(c, ['double click test']); before = sendsTo('L1').length;
    const rs = await Promise.all([1, 2].map(() => api('POST', `/api/drafts/${id2}/approve`)));
    assert.ok(rs.some((r) => r.status === 200));
    assert.equal(sendsTo('L1').length - before, 1);
  });

  // ---- automated paths ----------------------------------------------------------
  await test('Call Booked VSL (automated) is held by the window gate', async () => {
    assert.equal((await api('PUT', '/api/settings', { call_booked_vsl: 'Watch this before our call' })).status, 200);
    const c = conv('L2'); const before = sends.length;
    const r = await fetch(BASE + '/webhook/calendly', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'invitee.created', payload: { name: 'Lead Two', tracking: { utm_content: c.id }, scheduled_event: { start_time: new Date(Date.now() + 48 * H).toISOString() } } }) });
    assert.equal(r.status, 200);
    await until(() => db.prepare("SELECT 1 FROM outbound_sends WHERE conversation_id = ? AND state = 'parked'").get(c.id));
    assert.equal(sends.length, before);
    assert.equal(conv('L2').needs_human_reason, 'outside 24h window');
    assert.equal(conv('L2').vsl_sent_at, null);
  });
  await test('keyword opener (automated) sends inside the window', async () => {
    assert.equal((await api('PUT', '/api/settings', { keyword_trigger: JSON.stringify({ mode: 'text', keywords: 'LEAN', initial_message: 'Welcome! What made you message today?', delay_min: '', delay_max: '' }) })).status, 200);
    await lead('L3', 'LEAN');
    await until(() => sendsTo('L3').length === 1, 6000);
    assert.equal(sendsTo('L3').length, 1); assert.equal(sendsTo('L3')[0].body.message.text, 'Welcome! What made you message today?');
  });
  await test('keyword opener for a message sent 30h ago (Meta redelivery) is held by the gate', async () => {
    const c = await lead('L4', 'LEAN', { ts: Date.now() - 30 * H });
    await until(() => conv('L4')?.needs_human === 1, 6000);
    assert.equal(sendsTo('L4').length, 0); assert.equal(conv('L4').needs_human_reason, 'outside 24h window');
    assert.ok(Date.parse(c.last_lead_message_at) < Date.now() - 29 * H, 'window anchored on the send time');
  });

  // ---- Meta errors ---------------------------------------------------------------
  await test('blocked lead: parked with a clear reason, one attempt only', async () => {
    const c = await lead('L_blocked'); const before = sendsTo('L_blocked').length;
    const r = await api('POST', `/api/conversations/${c.id}/send`, { text: 'hello?' });
    assert.equal(r.status, 409); assert.match(r.json.reason, /unavailable/);
    assert.equal(sendsTo('L_blocked').length - before, 1); assert.equal(conv('L_blocked').needs_human, 1);
  });
  await test('outside-window answer from Meta is parked (not treated as a token error)', async () => {
    const c = await lead('L_window');
    const r = await api('POST', `/api/conversations/${c.id}/send`, { text: 'hello?' });
    assert.equal(r.status, 409); assert.equal(r.json.reason, 'outside 24h window');
    assert.equal(db.prepare("SELECT status FROM instagram_accounts WHERE account_id = 'acc_1'").get().status, 'connected');
  });
  await test('token error: account flips to needs_reconnect and all sends pause until it is healthy', async () => {
    const c = await lead('L_auth');
    const r = await api('POST', `/api/conversations/${c.id}/send`, { text: 'hello?' });
    assert.equal(r.status, 409); assert.equal(r.json.reason, 'instagram needs reconnect');
    assert.equal(db.prepare("SELECT status FROM instagram_accounts WHERE account_id = 'acc_1'").get().status, 'needs_reconnect');
    const before = sends.length;
    const r2 = await api('POST', `/api/conversations/${conv('L1').id}/send`, { text: 'paused?' });
    assert.equal(r2.status, 409); assert.equal(sends.length, before, 'no Graph call while paused');
    const me = await api('GET', '/api/me'); assert.equal(me.json.instagram.needs_reconnect, true);
    await api('GET', '/api/instagram/status'); // healthy token check clears it
    assert.equal(db.prepare("SELECT status FROM instagram_accounts WHERE account_id = 'acc_1'").get().status, 'connected');
    assert.equal((await api('POST', `/api/conversations/${conv('L1').id}/send`, { text: 'back again' })).status, 200);
  });
  await test('network failure mid-send: outcome unknown, flagged, never resent', async () => {
    const c = await lead('L_hang'); const before = sendsTo('L_hang').length;
    const r = await api('POST', `/api/conversations/${c.id}/send`, { text: 'did this arrive?', idempotency_key: 'k-hang' });
    assert.equal(r.status, 409); assert.match(r.json.reason, /outcome unknown/);
    const r2 = await api('POST', `/api/conversations/${c.id}/send`, { text: 'did this arrive?', idempotency_key: 'k-hang' });
    assert.equal(r2.status, 409);
    assert.equal(sendsTo('L_hang').length - before, 1);
    assert.equal(db.prepare("SELECT state FROM outbound_sends WHERE idem_key = ?").get('human:' + c.id + ':k-hang').state, 'unknown');
  });
  await test('rate limit from Meta: parked and the account backs off (no hammering)', async () => {
    const c = await lead('L_rl');
    const r = await api('POST', `/api/conversations/${c.id}/send`, { text: 'hello?' });
    assert.equal(r.status, 409); assert.match(r.json.reason, /rate limited/);
    const before = sends.length;
    const r2 = await api('POST', `/api/conversations/${conv('L1').id}/send`, { text: 'during back-off' });
    assert.equal(r2.status, 409); assert.equal(sends.length, before);
    await sleep(500);
    assert.equal((await api('POST', `/api/conversations/${conv('L1').id}/send`, { text: 'after back-off' })).status, 200);
  });
  await test('sends from one account are spaced out (throttle)', async () => {
    const c = conv('L1'); const before = sends.length;
    await Promise.all(['one', 'two', 'three'].map((t) => api('POST', `/api/conversations/${c.id}/send`, { text: 'spaced ' + t })));
    const mine = sends.slice(before);
    assert.equal(mine.length, 3);
    for (let i = 1; i < mine.length; i++) assert.ok(mine[i].at - mine[i - 1].at >= 30, 'gap ' + (mine[i].at - mine[i - 1].at));
  });

  // ---- restart mid-send --------------------------------------------------------------
  await test('restart mid-send: the interrupted send is marked unknown, flagged, and not retried; its echo confirms it', async () => {
    const c = conv('L1');
    db.prepare('UPDATE conversations SET needs_human = 0, needs_human_reason = NULL WHERE id = ?').run(c.id);
    const hash = crypto.createHash('sha256').update('lost in the restart').digest('hex');
    db.prepare("INSERT INTO outbound_sends (idem_key, account_id, conversation_id, kind, text_hash, state, created_at, updated_at) VALUES ('k-restart', 'acc_1', ?, 'text', ?, 'sending', ?, ?)")
      .run(c.id, hash, new Date().toISOString(), new Date().toISOString());
    db.close(); await stop(); const before = sends.length;
    boot(); await waitUp(); openDb();
    assert.equal(db.prepare("SELECT state FROM outbound_sends WHERE idem_key = 'k-restart'").get().state, 'unknown');
    assert.match(conv('L1').needs_human_reason, /send outcome unknown/);
    await sleep(1500); // boot rescue window (FAST_TIMERS)
    assert.equal(sends.length, before, 'nothing fired after the restart');
    await webhook(msgEvent('L1', 'echo_lost', 'Lost in the restart.', { echo: true }));
    await until(() => db.prepare("SELECT state FROM outbound_sends WHERE idem_key = 'k-restart'").get().state === 'sent'
      && db.prepare("SELECT source FROM messages WHERE mid = 'echo_lost'").get()?.source === 'ai');
    assert.equal(conv('L1').needs_human, 0, 'flag lifted once Instagram confirmed it');
    assert.equal(db.prepare("SELECT source FROM messages WHERE mid = 'echo_lost'").get().source, 'ai');
  });

  // ---- legal pages and Meta callbacks ---------------------------------------------------
  await test('privacy, terms and data deletion pages are public and carry the company details', async () => {
    const p = await (await fetch(BASE + '/privacy')).text();
    assert.ok(p.includes('Test Coaching Ltd') && p.includes('privacy@example.test') && p.includes('[COMPANY_ADDRESS not set'));
    assert.ok(!/—|&mdash;/.test(p));
    assert.equal((await fetch(BASE + '/terms')).status, 200);
    const d = await (await fetch(BASE + '/data-deletion?code=abc123')).text(); assert.ok(d.includes('abc123'));
  });
  const signedRequest = (payload) => {
    const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return crypto.createHmac('sha256', SECRET).update(b64).digest('base64url') + '.' + b64;
  };
  await test('owner can erase one conversation (a lead\'s deletion request)', async () => {
    const c = conv('L4');
    assert.equal((await api('DELETE', `/api/conversations/${c.id}`, {})).status, 400);
    assert.equal((await api('DELETE', `/api/conversations/${c.id}`, { confirm: c.id })).status, 200);
    assert.equal(conv('L4'), undefined);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM messages WHERE conversation_id = ?').get(c.id).n, 0);
  });
  await test('deauthorize callback disconnects the account and stops sends', async () => {
    const r = await fetch(BASE + '/webhook/meta/deauthorize', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'signed_request=' + signedRequest({ user_id: BIZ, algorithm: 'HMAC-SHA256' }) });
    assert.equal(r.status, 200);
    assert.equal(db.prepare("SELECT status FROM instagram_accounts WHERE account_id = 'acc_1'").get().status, 'disconnected');
  });
  await test('signed data deletion callback for the business erases its Instagram conversations', async () => {
    const r = await fetch(BASE + '/webhook/meta/data-deletion', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'signed_request=' + signedRequest({ user_id: BIZ, algorithm: 'HMAC-SHA256' }) });
    assert.equal(r.status, 200); const j = await r.json(); assert.ok(j.confirmation_code && j.url.includes('/data-deletion?code='));
    assert.equal(db.prepare("SELECT COUNT(*) n FROM conversations WHERE channel = 'instagram'").get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM outbound_sends').get().n, 0);
  });
} catch (e) {
  failed++; console.log('  FAIL setup: ' + (e.stack || e.message) + '\n' + logLines.slice(-20).join('\n'));
} finally {
  try { db && db.close(); } catch { /* closed */ }
  await stop();
  graph.close();
  fs.rmSync(DATA, { recursive: true, force: true });
}
if (failed && process.env.DEBUG_E2E) console.log(logLines.join('\n'));
console.log(failed ? `\n${failed} failing` : '\nall green');
process.exit(failed ? 1 : 0);

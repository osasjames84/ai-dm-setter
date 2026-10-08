/** Unit tests on the pure functions (F.6). Run: npm test */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyOutboundFilter, stripDashes, buildSystemPrompt } from '../lib/engine.js';
import { followupLadder, withinMessagingWindow, normalizeStep, interpolateName, firstNameOf } from '../lib/scheduler.js';
import { matchExactPhrase } from '../lib/triggers.js';
import { igParseInbound } from '../lib/instagram.js';
import { initCrypto, encrypt, decrypt } from '../lib/crypto.js';
import { runMigrations } from '../lib/migrations.js';
import { parseProfile, profileNote } from '../lib/profile.js';
import { resolvePersonas } from '../lib/testdrive.js';
import { costUsd } from '../lib/usage.js';
import { TEST_DRIVE_MIN_RUNS, testDriveCounts, testDriveState, goLiveBlockers } from '../lib/golive.js';
import { createLimiter, envInt } from '../lib/ratelimit.js';
import { resolveTimezone, hourFormatter } from '../lib/timezone.js';
import { initEvents, openStream, closeStreams, revalidateStreams, streamCount } from '../lib/events.js';

let failed = 0;
const test = (name, fn) => { try { fn(); console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

test('stripDashes removes em dashes and keeps hyphenated words', () => {
  assert.equal(stripDashes('wait — really'), 'wait, really');
  assert.ok(stripDashes('well-known').includes('well-known'));
});
test('applyOutboundFilter blocks a matching regex and passes otherwise', () => {
  assert.equal(applyOutboundFilter('the price is £300', ['£\\d+']).ok, false);
  assert.equal(applyOutboundFilter('hello there', ['£\\d+']).ok, true);
});
test('buildSystemPrompt contains only the owner sections that are set', () => {
  const p = buildSystemPrompt({ prompt_persona: 'I am Sam.', prompt_hard_rules: 'Never quote a price.' });
  assert.ok(p.includes('I am Sam.')); assert.ok(p.includes('Never quote a price.')); assert.ok(!p.includes('BOOKING SEQUENCE'));
});
test('followupLadder is empty when the timings are blank', () => { assert.deepEqual(followupLadder({}), []); });
test('withinMessagingWindow is false after 24h without a lead message', () => {
  assert.equal(withinMessagingWindow({ channel: 'instagram', last_lead_message_at: new Date(Date.now() - 25 * 3600_000).toISOString() }), false);
  assert.equal(withinMessagingWindow({ channel: 'instagram', last_lead_message_at: new Date().toISOString() }), true);
});
test('normalizeStep and interpolateName', () => {
  assert.equal(normalizeStep({ message: 'hi {{FIRST_NAME}}' }).message, 'hi {{FIRST_NAME}}');
  assert.equal(interpolateName('hi {{FIRST_NAME}}', { display_name: 'Ada Lovelace', handle: 'ada' }), 'hi Ada');
  assert.equal(interpolateName('hi {{FIRST_NAME}}, ok?', { display_name: '', handle: 'x' }), 'hi, ok?');
  assert.equal(firstNameOf({ display_name: '', handle: 'jay_fitzz' }), '');
});
test('matchExactPhrase is case and punctuation tolerant but exact', () => {
  assert.equal(matchExactPhrase('Taking over!', ['taking over']), true);
  assert.equal(matchExactPhrase('taking over now', ['taking over']), false);
});
test('igParseInbound routes by entry id and drops self events', () => {
  const body = { entry: [{ id: '9', messaging: [
    { sender: { id: '1' }, recipient: { id: '9' }, message: { mid: 'a', text: 'hi' } },
    { sender: { id: '9' }, recipient: { id: '1' }, message: { mid: 'b', text: 'echo' } },
    { sender: { id: '9' }, recipient: { id: '9' }, message: { mid: 'c', text: 'self' } } ] }] };
  const ev = igParseInbound(body, (id) => (id === '9' ? '9' : null));
  assert.deepEqual(ev.map((e) => [e.direction, e.leadId, e.businessId]), [['in', '1', '9'], ['out', '1', '9']]);
});
test('crypto round trip and tamper detection', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmk-')); process.env.TOKEN_ENC_KEY = '';
  initCrypto(dir);
  const enc = encrypt('secret token'); assert.equal(decrypt(enc), 'secret token'); assert.equal(decrypt(enc.slice(0, -2) + 'zz'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
test('migrations apply once and skip comment-only chunks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmm-'));
  fs.writeFileSync(path.join(dir, '001_a.sql'), '-- comment\nCREATE TABLE t (id INTEGER);\n-- trailing\n');
  const db = new DatabaseSync(':memory:');
  assert.deepEqual(runMigrations(db, dir), ['001_a.sql']); assert.deepEqual(runMigrations(db, dir), []);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 't'").get());
  fs.rmSync(dir, { recursive: true, force: true });
});
test('profile note reads the stored profile', () => {
  const p = parseProfile(JSON.stringify({ goal: 'lose 10kg', objections: ['price'] }));
  assert.ok(profileNote(p).includes('lose 10kg')); assert.equal(profileNote(null), ''); assert.equal(parseProfile('nope'), null);
});
test('test-drive persona aliases resolve and default to five', () => {
  assert.equal(resolvePersonas().length, 5); assert.equal(resolvePersonas(['price_hunter'])[0].id, 'price_shock'); assert.equal(resolvePersonas(['nope']).length, 0);
});
test('usage cost uses the model price table', () => {
  assert.equal(costUsd({ model: 'claude-haiku-4-5-20251001', input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }), 1);
});
test('go-live: a test drive counts only when full, finished and not failed', () => {
  const run = (verdict = 'pass', status = 'done') => ({ status, verdict });
  const job = (runs, extra = {}) => ({ status: 'done', passed: true, runs, ...extra });
  assert.equal(testDriveCounts(job([run(), run(), run(), run(), run()])), true);
  assert.equal(testDriveCounts(job([run()])), false, 'partial');
  assert.equal(testDriveCounts(job([run(), run(), run(), run(), run('fail')])), false, 'failed run');
  assert.equal(testDriveCounts(job([run(), run(), run(), run(), run('pass', 'error')])), false, 'crashed run');
  assert.equal(testDriveCounts(job([run(), run(), run(), run(), run()], { status: 'running', passed: null })), false, 'in flight');
  assert.equal(testDriveCounts(job([run(), run(), run(), run(), run()], { passed: false })), false);
  assert.equal(testDriveCounts(null), false); assert.equal(TEST_DRIVE_MIN_RUNS, 5);
});
test('go-live: a pass is bound to the prompt version it ran on', () => {
  assert.equal(testDriveState({ passedAt: 't', passedVersion: '3', currentVersion: 3 }).passed, true);
  const stale = testDriveState({ passedAt: 't', passedVersion: '3', currentVersion: 4 }); assert.equal(stale.passed, false); assert.equal(stale.stale, true);
  assert.equal(testDriveState({ passedAt: 't', passedVersion: '', currentVersion: 4 }).passed, false, 'a pass without a version never counts');
  assert.equal(testDriveState({ passedAt: '', passedVersion: '', currentVersion: 4 }).stale, false);
});
test('go-live: blockers cover access, instagram, script errors and the test drive', () => {
  const ok = { passed: true, stale: false };
  assert.deepEqual(goLiveBlockers({ accessStatus: 'active', instagram: 'connected', checks: [{ level: 'warn' }], testDrive: ok }), []);
  const all = goLiveBlockers({ accessStatus: 'pending', instagram: 'disconnected', checks: [{ section: 'next_step', level: 'error', message: 'x' }], testDrive: { passed: false, stale: true } });
  assert.deepEqual(all.map((b) => b.section), ['access', 'instagram', 'next_step', 'test_drive']);
  assert.match(all[3].message, /changed/);
  assert.match(goLiveBlockers({ accessStatus: 'active', instagram: 'needs_reconnect', testDrive: ok })[0].message, /reconnect/i);
  for (const b of all) assert.ok(!b.message.includes('—'), 'no em dashes in user copy');
});
test('rate limiter: fixed window per key, then resets', () => {
  let t = 0; const lim = createLimiter({ windowMs: 1000, max: 2, now: () => t });
  assert.equal(lim.hit('a').ok, true); assert.equal(lim.hit('a').ok, true);
  const third = lim.hit('a'); assert.equal(third.ok, false); assert.equal(third.retryAfterS, 1);
  assert.equal(lim.hit('b').ok, true, 'keys are independent');
  t = 1001; assert.equal(lim.hit('a').ok, true, 'window reset');
  assert.equal(envInt('7', 3), 7); assert.equal(envInt('', 3), 3); assert.equal(envInt('-1', 3), 3);
});
test('timezone: account zone when valid, server zone otherwise, hours in that zone', () => {
  assert.deepEqual(resolveTimezone('Asia/Kolkata'), { timezone: 'Asia/Kolkata', source: 'account' });
  assert.equal(resolveTimezone('Mars/Base').source, 'server'); assert.equal(resolveTimezone('').source, 'server');
  assert.equal(hourFormatter('Asia/Kolkata')('2026-01-01T20:00:00Z'), 1);
  assert.equal(hourFormatter('UTC')('2026-01-01T00:30:00Z'), 0);
  assert.equal(hourFormatter('America/New_York')('2026-07-01T12:00:00Z'), 8);
  assert.equal(hourFormatter('UTC')('nope'), -1);
});
test('live streams: capped per account, closed by session, user or account', () => {
  initEvents({ maxPerAccount: 2, revalidateMs: 60_000, validate: (e) => e.sessionHash !== 'dead' });
  const fake = () => ({ ended: false, out: [], statusCode: 200, writeHead() {}, write(x) { this.out.push(x); }, end() { this.ended = true; }, status(c) { this.statusCode = c; return this; }, set() { return this; }, json() { this.ended = true; return this; } });
  const req = () => ({ on() {} });
  const a = fake(), b = fake(), c = fake();
  assert.equal(openStream('acc_x', req(), a, { userId: 'u1', sessionHash: 's1' }), true);
  assert.equal(openStream('acc_x', req(), b, { userId: 'u2', sessionHash: 'dead' }), true);
  assert.equal(openStream('acc_x', req(), c, { userId: 'u3', sessionHash: 's3' }), false); assert.equal(c.statusCode, 429);
  assert.equal(revalidateStreams(), 1); assert.equal(b.ended, true); assert.equal(a.ended, false);
  assert.equal(closeStreams({ userId: 'u1' }), 1); assert.equal(a.ended, true); assert.equal(streamCount('acc_x'), 0);
  const d = fake(); openStream('acc_y', req(), d, { userId: 'u4', sessionHash: 's4' });
  assert.equal(closeStreams({ accountId: 'acc_y' }), 1); assert.equal(d.ended, true);
  initEvents({ revalidateMs: 3_600_000, validate: null });
});
console.log(failed ? `\n${failed} failing` : '\nall green');
process.exit(failed ? 1 : 0);

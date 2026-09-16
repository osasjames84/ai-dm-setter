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
console.log(failed ? `\n${failed} failing` : '\nall green');
process.exit(failed ? 1 : 0);

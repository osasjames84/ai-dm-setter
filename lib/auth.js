/**
 * Magic-link login and sessions. No passwords anywhere.
 *
 *   requestMagicLink(email)  → creates (or finds) the user, stores a hashed
 *                              one-time token, returns the link to send.
 *   consumeMagicLink(token)  → validates, marks used, opens a session, returns
 *                              { cookie, user, account }.
 *   sessionFromRequest(req)  → { user, account } or null.
 *
 * Tokens are random 32 bytes; only their SHA-256 is stored. Sessions last 30
 * days and are refreshed on use. The cookie is httpOnly, SameSite=Lax, Secure
 * in production.
 */
import crypto from 'node:crypto';

const SESSION_DAYS = 30;
const LINK_MINUTES = 20;
const COOKIE = 'dm_session';

let db = null;
let opts = { isProd: false, createAccountFor: null };

export function initAuth(database, o = {}) { db = database; opts = { ...opts, ...o }; }

const nowIso = () => new Date().toISOString();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');
export const normalizeEmail = (e) => String(e || '').trim().toLowerCase();
export const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(e));

export function userByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(normalizeEmail(email)) || null;
}

/** Start a login (or sign-up: an unknown email gets a new pending account). Returns the raw token. */
export function requestMagicLink(email) {
  const e = normalizeEmail(email);
  if (!isEmail(e)) throw new Error('Enter a valid email address');
  if (!userByEmail(e) && typeof opts.createAccountFor === 'function') opts.createAccountFor(e);
  const t = token();
  db.prepare('INSERT INTO magic_links (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(sha(t), e, nowIso(), new Date(Date.now() + LINK_MINUTES * 60_000).toISOString());
  return t;
}

/** Validate a magic-link token and open a session. Returns { setCookie, user, account } or null. */
export function consumeMagicLink(t) {
  const row = db.prepare('SELECT * FROM magic_links WHERE token_hash = ?').get(sha(String(t || '')));
  if (!row || row.used_at || row.expires_at < nowIso()) return null;
  const user = userByEmail(row.email);
  if (!user) return null;
  db.prepare('UPDATE magic_links SET used_at = ? WHERE token_hash = ?').run(nowIso(), row.token_hash);
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), user.id);
  const s = token();
  db.prepare('INSERT INTO sessions (token_hash, user_id, account_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(sha(s), user.id, user.account_id, nowIso(), new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString());
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(user.account_id);
  return { setCookie: cookieHeader(s), user, account };
}

function cookieHeader(value, expire = false) {
  const parts = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (opts.isProd) parts.push('Secure');
  parts.push(expire ? 'Max-Age=0' : `Max-Age=${SESSION_DAYS * 86400}`);
  return parts.join('; ');
}

function readCookie(req) {
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return null;
}

/** { user, account } for a valid session cookie, else null. Refreshes expiry on use. */
export function sessionFromRequest(req) {
  const c = readCookie(req);
  if (!c) return null;
  const h = sha(c);
  const s = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(h);
  if (!s || s.expires_at < nowIso()) return null;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
  const account = user && db.prepare('SELECT * FROM accounts WHERE id = ?').get(user.account_id);
  if (!user || !account) return null;
  db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString(), h);
  return { user, account };
}

/** Delete the session behind the request's cookie; returns the header that clears it. */
export function logout(req) {
  const c = readCookie(req);
  if (c) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(c));
  return cookieHeader('', true);
}

/** Housekeeping: drop expired sessions and links. */
export function pruneAuth() {
  const n = nowIso();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(n);
  db.prepare('DELETE FROM magic_links WHERE expires_at < ?').run(n);
}

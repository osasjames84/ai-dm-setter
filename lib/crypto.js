/**
 * Encryption for secrets at rest (Instagram tokens). AES-256-GCM with a key
 * from TOKEN_ENC_KEY (32 bytes, hex or base64). When the variable is missing a
 * key is generated once and kept at DATA_DIR/.token_key, so a fresh install
 * works without setup and the key survives restarts on the volume. Losing the
 * key only means every account has to reconnect Instagram.
 *
 * Format: "v1." + base64url(iv | tag | ciphertext)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

let _key = null;

function parseKey(s) {
  const str = String(s || '').trim();
  if (!str) return null;
  if (/^[0-9a-f]{64}$/i.test(str)) return Buffer.from(str, 'hex');
  const b = Buffer.from(str, 'base64');
  return b.length === 32 ? b : null;
}

/** Load (or create) the key. Call once at boot. Returns 'env' | 'file' | 'generated'. */
export function initCrypto(dataDir) {
  const fromEnv = parseKey(process.env.TOKEN_ENC_KEY);
  if (fromEnv) { _key = fromEnv; return 'env'; }
  if (process.env.TOKEN_ENC_KEY) console.error('[crypto] TOKEN_ENC_KEY is set but is not 32 bytes (64 hex chars); ignoring it');
  const file = path.join(dataDir, '.token_key');
  try {
    const k = parseKey(fs.readFileSync(file, 'utf8'));
    if (k) { _key = k; return 'file'; }
  } catch { /* no key file yet */ }
  _key = crypto.randomBytes(32);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, _key.toString('hex') + '\n', { mode: 0o600 });
  return 'generated';
}

export function encrypt(plain) {
  if (!_key) throw new Error('crypto not initialised');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', _key, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return 'v1.' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}

/** Returns the plaintext, or null when the value is empty or cannot be decrypted. */
export function decrypt(enc) {
  if (!enc || !_key) return null;
  try {
    const s = String(enc);
    if (!s.startsWith('v1.')) return null;
    const buf = Buffer.from(s.slice(3), 'base64url');
    const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), ct = buf.subarray(28);
    const d = crypto.createDecipheriv('aes-256-gcm', _key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch { return null; }
}

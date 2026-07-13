/**
 * Inbound attachment store. Instagram webhooks deliver attachments (images,
 * voice notes, video, shares) as temporary CDN URLs that EXPIRE — so we download
 * each to DATA_DIR/attachments and serve our own persistent copy. The stored id
 * carries its extension (e.g. "9f3a…c1.jpg"); the serving route derives the mime.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

let DIR = null;
export function initAttachments(dataDir) {
  DIR = path.join(dataDir, 'attachments');
  fs.mkdirSync(DIR, { recursive: true });
}

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
  mp4: 'video/mp4', mov: 'video/quicktime', m4a: 'audio/mp4', aac: 'audio/aac', mp3: 'audio/mpeg',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/opus', wav: 'audio/wav', webm: 'audio/webm', bin: 'application/octet-stream',
};
const EXT_BY_CT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/heic': 'heic',
  'video/mp4': 'mp4', 'video/quicktime': 'mov',
  'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/wav': 'wav', 'audio/webm': 'webm',
};
const EXT_BY_KIND = { image: 'jpg', video: 'mp4', audio: 'm4a', file: 'bin' };

/** Map an Instagram attachment type to our coarse kind. */
export function attachmentKind(igType) {
  const t = String(igType || '').toLowerCase();
  if (t === 'image') return 'image';
  if (t === 'video' || t === 'ig_reel' || t === 'reel') return 'video';
  if (t === 'audio') return 'audio';
  return 'file'; // share, story_mention, template, fallback, unknown
}

function extFromUrl(url) {
  const m = String(url).split('?')[0].match(/\.([a-z0-9]{2,5})$/i);
  return m ? m[1].toLowerCase() : null;
}

/** Detect the real extension from magic bytes (IG's content-type is often generic/wrong). */
function sniffExt(buf, kind) {
  if (!buf || buf.length < 12) return null;
  const at = (o, s) => buf.slice(o, o + s.length).toString('latin1') === s;
  if (at(4, 'ftyp')) {
    // HEIC/HEIF/AVIF images ALSO use an ftyp box — never mislabel an image as
    // audio/video. Let content-type / url extension decide for images.
    if (kind === 'image') return null;
    return kind === 'video' ? 'mp4' : 'm4a';
  }
  if (at(0, 'OggS')) return 'ogg';                            // ogg/opus/vorbis (voice notes)
  if (at(0, 'RIFF') && at(8, 'WAVE')) return 'wav';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'webp';
  if (at(0, 'ID3') || (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0)) return 'mp3';
  if (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) return 'webm';
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpg';
  if (at(0, '\x89PNG')) return 'png';
  if (at(0, 'GIF8')) return 'gif';
  return null;
}

const MAX_BYTES = 30 * 1024 * 1024;   // 30MB cap (IG's own limit is 25MB)
const FETCH_TIMEOUT_MS = 15000;       // per-hop timeout so a hung CDN can't stall the webhook loop
const MAX_REDIRECTS = 3;
// The webhook is unauthenticated, so we only ever fetch from Instagram/Facebook
// CDN hosts — never an arbitrary/internal URL an attacker could POST (SSRF guard).
const CDN_HOST = /(^|\.)(cdninstagram\.com|fbcdn\.net|fbsbx\.com|facebook\.com)$/i;
function allowedHost(u) {
  if (process.env.ATTACH_ALLOW_ANY_HOST === '1') return true; // test-only escape hatch
  try { return CDN_HOST.test(new URL(u).hostname); } catch { return false; }
}

/**
 * Fetch with a timeout and MANUAL redirect handling: every hop's host is
 * re-validated against the CDN allowlist (blocks SSRF-via-redirect to internal
 * hosts), and the page token is only ever attached to the ORIGINAL request —
 * never carried across a redirect (blocks token leak to a redirected host).
 */
async function fetchAllowed(url, withToken) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!allowedHost(current)) throw new Error('attachment host not allowed');
    let target = current;
    if (withToken && hop === 0 && process.env.IG_PAGE_TOKEN) {
      const sep = current.includes('?') ? '&' : '?';
      target = current + sep + 'access_token=' + encodeURIComponent(process.env.IG_PAGE_TOKEN);
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    let res;
    try { res = await fetch(target, { redirect: 'manual', signal: ac.signal }); }
    finally { clearTimeout(timer); }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), current).toString();
      continue; // host re-validated at the top of the next iteration
    }
    return res;
  }
  throw new Error('too many redirects');
}

/** Download an attachment URL to disk (a few retries on transient failures). Returns { id, kind, mime, bytes } or throws. */
export async function saveFromUrl(url, igType) {
  if (!DIR) throw new Error('attachment store not initialized');
  if (!url) throw new Error('no attachment url');
  if (!allowedHost(url)) throw new Error('attachment host not allowed');
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let res = await fetchAllowed(url, false);
      if (!res.ok && process.env.IG_PAGE_TOKEN) res = await fetchAllowed(url, true);
      if (!res.ok) throw new Error(`download ${res.status}`);
      const declared = Number(res.headers.get('content-length') || 0);
      if (declared && declared > MAX_BYTES) throw new Error('attachment too large');
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new Error('empty download');
      if (buf.length > MAX_BYTES) throw new Error('attachment too large');
      const ct = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const kind = attachmentKind(igType);
      // Trust magic bytes first (correct format ⇒ browser can play it + Whisper accepts it).
      const ext = sniffExt(buf, kind) || EXT_BY_CT[ct] || extFromUrl(url) || EXT_BY_KIND[kind] || 'bin';
      const id = crypto.randomBytes(8).toString('hex') + '.' + ext;
      fs.writeFileSync(path.join(DIR, id), buf);
      return { id, kind, mime: MIME[ext] || ct || 'application/octet-stream', bytes: buf.length };
    } catch (e) {
      lastErr = e;
      if (/too large|host not allowed/.test(e.message)) break; // not transient — don't retry
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastErr || new Error('download failed');
}

const AUDIO_EXTS = new Set(['m4a', 'mp3', 'ogg', 'oga', 'opus', 'wav', 'webm', 'aac', 'mp4']);
/** Persist an uploaded/recorded audio buffer (Audio Arsenal). Returns { id, mime, bytes } or throws. */
export function saveBuffer(buf, ext) {
  if (!DIR) throw new Error('attachment store not initialized');
  if (!buf || !buf.length) throw new Error('empty audio');
  if (buf.length > MAX_BYTES) throw new Error('audio too large');
  let e = String(ext || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!AUDIO_EXTS.has(e)) e = 'm4a'; // safe, Instagram-friendly default
  const id = crypto.randomBytes(8).toString('hex') + '.' + e;
  fs.writeFileSync(path.join(DIR, id), buf);
  return { id, mime: MIME[e] || 'application/octet-stream', bytes: buf.length };
}

/** Absolute path for a stored attachment id, or null (also guards path traversal). */
export function attachmentPath(id) {
  if (!DIR || !/^[a-f0-9]{16}\.[a-z0-9]{1,5}$/i.test(String(id))) return null;
  const p = path.join(DIR, id);
  return fs.existsSync(p) ? p : null;
}

/** Mime type for a stored attachment id (from its extension). */
export function attachmentMime(id) {
  const ext = String(id).split('.').pop().toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

/**
 * Normalize uploaded/recorded audio to a format Instagram's Send API accepts.
 * Browser MediaRecorder emits webm/opus (often rejected by IG); phone memos are
 * m4a. We transcode anything that isn't already IG-safe to mono AAC in an .m4a
 * container via ffmpeg (installed on the container through NIXPACKS_PKGS).
 * Degrades gracefully: if ffmpeg is missing or errors, the original is kept.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const SAFE = new Set(['mp3', 'm4a', 'aac']); // already IG-friendly → no re-encode

function run(cmd, args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let p;
    try { p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] }); }
    catch (e) { return reject(e); }
    let err = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('ffmpeg timeout')); }, timeoutMs);
    p.stderr.on('data', (d) => { if (err.length < 800) err += d.toString(); });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code + ': ' + err.slice(-200))); });
  });
}

let _avail = null;
/** True if ffmpeg is callable on this host (cached after first probe). */
export async function ffmpegAvailable() {
  if (_avail !== null) return _avail;
  try { await run(FFMPEG, ['-version'], 5000); _avail = true; } catch { _avail = false; }
  return _avail;
}

/**
 * Return { buf, ext, converted }. mp3/m4a/aac pass through untouched; everything
 * else is transcoded to .m4a. On any failure the original buffer is returned so
 * an upload never hard-fails on transcode.
 */
export async function normalizeAudio(inputBuf, ext) {
  const e = String(ext || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (SAFE.has(e)) return { buf: inputBuf, ext: e, converted: false };
  if (!(await ffmpegAvailable())) return { buf: inputBuf, ext: e || 'm4a', converted: false };
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vn-'));
    const inp = path.join(dir, 'in');
    const out = path.join(dir, 'out.m4a');
    fs.writeFileSync(inp, inputBuf);
    await run(FFMPEG, ['-y', '-i', inp, '-vn', '-c:a', 'aac', '-b:a', '64k', '-ar', '44100', '-ac', '1', '-movflags', '+faststart', out]);
    const buf = fs.readFileSync(out);
    if (!buf.length) throw new Error('empty transcode output');
    return { buf, ext: 'm4a', converted: true };
  } catch (err) {
    console.error('[audioconvert] transcode failed:', err.message);
    return { buf: inputBuf, ext: e || 'm4a', converted: false };
  } finally {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
}

/**
 * Nightly SQLite backup. Uses SQLite's `VACUUM INTO` to write a clean, fully
 * consistent copy of the live db (safe to run while the app is using it — unlike
 * copying the file). VACUUM INTO REFUSES to overwrite an existing file, so each
 * backup gets a timestamped name; we then prune to the 7 newest. server.js owns
 * the schedule (boot + every 24h) and the PIN-gated download route.
 */
import fs from 'node:fs';
import path from 'node:path';

const KEEP = 7; // retain the 7 newest backups

const backupsDir = (dataDir) => path.join(dataDir, 'backups');

/** YYYYMMDD-HHmmss in local time (matches the filename glob below). */
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** All backup file paths, newest first (by filename — the stamp sorts chronologically). */
function listBackups(dataDir) {
  const dir = backupsDir(dataDir);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => /^dmsetter-\d{8}-\d{6}(-\d+)?\.sqlite$/.test(n)) // optional -N suffix on same-second retries
    .sort()               // ascending by name == chronological
    .reverse()            // newest first
    .map((n) => path.join(dir, n));
}

/**
 * Create a fresh backup and prune old ones. Returns the created file path.
 * Path contains no quotes (dataDir under our control + a fixed-format name), so
 * the VACUUM INTO string needs no escaping.
 */
export function runBackup(db, dataDir) {
  const dir = backupsDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  // VACUUM INTO refuses to overwrite; the timestamp keeps names unique across
  // daily runs, but two calls in the same second (e.g. two quick /api/backup
  // clicks) would collide — bump a numeric suffix until the name is free.
  const base = `dmsetter-${stamp()}`;
  let file = path.join(dir, `${base}.sqlite`);
  for (let i = 1; fs.existsSync(file); i++) file = path.join(dir, `${base}-${i}.sqlite`);
  db.exec(`VACUUM INTO '${file}'`);
  // Prune everything past the newest KEEP (the just-created file is included in the list).
  for (const old of listBackups(dataDir).slice(KEEP)) {
    try { fs.unlinkSync(old); } catch { /* best-effort cleanup */ }
  }
  return file;
}

/** Newest backup file path, or null if none exist yet. */
export function latestBackup(dataDir) {
  return listBackups(dataDir)[0] || null;
}

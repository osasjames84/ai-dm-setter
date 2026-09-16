/**
 * Numbered SQL migrations, applied once each in filename order and recorded in
 * schema_migrations. A file is one transaction; a failure stops the boot with
 * the file name in the error so nothing half-applies silently.
 *
 *   migrations/001_accounts.sql, 002_….sql, …
 *
 * Statements are split on ";\n" — keep one statement per line-block and avoid
 * literal ";\n" inside string values.
 */
import fs from 'node:fs';
import path from 'node:path';

/** opts.before(pendingNames) runs once, before the first pending migration (used for a pre-migration snapshot). */
export function runMigrations(db, dir, opts = {}) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  if (!fs.existsSync(dir)) return [];
  const done = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
  const files = fs.readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  const applied = [];
  const pending = files.filter((f) => !done.has(f));
  if (pending.length && typeof opts.before === 'function') opts.before(pending);
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    db.exec('BEGIN');
    try {
      const stmts = sql.split(/;\s*\n/)
        .map((chunk) => chunk.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n').trim())
        .filter(Boolean);
      for (const stmt of stmts) db.exec(stmt);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f, new Date().toISOString());
      db.exec('COMMIT');
      applied.push(f);
      console.log(`[migrations] applied ${f}`);
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
      throw new Error(`migration ${f} failed: ${e.message}`);
    }
  }
  return applied;
}

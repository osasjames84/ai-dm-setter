-- Platform admin flag, account access audit trail, AI usage metering.
ALTER TABLE users ADD COLUMN is_platform_admin INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS account_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  actor_user_id TEXT,
  action TEXT NOT NULL,           -- e.g. access:active, access:paused, team:invite, team:remove
  detail TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_account ON account_audit(account_id, at);

CREATE TABLE IF NOT EXISTS ai_usage (
  account_id TEXT NOT NULL,
  day TEXT NOT NULL,              -- YYYY-MM-DD (UTC)
  model TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, day, model)
);

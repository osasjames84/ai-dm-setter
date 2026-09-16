-- Day 6: Instagram OAuth per account.
-- app_scoped_id: the id Instagram Login returns as "id" (webhook entry.id can be
-- either this or the professional account id, so both are matched on routing).
ALTER TABLE instagram_accounts ADD COLUMN app_scoped_id TEXT;
ALTER TABLE instagram_accounts ADD COLUMN scopes TEXT;
ALTER TABLE instagram_accounts ADD COLUMN last_refresh_at TEXT;
ALTER TABLE instagram_accounts ADD COLUMN last_error TEXT;
CREATE INDEX IF NOT EXISTS idx_instagram_accounts_app_scoped ON instagram_accounts(app_scoped_id);

-- OAuth state tokens (CSRF protection for /auth/instagram/start → callback).
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

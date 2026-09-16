-- Accounts, users, sessions, magic links, per-account settings, and an
-- account_id on every tenant table. Existing data becomes account acc_1.

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  access_status TEXT NOT NULL DEFAULT 'pending',   -- pending | active | paused (JD grants access by hand)
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'owner',              -- owner | setter
  created_at TEXT NOT NULL,
  last_login_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_account ON users(account_id);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS magic_links (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS account_settings (
  account_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (account_id, key)
);

CREATE TABLE IF NOT EXISTS instagram_accounts (
  account_id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL UNIQUE,
  username TEXT,
  token_enc TEXT,                                  -- encrypted long-lived token (null while the env token is in use)
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'connected',        -- connected | needs_reconnect | disconnected
  updated_at TEXT
);

ALTER TABLE conversations ADD COLUMN account_id TEXT;
ALTER TABLE messages ADD COLUMN account_id TEXT;
ALTER TABLE drafts ADD COLUMN account_id TEXT;
ALTER TABLE stage_events ADD COLUMN account_id TEXT;
CREATE INDEX IF NOT EXISTS idx_conv_account ON conversations(account_id, last_message_at);
CREATE INDEX IF NOT EXISTS idx_msg_account ON messages(account_id);
CREATE INDEX IF NOT EXISTS idx_draft_account ON drafts(account_id, status);

-- Existing single-tenant data → account acc_1.
INSERT OR IGNORE INTO accounts (id, name, access_status, created_at) VALUES ('acc_1', 'JD Osas Coaching', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
UPDATE conversations SET account_id = 'acc_1' WHERE account_id IS NULL;
UPDATE messages SET account_id = 'acc_1' WHERE account_id IS NULL;
UPDATE drafts SET account_id = 'acc_1' WHERE account_id IS NULL;
UPDATE stage_events SET account_id = 'acc_1' WHERE account_id IS NULL;
INSERT OR IGNORE INTO account_settings (account_id, key, value) SELECT 'acc_1', key, value FROM settings;

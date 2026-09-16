-- Days 11 to 13: unread state, prompt versions, per-lead profiles.
ALTER TABLE conversations ADD COLUMN last_seen_at TEXT;
ALTER TABLE conversations ADD COLUMN profile_json TEXT;
ALTER TABLE conversations ADD COLUMN profile_at TEXT;
ALTER TABLE messages ADD COLUMN prompt_version INTEGER;

CREATE TABLE IF NOT EXISTS prompt_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  version INTEGER NOT NULL,                 -- 1, 2, 3… per account
  hash TEXT NOT NULL,                       -- sha256 of the sections, dedups no-op saves
  sections_json TEXT NOT NULL,
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(account_id, version)
);
CREATE INDEX IF NOT EXISTS idx_msg_version ON messages(prompt_version);

-- Facebook Messenger channel: one connected Facebook Page per account.
-- token_enc is the Page access token, encrypted like Instagram tokens (null
-- while the first account runs on the FB_PAGE_TOKEN env var).
-- Conversations from Messenger use channel = 'messenger' and the lead's
-- Page-scoped id as external_id.
CREATE TABLE IF NOT EXISTS messenger_pages (
  account_id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL UNIQUE,
  page_name TEXT,
  token_enc TEXT,
  status TEXT NOT NULL DEFAULT 'connected',
  last_error TEXT,
  updated_at TEXT
);

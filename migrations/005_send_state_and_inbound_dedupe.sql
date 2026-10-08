-- Meta compliance: idempotent sends and webhook dedupe.
-- outbound_sends: one row per outbound Instagram message, written BEFORE the
-- Graph call (state 'sending') so a retried job or a restart mid-send can never
-- send the same message twice. States: sending | sent | failed | parked | unknown.
-- Only a hash of the text is kept here; the text itself lives in messages.
CREATE TABLE IF NOT EXISTS outbound_sends (
  idem_key TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  text_hash TEXT,
  state TEXT NOT NULL,
  mid TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbound_conv ON outbound_sends(conversation_id, state);
CREATE INDEX IF NOT EXISTS idx_outbound_state ON outbound_sends(state);

-- ig_inbound_events: every inbound webhook message id (mid) we have accepted.
-- A Meta retry of the same event hits the primary key and is dropped before it
-- can store a duplicate message or trigger a second AI reply. Pruned after 7 days.
CREATE TABLE IF NOT EXISTS ig_inbound_events (
  event_key TEXT PRIMARY KEY,
  account_id TEXT,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ig_inbound_received ON ig_inbound_events(received_at);

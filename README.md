# dmSetter

AI Instagram DM setter. A business connects its own Instagram professional account; dmSetter shows incoming DMs in an inbox, drafts replies in the owner's voice, qualifies leads and books calls. The owner approves drafts (Copilot) or lets a conversation reply on its own (Autopilot).

Stack: Node, Express, `node:sqlite`, plain JavaScript frontend in `public/` (no build step).

Instagram access is only through Meta's official **Instagram API with Instagram Login**, permissions `instagram_business_basic` and `instagram_business_manage_messages`. Every outbound message passes one gate (`lib/instagram.js`) that enforces Instagram's 24 hour window, never starts a conversation, never uses message tags, and rate limits sends. See [docs/META_REVIEW.md](docs/META_REVIEW.md) for the Meta dashboard setup and App Review, and [INSTAGRAM_SETUP.md](INSTAGRAM_SETUP.md) for connecting accounts.

## Run locally

Requires Node 22.5 or newer (`node:sqlite`); production runs Node 23 (`engines` in package.json).

```bash
npm install
# optional: create .env in this folder with the variables below
npm start              # http://localhost:5220
```

`server.js` loads `.env` from the project folder when it exists. With no Instagram variables set the Instagram channel stays dormant and the simulator (Simulator page) still works. With no `ANTHROPIC_API_KEY` the AI is off and conversations are flagged for a human.

Sign in: enter the `OWNER_EMAIL` address; the magic link is printed in the server log when `RESEND_API_KEY` is not set. The `x-admin-pin` header (`ADMIN_PIN`) maps to the first workspace for scripts.

## Environment variables

Core:

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default 5220; Railway sets it) |
| `DATA_DIR` | where the SQLite database, attachments, knowledge files and backups live. On Railway, the volume mount path (for example `/data`) |
| `OWNER_EMAIL` | first workspace owner and platform admin |
| `ADMIN_PIN` | legacy PIN for scripts (default 4242; change it) |
| `PUBLIC_BASE_URL` | public HTTPS origin, for example `https://app.example.co.uk` (falls back to `RAILWAY_PUBLIC_DOMAIN`) |
| `TOKEN_ENC_KEY` | 32 bytes as 64 hex chars (`openssl rand -hex 32`); encrypts Instagram tokens. Without it a key file is created in `DATA_DIR` |
| `ANTHROPIC_API_KEY` | AI drafting, photo descriptions, lead profiles |
| `RESEND_API_KEY`, `NOTIFY_FROM` | sign-in links and owner notifications |
| `OPEN_LOGIN_EMAILS` | temporary: addresses that sign in without an emailed link (use for the Meta reviewer, remove after) |

Instagram (Meta app):

| Variable | Purpose |
|---|---|
| `IG_APP_ID`, `IG_APP_SECRET` | Instagram app ID and secret (dashboard, API setup with Instagram login). Enables Connect Instagram |
| `META_APP_SECRET` | optional: the Meta App secret (App settings, Basic). Webhook signatures and signed requests verify with either secret |
| `IG_VERIFY_TOKEN` | webhook verify token, same string as in the dashboard |
| `IG_PAGE_TOKEN`, `IG_BUSINESS_ID` | legacy env token for the first workspace only; not needed with Instagram Login |

Messenger (Facebook Page, same Meta app):

| Variable | Purpose |
|---|---|
| `FB_PAGE_ID`, `FB_PAGE_TOKEN` | optional env Page for the first workspace. Otherwise each workspace connects its Page in Settings > Messenger with the Page ID and a Page access token (stored encrypted) |
| `FB_VERIFY_TOKEN` | optional Messenger webhook verify token; falls back to `IG_VERIFY_TOKEN` |

Messenger setup: add the Messenger product to the Meta app, request `pages_messaging`, set the webhook callback to `<PUBLIC_BASE_URL>/webhook/messenger` with the verify token, and subscribe the Page to `messages` and `message_echoes` (connecting in Settings subscribes it automatically). Webhooks are verified with `IG_APP_SECRET` or `META_APP_SECRET`, exactly like Instagram's. Messenger sends share Instagram's gate: the 24h window, the pause on reconnect and the send limits below.

Send limits (defaults shown; per workspace settings `rate_min_interval_sec`, `rate_max_per_hour`, `stale_send_minutes` can tighten them, never past 1s spacing, 200 an hour):

| Variable | Default | Meaning |
|---|---|---|
| `IG_RATE_MIN_INTERVAL_MS` | 2000 | minimum gap between two sends from one account |
| `IG_RATE_MAX_PER_HOUR` | 100 | sends per account per hour |
| `IG_RATE_MAX_QUEUE_WAIT_MS` | 60000 | a send that would wait longer than this for its slot is held for review |
| `IG_RATE_BACKOFF_MS` | 60000 | first back-off after a Meta rate-limit error (doubles, max 1 hour) |
| `IG_STALE_SEND_MINUTES` | 30 | queued work older than this after downtime is parked, not sent |

Legal pages (`/privacy`, `/terms`, `/data-deletion`):

| Variable | Purpose |
|---|---|
| `COMPANY_NAME` | registered company name |
| `COMPANY_EMAIL` | privacy and support contact |
| `COMPANY_ADDRESS` | registered office address |
| `COMPANY_NUMBER` | Companies House number |
| `COMPANY_ICO_NUMBER` | ICO registration number (optional) |
| `HOSTING_PROVIDER` | sub-processor line for hosting (default Railway) |
| `PRODUCT_NAME` | product name on the pages (default dmSetter) |

Unset company values show as a red placeholder on the pages.

Optional integrations: `GROQ_API_KEY` or `OPENAI_API_KEY` (voice note transcription), `SENTRY_DSN` (error reports), `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY`, `BACKUP_S3_SECRET_KEY`, `BACKUP_S3_ENDPOINT`, `BACKUP_S3_REGION`, `BACKUP_S3_PREFIX` (off-site backups; give the bucket a 30 day lifecycle rule), `FFMPEG_PATH`, `LOG_FORMAT`.

Testing only: `FAST_TIMERS=1` (collapses delays to seconds), `IG_GRAPH_BASE` (points the Graph client at a stub).

## Tests

```bash
npm test                                   # unit + end to end, no network
node public/tests/release-regressions.mjs  # frontend regressions
node public/tests/catchup-regressions.mjs
```

`npm test` runs:

- `test/pure.test.mjs`: pure functions (filters, prompt building, parsing, crypto, migrations).
- `test/meta-compliance.test.mjs`: the outbound gate (24h window on text, audio and sender actions; pause; throttle; caps; back-off), Meta error classification, scheduler parking (window, stale work after downtime, parked sends), autopilot guardrails, legal pages. The Graph API is a stubbed `fetch`.
- `test/isolation.test.mjs`: boots the server and checks tenant isolation.
- `test/meta-e2e.test.mjs`: boots the server against a local stub Graph API and drives every send path (manual send, approve, send all, Call Booked message, keyword opener) plus webhook dedupe, idempotent approval, restart mid-send, Meta error codes, legal pages and the Meta deletion and deauthorize callbacks.

No test calls a live provider.

## Deploy (Railway)

1. Create a service from the repo. `railpack.json` installs ffmpeg (voice note conversion). Start command is `npm start`.
2. Add a **volume** and set `DATA_DIR` to its mount path. Without a volume every deploy wipes the database.
3. Set the variables above. Add a custom domain and set `PUBLIC_BASE_URL` to it.
4. Deploy, then open `https://<domain>/health`.
5. Follow [docs/META_REVIEW.md](docs/META_REVIEW.md) for the Meta app (redirect URI, webhook, legal URLs, Business Verification, App Review).
6. Backups: nightly to `DATA_DIR/backups` (7 kept) and off-site when `BACKUP_S3_*` is set. Restore steps: [docs/RESTORE.md](docs/RESTORE.md).

Migrations in `migrations/` run automatically at boot (a snapshot is taken first).

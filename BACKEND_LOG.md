# Backend daily log (Claude)

## Day 1 — accounts and tenancy
Shipped on `beta/backend`:
- `lib/migrations.js` + `migrations/001_accounts.sql`: numbered SQL migrations run on boot; accounts, users, sessions, magic_links, account_settings, instagram_accounts; `account_id` on conversations, messages, drafts, stage_events. Existing data becomes `acc_1` (JD Osas Coaching, active).
- `lib/tenancy.js`: account context (AsyncLocalStorage). Every request runs as its session's account; every scheduler turn runs as the conversation's account; boot runs as acc_1; the HTTP server starts outside any context.
- Settings are per account (`account_settings`). New accounts are seeded with defaults + the starter script + AI off.
- `lib/auth.js`: magic-link login (`POST /api/auth/magic-link`, `GET /auth/magic`), sessions (30 days, httpOnly cookie), `GET /api/me`, `POST /api/logout`. Unknown email = sign-up (pending approval). The PIN header still works and maps to acc_1 so the current frontend keeps running.
- Scoped: conversations list, thread lookups, drafts, stats, content mining, handled-all, webhook ingestion (by Instagram business id → account).
Verified in a sandbox: PIN path unchanged; JD logs in by link; a new email gets a pending account with zero conversations, its own settings, and a 404 on JD's conversation ids; logout kills the cookie.
Deferred: Postgres (SQLite + WAL is fine for the beta; moving to Postgres means making every query async, which is a bigger risk than it is worth this fortnight). Knowledge-base and attachment folders are still shared across accounts (day 3).
Next (day 2): `requireAccount` on every route with `access_status` enforced, team/roles, email delivery for links via Resend, `OWNER_EMAIL` on Railway.

## Day 2 — access, admin, team, usage
Shipped on `beta/backend`:
- `migrations/002_admin_usage.sql`: `users.is_platform_admin`, `account_audit`, `ai_usage`.
- Access enforcement: pending/paused accounts get a 403 with a plain sentence on every AI and send route; the scheduler sees them as kill-switched and `deliver()` refuses, so nothing queued goes out either.
- Platform admin (the OWNER_EMAIL user): list accounts, activate/pause with an audit trail, per-account usage and audit views.
- Team: list, invite by email (sends a sign-in link), remove. Owner role only for changes.
- AI usage metering: every Anthropic response (engine, follow-up rewording, content mining) is recorded per account/day/model; `/api/usage` returns the month and 30 daily rows with an estimated USD cost at list prices.
- Contract additions appended to WORK_SPLIT.md (covers all four of Astra's requests except the async test drive, which is day 7).
Verified in a sandbox: second account created pending; JD listed as platform admin; pause → preview refused; activate → audit shows both; invite/list/remove; a real AI call metered (116 in / 168 out, $0.02).
Next (day 3): per-account knowledge-base and attachment folders, per-account Calendly settings and refresh, `OWNER_EMAIL` + `RESEND_API_KEY` on Railway, then templates (day 4).

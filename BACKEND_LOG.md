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

## Days 3 to 5 — per-account resources, templates, checks, onboarding
Shipped on `beta/backend`:
- Knowledge base per account (`DATA_DIR/knowledge/<account>/`, the first account's files moved in on boot). Upload routes re-enter the account context after multer (its callbacks drop AsyncLocalStorage; found in testing when a new account's upload landed in acc_1).
- Calendly per account: token and "book in DMs" from account settings, availability cache per account (stale after 2h is dropped), webhook URL per account.
- Five script templates in `prompts/templates/` with `GET /api/templates` and `POST /api/settings/apply-template`. New accounts no longer get the JD starter; the wizard applies a template.
- `GET /api/script/assembled` (the prompt as the AI sees it), `GET /api/script/checks` (errors block go-live: empty core sections, no next-step link; warns: missing name, no confirm step, unfilled [placeholders], no follow-up text).
- `GET /api/onboarding` step status, `POST /api/onboarding/go-live` (active accounts only, no error-level checks; turns the kill switch off and default mode to autopilot, audited).
- New settings: template_id, next_step_type/link, currency, timezone, country, test_drive_passed_at.
Verified: new account signs up pending → applies the agency template → checks list the placeholders → go-live 403 while pending → JD approves → go-live 400 until a booking link is set → go-live ok; knowledge and prompts isolated between accounts; JD's real script passes all checks.
Next (day 6): Instagram OAuth per account, token refresh, disconnect, signature enforcement.

## Days 6 to 10 — Instagram login, test drive, isolation tests, ops
Shipped on `beta/backend`:
- **Instagram login per account** (`lib/instagram.js` now reads credentials through a per-account resolver; the first account keeps the env token until it reconnects). OAuth start/callback with a state token, 60-day token stored encrypted (AES-256-GCM, `lib/crypto.js`, key from TOKEN_ENC_KEY or a generated key file on the volume), webhook subscription on connect, daily refresh (10 days before expiry; failure → needs_reconnect + email), disconnect. Webhook events route by `entry.id` to the owning account; unknown ids are dropped unless the env token is still in use. Signatures are enforced whenever IG_APP_SECRET exists, which OAuth requires, so every OAuth-era account is verified.
- **Test drive** (`lib/testdrive.js`): in-memory job, Claude plays the persona, the engine plays the setter, Haiku grades each transcript with up to three notes. Nothing touches the inbox. Passed jobs set test_drive_passed_at.
- **Tenant isolation suite** `test/isolation.test.mjs` (`npm test`): 22 checks across two accounts (visibility, settings, admin gating, template isolation, Instagram shape, OAuth error paths, export, delete). All green.
- **Ops**: Sentry reporting without the SDK (`lib/errors.js`, express error middleware + process hooks, 30 events/min cap), structured logs with the account id on every line (`lib/logs.js`, LOG_FORMAT=json), nightly backup copied to any S3-compatible bucket (`lib/offsite.js`, SigV4 by hand), `GET /api/admin/ops`.
- **Data**: `GET /api/account/export`, `DELETE /api/account` (confirm with the owner email), admin delete. The first account can never be deleted through the API.
Verified: sandbox test drive on JD's real script (price hunter + warm lead). The warm lead passed clean. The price hunter run asked the money question before any pain question, which the grader flagged. That is the script being followed loosely by the model, not a code bug, and it is exactly what the test drive is for.
Not done: nothing from the plan. Day 9 was shipped on day 2.

## Days 11 to 17 — inbox realtime, versions, profiles, vision, analytics, support view, Meta prep
Shipped on `beta/backend`:
- **Unread and live updates** (E.1, E.6): last_seen_at, unread counts and waiting_since on the list; `POST /:id/seen`; `GET /api/events` server-sent events per account, bumped from message, draft, mode, stage and flag writes.
- **Prompt versions** (E.8): every section change on save becomes a version; AI messages are stamped with the version they ran under; booked rate per version; restore records a new version.
- **Per-lead profile** (E.9): Haiku keeps goal, blocker, budget signal, objections and facts per conversation, refreshed 20s after the lead speaks; the engine gets it in the system note so nothing is asked twice, even past the 40-message history cap.
- **Vision on photos** (E.10) and **per-account transcription key** (E.11).
- **Per-lead booking links** (E.12): utm_content on the Calendly link; bookings match on it before handle or name.
- **Analytics** (E.15): outcomes, AI-only vs human-assisted conversion, per-version booked rate, lead messages by hour, median hours to booking, revenue estimate from client_value.
- **Support view** (F.4): read-only overview of any account for the platform admin, no message text.
- **Tests** (F.6): `test/pure.test.mjs` on the pure functions plus the isolation suite (27 checks). Found and fixed a real bug: Haiku usage was priced at Sonnet rates because the dated model id did not match the price table.
- **Meta prep** (G.2): signed data-deletion callback, status page with confirmation code, `docs/META_REVIEW.md` checklist, `docs/RESTORE.md` runbook, `GET /health`.
Left for JD: business verification and the screencast (G.1, G.3) need him; the Stripe epic stays out by his decision.

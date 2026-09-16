# Two-week beta: who builds what

Two agents, one repo, clear ownership. **Claude** owns the server. **Astra** owns the browser. JD is the referee and the only one who deploys is Claude.

Target at the end of week 2: a second business can be hand-onboarded (as a Meta tester), connect their Instagram, load a script template, test it against simulated leads, receive JD’s manual approval, and go live. JD handles payments independently outside this app; no Stripe, subscription plans, automatic trials or billing screens are part of this beta. Meta app review starts after, in parallel with the polish.

---

## Ownership by file (ownership boundaries)

| Lane | Owns | Never touches |
|------|------|---------------|
| **Claude (backend)** | `server.js`, `lib/**`, `prompts/**`, `migrations/**`, `scripts/**`, `package.json`, `.env.example`, `railpack.json`, deploys, database | `public/**` |
| **Astra (frontend)** | `public/**` (index.html, and any `public/js/*.js`, `public/css/*.css` it splits out) | everything else |

If a frontend feature needs a backend change that isn't in the contract below, Astra writes it down in `CONTRACT_REQUESTS.md` (one line: endpoint, shape, why) and builds against a local mock until it lands. Blocking contract changes are agreed before dependent work proceeds. CONTRACT_REQUESTS.md and ASTRA_LOG.md are explicit frontend ownership exceptions. Development fixtures must be opt-in and must never fall back silently in production.

Branches: Claude on `beta/backend`, Astra on `beta/frontend`. Both merge into `main` through JD. No force pushes. Commit messages say what changed and why, in plain English.

---

## Week 1

| Day | Claude (backend) | Astra (frontend) |
|-----|------------------|------------------|
| 1 | Postgres alongside SQLite; numbered SQL migrations run on boot; `accounts`, `users`, `sessions` tables; JD's data becomes account #1 | Split `index.html` into `public/js/{api,state,ui,pages/*}.js` with plain script tags (no build step, no framework); zero behaviour change; light mode fixed or removed |
| 2 | Magic-link login: `POST /api/auth/magic-link`, `GET /auth/magic`, `GET /api/me`, `POST /api/logout`; session cookie replaces the PIN header; `requireAccount` middleware | Login screen: email box → "check your email" → landed. Replaces the PIN gate. Uses `/api/me` for the shell (account name, access status, Instagram status dot) |
| 3 | Every query scoped to `account_id` (conversations, messages, drafts, stage_events, settings); per-account settings; per-account kill switch and default mode | Remove the 13 stub controls; generic copy pass (no "coach", "fitness", "physique"; say offer, customer, next step) |
| 4 | Script templates: `prompts/templates/*.json` (fitness coach, online course, agency, e-com, consultant); `GET /api/templates`, `POST /api/settings/apply-template` | Template picker on the Prompt page; "Fill empty sections" takes a template; "What the AI sees" read-only panel (`GET /api/script/assembled`) |
| 5 | Script quality checks `GET /api/script/checks`; conversion goal setting (call / checkout link / form / human) in settings; regional currency defaults per account | Onboarding wizard shell (5 steps, progress, resume where you left off) driven by `GET /api/onboarding`; step 2 (template) and step 3 (sections) wired; quality checks shown inline |

## Week 2

| Day | Claude (backend) | Astra (frontend) |
|-----|------------------|------------------|
| 6 | Instagram OAuth: `instagram_accounts` table, encrypted tokens, `GET /auth/instagram/start`, `/auth/instagram/callback`, `POST /api/instagram/disconnect`; webhook routing by account; token refresh job; signature verification mandatory | Onboarding step 1 (Connect Instagram button → OAuth → connected state → reconnect banner when `needs_reconnect`); Settings Instagram card rebuilt on the new status shape |
| 7 | Test drive: `POST /api/onboarding/test-drive` runs the script against 5 generic sim personas and returns transcripts; go-live: `POST /api/onboarding/go-live` | Onboarding step 5: transcripts side by side, pass/fail notes, "Go live" button; step 4 (next-step link) |
| 8 | JD-only account activation/pause; enforce access in all AI generation and send paths, including queued jobs; tenant-isolation tests and migration rehearsal | Access-status banner: pending approval / active / paused; no billing page; verify onboarding and inbox against the integrated backend |
| 9 | AI usage metering per account per day (tokens, cost); `GET /api/usage`; team invites `GET/POST/DELETE /api/team` | Internal operator usage view; Team Members card real (invite, role, remove); unread state UI (bold rows, count, "waiting longest" sort, title counter) using `unread` on rows and `POST /api/conversations/:id/seen` |
| 10 | Error tracking (Sentry), nightly backups off-box, structured logs with account id, data export and account deletion endpoints | Mobile inbox: prospect panel as a bottom sheet, `100dvh`, 16px inputs, 44px targets; verify mobile behaviour and account-access states; push and undo deferred |

Integrate a working slice daily in separate worktrees, with JD coordinating merges. Days 11 to 14: final end-to-end verification, JD onboards himself from scratch as a fresh account, then one outside beta user. Bugs only.

---

## API contract (Astra builds against this; Claude ships it in this order)

All JSON. All endpoints require the session cookie except the auth and webhook ones. Errors are `{ "error": "plain sentence" }` with a 4xx/5xx status. Until the auth endpoints land (day 2), the existing `x-admin-pin` header still works so Astra can develop against the current server.

### Auth
```
POST /api/auth/magic-link   { "email": "jd@example.com" }              → 200 { "ok": true }
GET  /auth/magic?token=…    sets the session cookie, redirects to /
GET  /api/me                → { "user": { "id", "email", "role": "owner"|"setter" },
                               "account": { "id", "name", "access_status": "pending"|"active"|"paused" },
                               "instagram": { "connected": bool, "username": "jd.osas"|null, "needs_reconnect": bool, "signature_verified": bool },
                               "onboarding_complete": bool }
POST /api/logout            → 200
```

### Settings and script (existing shapes stay)
```
GET  /api/settings                    → { "settings": {…all keys…}, "stages": [...], "modes": [...], "aiReady": bool }
PUT  /api/settings                    { any subset of keys } → { "ok": true, "settings": {…} }
GET  /api/templates                   → [ { "id": "fitness-coach", "name", "description", "sections": { "prompt_persona": "…", … } } ]
POST /api/settings/apply-template     { "id": "fitness-coach", "only_empty": true } → { "ok": true, "filled": ["prompt_persona", …] }
GET  /api/script/assembled            → { "text": "…the full system prompt as the AI sees it…" }
GET  /api/script/checks               → [ { "section": "prompt_booking", "level": "warn"|"error", "message": "Never says how to confirm the booking." } ]
```

### Onboarding
```
GET  /api/onboarding                  → { "steps": { "instagram": bool, "template": bool, "sections": bool, "next_step": bool, "test_drive": bool, "live": bool } }
POST /api/onboarding/test-drive       { persona_ids?: [...] } -> 202 { job_id }
GET /api/onboarding/test-drive/:id    -> { status: queued|running|complete|failed, completed, total, runs, error? }
                                      runs: [{ persona: { id, name }, transcript: [{ role, text }], final_stage, notes }]
                                      (bounded asynchronous job; poll for progress)
POST /api/onboarding/go-live          → { "ok": true }   (requires active access and server-validated setup; then turns the customer kill switch off and sets default mode autopilot; never bulk-enables existing threads)
```

### Instagram
```
GET  /api/instagram/status            → same object as /api/me.instagram plus { "webhook_url", "verify_token_set" }
GET  /auth/instagram/start            → 302 to Meta login
GET  /auth/instagram/callback         → 302 to /?connected=1 (or /?connect_error=…)
POST /api/instagram/disconnect        → { "ok": true }
```

### Inbox additions
```
GET  /api/conversations               rows gain: "unread": int, "last_seen_at": iso|null, "waiting_since": iso|null
POST /api/conversations/:id/seen      → { "ok": true }
POST /api/conversations/handled-all   { "send_failed_only": bool } → { "ok": true, "cleared": n }   (exists)
```

### Access, usage, team
```
GET  /api/usage                       → { "month": { "conversations": n, "ai_messages": n, "ai_cost_gbp": 12.40, "bookings": n }, "daily": [ { "date", "ai_cost_gbp", "ai_messages" } ] }
GET  /api/team                        → [ { "id", "email", "role", "invited_at", "accepted": bool } ]
POST /api/team/invite                 { "email", "role": "setter" } → { "ok": true }
DELETE /api/team/:id                  → { "ok": true }
```

### Persona ids for test drive
`price_hunter`, `warm_keyword`, `think_about_it`, `broke`, `skeptic`, `ghost`, `dream_buyer`, `tirekicker`, `underage`, `no_time`, `diy` (briefs are generic, editable later per account).

---

## Definition of done for the beta

- A brand new email can sign up, log in, connect an Instagram test account, pick a template, pass the quality checks, run the test drive, receive JD’s approval, and go live. Payments are handled independently by JD.
- JD's live account keeps working throughout, with no gap in DMs.
- No PIN anywhere in the released beta; keep legacy auth working during frontend extraction until session endpoints land. No `IG_PAGE_TOKEN` in env; tokens live encrypted per account.
- Every page usable on a phone.
- `npm test` runs the pure-function tests green.

## Not in these two weeks
Meta app review (G), prompt versions (E.8), per-lead memory (E.9), server-sent events (E.6), analytics (E.15), the full module split of `server.js` (F.7).

MANUAL ACCESS CONTRACT AND RELEASE GATES
----------------------------------------
Payments are external. No Stripe SDK, checkout, customer portal, subscription tiers, trial clock or payment webhooks. A customer's own checkout URL remains a valid conversion goal.
New accounts start with access_status=pending. JD's existing account migrates as active. The platform operator (JD) is a separate server-authorized privilege, not the customer owner role. Only JD can change access; ordinary settings writes must reject it.
GET /api/admin/accounts -> { accounts: [{ id, name, access_status }] } (JD only)
PATCH /api/admin/accounts/:id/access { access_status: active|paused, reason?: string } -> { ok: true, account: { id, name, access_status } } (JD only; audit actor/time/reason)
Pending/paused accounts can sign in, read their own inbox and configure onboarding. Pending accounts may run bounded simulations for setup. Paused accounts cannot run AI previews/simulations. No live outbound send or scheduled automation may run for pending/paused accounts. Recheck access immediately before delivery; manual customer kill_switch cannot bypass the platform pause. Activation alone does not enable autopilot.
GET /api/me exposes access_status, separately from Instagram connection health and the customer kill_switch. No plan/trial/payment fields.
Keep token/cost metering for internal operations, including retries, simulations and content generation. Pricing is not shown in the product. JD can inspect per-account costs through GET /api/admin/accounts/:id/usage (same usage shape; JD only).
Day 8 replaces billing with access control and isolation testing. A minimal JD-only access screen belongs to the frontend lane once operator authorization is defined; backend must supply a trusted is_platform_admin capability in /api/me.user.
Tenancy includes documents, attachments, scheduler jobs, delayed sends, caches, Calendly, notifications, simulator runs, exports and deletion, not just SQL queries.
The release gate includes two-account cross-access tests, duplicate webhook handling, paused-account queued-send tests, and a rehearsed migration/rollback. Pure-function tests alone do not certify the beta.
Push notifications and undo are deferred until server delivery/subscription and delayed-send/cancellation contracts are agreed. Do not ship toast-only substitutes. Team/unread work follows the core onboarding path; decide per-user read state before implementation.
Test-drive contract revision: POST /api/onboarding/test-drive returns 202 { job_id }; GET /api/onboarding/test-drive/:id returns { status: queued|running|complete|failed, completed, total, runs, error? }. Jobs are account-scoped with bounded turns/cost/retries.
This is a two-week implementation target, not a guarantee; release gates determine readiness.

---

## Day 2 contract additions (shipped on beta/backend; Astra's requests from CONTRACT_REQUESTS.md)

```
GET  /api/me                          user gains "is_platform_admin": bool; account.access_status is pending|active|paused (no plan/trial fields)

Platform admin (JD only; 403 for everyone else)
GET  /api/admin/accounts              → [ { "id", "name", "access_status", "owner_email", "users", "conversations", "last_login_at", "instagram_business_id", "created_at" } ]
PATCH /api/admin/accounts/:id/access  { "status": "pending"|"active"|"paused" } → { "ok", "id", "access_status" }   (audited)
GET  /api/admin/accounts/:id/usage    → same shape as /api/usage
GET  /api/admin/accounts/:id/audit    → [ { "action": "access:paused"|"access:active"|"team:invite"|"team:remove", "detail", "actor_user_id", "at" } ]

Usage (own account)
GET  /api/usage                       → { "month": { "calls", "ai_messages", "input_tokens", "output_tokens", "cost_usd", "conversations", "bookings" }, "daily": [ { "day", "calls", "input_tokens", "output_tokens", "cost_usd" } ], "note" }
                                        cost_usd is an estimate at Anthropic list prices (there is no gbp field)

Team (owner role only for invite/remove)
GET  /api/team                        → [ { "id", "email", "role": "owner"|"setter", "accepted": bool, "created_at", "last_login_at" } ]
POST /api/team/invite                 { "email", "role" } → { "ok": true }    (409 if the email already has a login; sends a sign-in link)
DELETE /api/team/:id                  → { "ok": true }                        (400 when removing yourself)

Access enforcement
- pending / paused accounts get 403 with a plain-sentence error on: send, request-draft, preview, approve, send-all, content analyze/more.
- The scheduler treats a non-active account as kill-switched, and deliver() refuses sends for it, so queued follow-ups and sequences never go out either.
- Frontend: show a banner from account.access_status; the AI Preview and Approve buttons should be disabled with the same wording when not active.
```

## Days 3 to 5 contract notes (shipped on beta/backend)

```
GET  /api/templates                   → [ { "id", "name", "description", "sections": {…} } ]   five templates: fitness-coach, online-course, agency, ecommerce, consultant
POST /api/settings/apply-template     { "id", "only_empty": true } → { "ok", "filled": [...] }   also sets settings.template_id
GET  /api/script/assembled            → { "text" }
GET  /api/script/checks               → [ { "section", "level": "error"|"warn", "message" } ]   section can also be "next_step" or "coach_name"; errors block go-live
GET  /api/onboarding                  → { "steps": { instagram, template, sections, next_step, test_drive, live }, "access_status" }
POST /api/onboarding/go-live          → { "ok": true } | 400 { "error", "checks": [errors] } | 403 when not active

New settings keys (all strings, PUT /api/settings as usual):
  template_id, next_step_type ("call"|"checkout"|"form"|"human"), next_step_link, currency ("GBP"), timezone, country, test_drive_passed_at
  Calls use calendar_link; checkout/form use next_step_link; "human" needs no link.

New accounts start with EMPTY script sections (no starter seeded): the wizard applies a template. The knowledge base is per account.
Calendly: each account has its own token/availability; webhook URL is /webhook/calendly/<account id> (the first account keeps /webhook/calendly).
```

## Days 6 to 10 contract notes (shipped on beta/backend)

```
Instagram (per account)
GET  /auth/instagram/start            → 302 to Instagram login (needs IG_APP_ID + IG_APP_SECRET on the server; 503 page otherwise)
GET  /auth/instagram/callback         → 302 /?connected=1 | /?connect_error=<message>
POST /api/instagram/disconnect        → { "ok" }   owner only; turns the kill switch on
/api/me.instagram and /api/instagram/status now carry:
  { connected, username, business_id, needs_reconnect, expires_at, via: "oauth"|"env"|null, oauth_available, connect_url: "/auth/instagram/start"|null, signature_verified }
  plus on /status: webhook_url, verify_token_set, auth_error, account (live Graph check)
Tokens refresh themselves daily; a failed refresh sets needs_reconnect (show the reconnect banner).

Test drive (async; poll)
POST /api/onboarding/test-drive       { "persona_ids": [...] | omitted for the default 5 } → 202 job
       job = { id, status: "running"|"done"|"error", passed: bool|null, started_at, finished_at, error,
               runs: [ { persona: { id, name, handle }, status, transcript: [ { role, text } ], final_stage, flagged, flag_reason, verdict: "pass"|"warn"|"fail"|null, notes: [..] } ] }
       ?wait=1 blocks up to 90s and returns the finished job (old synchronous contract). 409 while one is running, 400 when the script has error-level checks, 503 without AI.
GET  /api/onboarding/test-drive       → [ jobs, newest first ]
GET  /api/onboarding/test-drive/:id   → job
A passed job sets settings.test_drive_passed_at (onboarding step test_drive turns true).
Persona ids: warm_keyword, price_shock (alias price_hunter), think_about_it, broke_student (alias broke), no_time, skeptic, diy, ghost, dream_buyer, tirekicker, under_18 (alias underage).

Account data
GET    /api/account/export            → JSON download of everything the account owns (owner only)
DELETE /api/account                   { "confirm": "<owner email>" } → { "ok" }; logs the user out. Not allowed on the first account.
DELETE /api/admin/accounts/:id        → { "ok" }   platform admin
GET    /api/admin/ops                 → { sentry, offsite_backups, log_format, instagram_oauth, signature_verified, email, last_backup, accounts: [{access_status, n}], instagram_accounts: [{status, n}] }
```

Server env (all optional): IG_APP_ID, IG_APP_SECRET (Instagram login + signature checks), TOKEN_ENC_KEY (64 hex chars; auto-generated into DATA_DIR/.token_key otherwise), SENTRY_DSN, LOG_FORMAT=json, BACKUP_S3_BUCKET / BACKUP_S3_ACCESS_KEY / BACKUP_S3_SECRET_KEY (+ BACKUP_S3_ENDPOINT, BACKUP_S3_REGION, BACKUP_S3_PREFIX).
`npm test` boots the server on a scratch folder and runs the tenant isolation suite.

## Days 11 to 17 contract notes (shipped on beta/backend)

```
Inbox
GET  /api/conversations               rows gain: unread (int, lead messages since last_seen_at), waiting_since (iso|null: lead spoke last, nobody answered)
POST /api/conversations/:id/seen      → { "ok" }
GET  /api/events                      server-sent events, cookie auth. "hello" on open, then
                                      event: change  data: { "type": "message"|"draft"|"conversation"|"settings", "id": conversation id|null }
                                      Refetch what the page shows on each event; keep the poll as a fallback at 30s when the stream is open.
Conversation rows carry "profile": { goal, blocker, budget_signal, objections[], facts[], next_step_status, updated_at } | null   (E.9; show it in the prospect panel)

Prompt versions (E.8)
PUT  /api/settings                    response gains "prompt_version": n   (a save that changes any section records a new version)
GET  /api/prompt/versions             → [ { id, version, note, created_by, created_at, current, ai_messages, conversations, booked, booked_rate } ]
GET  /api/prompt/versions/:version    → { …, "sections": { prompt_persona … } }
PUT  /api/prompt/versions/:version    { "note" } → { "ok" }
POST /api/prompt/versions/:version/restore → { "ok", "version", "settings" }   (records a new version "restored from vN")

Analytics (E.15)
GET  /api/analytics?days=30           → { window_days, leads: { total, keyword, instagram, simulator }, outcomes: { call_booked, sale, routed, dead },
                                          conversion: { ai_only: { conversations, booked, rate }, human_assisted: {…} }, by_version: [...],
                                          lead_messages_by_hour: [24 ints], median_hours_to_booking, revenue: { sales, client_value, currency, estimated } }
New settings: client_value (number as string), groq_api_key (secret; settings expose groq_key_set), lead_profiles "1"|"0", image_vision "1"|"0"

Admin (F.4)
GET  /api/admin/accounts/:id/overview → { account, users, settings (subset), script: { checks, version, sections_filled, sections_total }, instagram, counts, recent_conversations (no text), audit }

Other
GET  /health                          → { ok, uptime_s }
POST /webhook/meta/data-deletion      Meta's data deletion callback (signed_request) — configure its URL in the Meta app
Booking links the AI sends carry ?utm_content=<conversation id>; Calendly bookings match on it first (E.12).
Inbound photos from leads arrive as "[photo: one-line description]" when image_vision is on (E.10).
```

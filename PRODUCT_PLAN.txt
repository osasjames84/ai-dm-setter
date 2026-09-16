# dmSetter → shippable product

Goal: any business that sells through Instagram DMs (coaches, agencies, course creators, e-com, consultants) can sign up, connect their Instagram, paste their own script, switch autopilot on, and pay monthly.

Rules for this plan:
- Every feature is small enough to ship on its own (S = under a day, M = 1 to 3 days, L = about a week).
- "Start now" means nothing outside our control blocks it.
- Meta app review is the only external gate, so it comes last. Everything else is built and tested on JD's own account first.

---

## 0. Positioning: any DM-based offer  (all start now)

| # | Feature | Size | Notes |
|---|---------|------|-------|
| 0.1 | Script templates instead of one starter script | M | `prompts/starter.json` becomes `prompts/templates/*.json`: fitness coach, online course, agency / done-for-you, e-com brand, consultant. Prompt page shows a template picker; "Fill empty sections" takes a template. |
| 0.2 | Generic copy everywhere | S | Remove "coach", "fitness", "physique", "call" assumptions from UI labels, placeholders and hints. "Offer", "customer", "next step" instead. |
| 0.3 | Generic simulator personas | S | The 11 sim leads become offer-agnostic (price hunter, ghost, tyre-kicker, dream buyer…) and their briefs are editable per account. |
| 0.4 | Booking is a "next step", not always a call | S | Settings choose the conversion goal: book a call, send a checkout link, send a form, hand to a human. Stage names stay, labels adapt. |
| 0.5 | Currency and region defaults per account | S | Currency symbol, timezone, country list for the regional pricing block. |

## A. Foundations: accounts and tenancy  (start now, everything depends on this)

| # | Feature | Size | Depends on |
|---|---------|------|------------|
| A.1 | Postgres alongside SQLite | M | – | 
| A.2 | Schema migration tool (numbered SQL files, run on boot) | S | A.1 |
| A.3 | `accounts` and `users` tables, `account_id` on conversations, messages, drafts, stage_events, settings | M | A.2 |
| A.4 | Email magic-link login (replaces the PIN); sessions; logout everywhere | M | A.3 |
| A.5 | Every query scoped to `req.accountId` (one pass through server.js; ~120 sites) | L | A.3 |
| A.6 | Per-account settings (settings table keyed by account) | S | A.3 |
| A.7 | Team members: owner and setter roles, invite by email (the stubbed card becomes real) | M | A.4 |
| A.8 | Encrypted secrets column (tokens, signing keys) with a master key in env | S | A.3 |
| A.9 | Per-account kill switch, default mode, and usage counters | S | A.6 |
| A.10 | Data export and account deletion (per account and per lead; also needed for Meta) | M | A.5 |

## B. Instagram connect  (build and test now on JD's account; review needed only to open it to others)

| # | Feature | Size | Depends on |
|---|---------|------|------------|
| B.1 | `instagram_accounts` table: business id, encrypted token, expiry, status | S | A.8 |
| B.2 | "Connect Instagram" OAuth flow (Meta login → long-lived token → stored) | M | B.1 |
| B.3 | Token refresh job (before the 60-day expiry) and a "reconnect" banner when Meta invalidates one | S | B.1 |
| B.4 | Webhook routing by account: resolve which account an event belongs to from the recipient id | M | B.1 |
| B.5 | App secret enforced (signature verification mandatory once B.2 exists) | S | B.2 |
| B.6 | Disconnect Instagram (the stubbed button becomes real) | S | B.2 |
| B.7 | Referral and story context captured on each new lead (which reel / story / ad) | S | – |

## C. Onboarding  (start now)

| # | Feature | Size | Depends on |
|---|---------|------|------------|
| C.1 | Sign-up page → account created → first login | S | A.4 |
| C.2 | Setup wizard: 1 connect Instagram, 2 pick template, 3 fill the five sections that matter, 4 add booking / checkout link, 5 test drive | M | 0.1, B.2 |
| C.3 | Test drive: run the script against 5 simulated leads and show the transcripts side by side | M | 0.3 |
| C.4 | Section quality checks ("your Booking Sequence never says how to confirm", "no next-step link set") | S | – |
| C.5 | "What the AI sees" panel: the assembled prompt, read-only | S | – |
| C.6 | Go-live checklist and the kill switch default off until it passes | S | C.2 |

## D. Billing  (start now, Stripe test mode)

| # | Feature | Size | Depends on |
|---|---------|------|------------|
| D.1 | Stripe customer per account, checkout, customer portal | M | A.3 |
| D.2 | Plans: starter / pro (by conversations per month), 7-day trial | S | D.1 |
| D.3 | AI usage metering: tokens and cost per account per day (the engine already knows model and usage) | S | A.9 |
| D.4 | Hard stop: AI pauses when the trial ends or the card fails, inbox stays readable | S | D.2 |
| D.5 | Usage page: messages handled, AI cost, bookings, this month | S | D.3 |

## E. Product hardening  (start now; from the audit)

| # | Feature | Size |
|---|---------|------|
| E.1 | Unread state: `last_seen_at`, bold rows, unread count, "waiting longest" sort, title counter | M |
| E.2 | Mobile: prospect panel as a bottom sheet, `100dvh`, 16px inputs, 44px targets | M |
| E.3 | Remove or wire every stub control (13 today) | S |
| E.4 | Browser push notification and sound for hot leads and flags | S |
| E.5 | Undo on send (5s), confirm on discard and delete | S |
| E.6 | Server-sent events replacing the 5s poll | M |
| E.7 | Light mode finished or removed | S |
| E.8 | Prompt versions: every save is a version, each AI message tagged, booked-rate per version | M |
| E.9 | Per-lead profile (goal, blocker, budget signal, objections raised) extracted after each turn and injected | M |
| E.10 | Vision on inbound images (booking screenshots, payment confirmations) | S |
| E.11 | Transcription on by default (Groq key per account or ours) | S |
| E.12 | Per-lead booking links (`utm_content=<conversation id>`) so Calendly bookings match exactly | S |
| E.13 | Heart reactions actually sent, or the feature removed | S |
| E.14 | Keyboard shortcuts in the inbox | S |
| E.15 | Analytics: revenue per outcome, lead source from B.7, AI-only vs human-assisted conversion | M |

## F. Operations  (start now)

| # | Feature | Size |
|---|---------|------|
| F.1 | Error tracking (Sentry) and uptime alerts | S |
| F.2 | Backups off the box (nightly to S3 / R2), restore runbook | S |
| F.3 | Structured logs with account id, no message content | S |
| F.4 | Admin view: list accounts, open one read-only for support | M |
| F.5 | Status page and incident email | S |
| F.6 | Unit tests on the pure functions, `npm test` in CI, the three old scripts retired | M |
| F.7 | Split `server.js` and `index.html` into modules (do it as each area is touched, not as a big bang) | L |

## G. Meta app review  (last; calendar time, not build time)

| # | Step | Notes |
|---|------|-------|
| G.1 | Business verification for the company that will own the app | Start the paperwork early; it can take weeks. |
| G.2 | Privacy policy, terms, data deletion endpoint live on the product domain | A.10 covers the endpoint. |
| G.3 | Screencast of the full flow: connect, receive a DM, AI reply, human approve | Recorded on the finished onboarding. |
| G.4 | Request `instagram_business_manage_messages` Advanced Access | Submit with the screencast; expect one round of feedback. |
| G.5 | Switch the app from Development to Live | Only then can other people's accounts connect. |

---

## Suggested order

1. **Week 1 to 2:** A.1 to A.6 (Postgres, accounts, tenancy, login). JD's data migrates into account #1. Nothing user-visible changes.
2. **Week 2 to 3:** 0.1 to 0.5 and E.3 (templates, generic copy, stubs gone). Product starts looking like a product.
3. **Week 3 to 4:** B.1 to B.6 tested on JD's own Instagram in Development mode; E.12; F.1, F.2.
4. **Week 4 to 5:** C.1 to C.6, D.1 to D.5. First outside beta user can be onboarded manually (their account added to the Meta app as a tester).
5. **Week 5 to 7:** E.1, E.2, E.4, E.5, E.8, E.9, E.10, E.11. The setter gets smarter and the inbox gets faster.
6. **Week 7+:** G.1 to G.5 in parallel with E.6, E.15, F.4 to F.7.

First paying customer is realistic after step 4, as a Meta tester, before review completes.

# SetDM Clone — Build Brief for Claude Code

<!-- Owner's brief. The main thread acts as ARCHITECT/REVIEWER; builder subagents implement. -->

## Workflow — strict token economy

Main thread = ARCHITECT/REVIEWER. No implementation code in the main thread. A builder subagent implements each phase; the reviewer re-runs verification independently, lists defects with file:line, loops until pass. Never accept "should work". Build fully locally; the owner deploys manually at the end.

Phases: (1) data model + API, (2) AI setter engine, (3) inbox UI, (4) simulator + follow-up scheduler, (5) Instagram webhook layer, (6) full end-to-end review pass.

## Mission

Clone the concept of SetDM (setdm.app): a funnel-based Instagram DM inbox where an AI setter qualifies leads and books sales calls, with human oversight. Built for ONE business, not multi-tenant. Audit what exists first and build on it — do not restart.

## Business configuration — do NOT hardcode any business content

Like SetDM, the app must expose editable prompt sections in settings where the owner pastes his own business context: (1) offer/context, (2) qualification flow, (3) routing rules & links, (4) voice/persona rules, (5) hard rules (things the AI must never do). The AI engine composes its system prompt from these sections at runtime. Ship them EMPTY or with neutral placeholders — the owner inserts his personal prompt himself. The only behaviors baked into code (not prompt) are the universal guardrails: the structured output contract, needs_human triggers, autopilot limits, and a configurable post-send filter (regex list in settings, e.g. block currency+digits) that redirects matching drafts to human review.

## Core product requirements

- **Funnel inbox**: conversations move `new → qualifying → qualified → booked | routed | dead`. Board/columns UI with cards (lead, last message, time-ago, mode badge, pending-draft flag), click into full thread view.
- **AI reply engine** returns structured output: `{ messages: [1-2 strings], stage: suggestion, needs_human: bool, reason }`. `needs_human` triggers: abuse, medical red flags, payment/refund talk, suspicion about who's typing, anything off-script.
- **Three modes** (per-conversation + global default + global kill switch):
  - **Copilot (default)**: AI drafts → human approves/edits/discards before send.
  - **Autopilot**: auto-send after a randomized humanizing delay (60–180s). Guardrails: max 2 consecutive AI sends without a lead reply; `needs_human` drops to copilot; a transition to `booked` ALWAYS requires human confirmation.
  - **Off**: full manual takeover.
- **Follow-ups**: lead quiet in qualifying/qualified → context-aware short follow-up at +4h, longer value-carrying one at +23h (never "just checking in"), max 2 then auto-move to `dead` (recoverable). Env flag to shrink timers for testing.
- **Simulator channel** (must work before any Instagram setup): spawn AI-roleplayed test leads (varied personas: warm keyword lead, price hunter, broke student, under-18 trap, tire-kicker) that reply realistically to sends — the entire funnel must be exercisable locally. This doubles as the QA harness.
- **Instagram channel** via official Meta Graph API only: webhook verification (GET) + message ingestion (POST) per Meta's payload format, outbound via Send API when a page token is configured; graceful no-op without it. Clean `channel: 'sim' | 'instagram'` abstraction. No unofficial Instagram automation of any kind.
- **Stats**: leads today, qualification rate, booked this week, pending drafts, false-positive counter (booked leads later found unqualified).
- **Settings page**: offer/context text (editable), mode defaults, follow-up timings, call slots, guide + community links, kill switch. PIN-gated admin.

## Acceptance criteria — the 10/10 gate (verify by RUNNING, each one)

1. Lints/type-checks clean; server boots; every API route responds correctly incl. auth gating.
2. Full simulator loop passes: create test lead → AI drafts in copilot → approve → sim lead replies → qualification progresses → booking requires human confirm → stage lands correctly. Run end-to-end at least 3 times with different personas.
3. The under-18 sim persona is NEVER booked by the AI; the broke persona gets routed to community, not booked. (Automated red-line tests — scripted assertions, not manual checks.)
4. Grep-level check: no price/number can appear in AI output — hard post-filter strips/blocks any message containing £/$ + digits before send, logging it as needs_human.
5. Autopilot guardrails demonstrably enforced (a test trips each one).
6. Follow-up scheduler fires at fast-test timings; drafts queue in copilot, auto-send in autopilot.
7. Webhook: GET verification echoes challenge; POST with a sample Meta payload creates/updates a conversation; outbound send no-ops cleanly without a token.
8. UI: zero console errors; every button wired; funnel board reflects state changes within one poll cycle.
9. Ghost-voice audit: 10 sample AI replies across scenarios; zero third-person slips, zero prices, zero paragraphs, all sound like a real person texting.
10. README with: run instructions, env vars, Meta app setup steps (webhook URL, verify token, permissions: instagram_manage_messages, pages_manage_metadata), deploy notes.

## Review protocol per phase

Builder reports → reviewer independently re-runs verification → defects listed with file:line → builder fixes → re-verify. The loop ends only when all 10 criteria pass in the same session, then a final report: what was built, test results, exact deploy steps.

# Contract requests from the frontend

One line each: endpoint, shape, why. Claude checks this daily.

- /api/me: account.access_status (pending|active|paused), user.is_platform_admin (boolean); replaces plan/trial fields for externally handled payments.
- GET /api/admin/accounts and PATCH /api/admin/accounts/:id/access: JD-only list/activation/pause with audit; customer owners cannot invoke these endpoints.
- GET /api/admin/accounts/:id/usage: internal cost visibility; no billing UI.
- POST /api/onboarding/test-drive -> 202 {job_id}; GET /api/onboarding/test-drive/:id -> bounded, account-scoped job progress/results.

Approved for day two: all /api/admin/* endpoints authorize only JD’s platform-operator account using its authenticated, stable user ID. Customer owner/setter roles never grant this privilege. Enforce it server-side on every admin endpoint, including usage reads; deny by default. The frontend is_platform_admin flag is for display only.

Day-two integration tested against beta/backend 5c5d29d:
- Frontend now uses /api/me + session cookies for every API/upload/download. Legacy PIN UI removed. Remove backend PIN fallback when integrated; normal anonymous /api/me checks must not count as failed PIN attempts (current fallback can lock out page reloads).
- /api/me.user.is_platform_admin is now supplied. Admin UI is a later milestone; no admin controls are exposed in day-two login. Actual admin list returns an array, access PATCH takes {status}, and usage returns cost_usd. Update shared contracts to these actual shapes or reconcile before that milestone.
- Magic-link endpoint reports success even when email delivery fails and logs token URLs. Production should fail safely without logging credentials; local-only test delivery must be explicit.
- Expired magic links currently render a standalone backend error page without a request-new-link action; add a home link or redirect to /?auth_error=expired.

Day-three to five frontend integration:
- GET /api/templates, POST /api/settings/apply-template, GET /api/script/assembled, GET /api/script/checks and GET /api/onboarding are wired to the shapes in WORK_SPLIT.txt. They are absent in beta/backend 5c5d29d; UI reports unavailable, with no shipped mocks.
- Apply-template must preserve nonempty sections atomically when only_empty:true. Checks refer to saved settings and use persisted prompt_* section keys. The five onboarding fields are prompt_offer, prompt_voice, prompt_qualification, prompt_booking, prompt_hard_rules.
- Onboarding completion comes from server steps; opening a step never marks it complete. OAuth, goal/link editor, test drive and go-live remain days six/seven.
- New-account settings currently fall back to JD coaching offer, qualification, booking and hard rules. New businesses need empty or generic defaults; do not copy JD content into other accounts or count inherited defaults as completed setup.
- Development fixture tests verified picker, preservation, section saving, checks, assembled display and reload progress; real backend verified unavailable state. These are frontend checks, not validation of template/check/onboarding backend implementation.

Days six to twelve handoff, integrated against beta/backend c075e28:
- Instagram UI consumes /api/me.instagram (including oauth_available), redirects to /auth/instagram/start, refreshes connection and POSTs disconnect. It no longer exposes server env/token instructions. OAuth callback errors return to Setup. Real Meta consent/token exchange still needs JD's test account.
- Next step writes next_step_type (call|checkout|form|human), calendar_link for calls or next_step_link for checkout/forms. Five core fields now match the backend: prompt_persona, prompt_offer, prompt_qualification, prompt_booking, prompt_hard_rules. Other check messages are also surfaced.
- Test drive supports both agreed job_id/complete/failed format and actual id/done/error shape. It counts done/error runs, displays verdict/notes, recognizes setter AI messages, polls boundedly, preserves job ID per account in sessionStorage, and allows resuming. Real AI execution remains untested with providers disabled.
- Current test-drive route requires active access, contrary to the agreed pending-account setup allowance; decide whether to allow bounded pending simulations or change onboarding order. Paused accounts remain blocked.
- RELEASE BLOCKER: go-live currently checks access and script errors but does not enforce connected Instagram or a passed current-script test drive. Enforce all prerequisites server-side; disabling a frontend button is not authorization.
- RELEASE BLOCKER: test_drive_passed_at is not invalidated by script/template/goal changes or a later failed run. Bind validation to the tested script version and clear/revalidate on changes. Do not allow ordinary settings writes to forge server-managed completion flags.
- JD-only Accounts uses actual GET array, PATCH {status}, and cost_usd usage shape. Team invites are setter-only in UI; owner can remove other members; owners/setters are displayed. No role-change endpoint exists, so no pretend role editor.
- Unread indicators, view count, waiting-longest sort and POST /api/conversations/:id/seen are wired to the agreed fields but absent in c075e28. Specify per-user read state and make seen accept the last displayed message ID or timestamp to avoid marking newly arriving unread messages seen. Current frontend posts only after a visible selected thread loads.
- Upstream npm test failed before assertions: magic-link regex token=[^\s]+ captures non-token suffix. In scratch test only, token=[A-Za-z0-9_-]+ fixes it; all 21 checks then pass. Please commit the parser fix in the backend-owned test file. Independent eight-check integration suite also passed c075e28.
- Release verification still needs real OAuth/AI/provider testing, queued-send pause and duplicate-webhook checks, migration/rollback rehearsal, and JD/outside-user onboarding. PIN fallback still exists and is explicitly accepted by the backend test; remove it before the beta release gate.

Release-hardening follow-up (backend still c075e28):
- Frontend now uses GET /api/onboarding/test-drive history for recovery and requires the latest run to report passed:true with five nonfailed runs before presenting go-live as available. Server enforcement and binding results to the current script remain mandatory; these client checks do not close the release blockers above.
- Pending accounts now see that activation is required for test drives, matching current requireActive behavior. The previously agreed bounded pending simulation flow is still a backend decision.
- Observed real /api/onboarding steps.live=true with instagram=false and test_drive=false after saving a next-step link on the seeded active account. UI now distinguishes enabled automation from completed setup; correct readiness derivation and all activation paths server-side.
- The roadmap contains feature work through day 10 and verification through day 14. Subsequent seven-day requests are being used for stabilization, not unapproved feature expansion; a release still requires the outstanding real-provider and operator/user checks.

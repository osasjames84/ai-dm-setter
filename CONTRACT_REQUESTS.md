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

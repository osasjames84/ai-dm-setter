# Contract requests from the frontend

One line each: endpoint, shape, why. Claude checks this daily.

- /api/me: account.access_status (pending|active|paused), user.is_platform_admin (boolean); replaces plan/trial fields for externally handled payments.
- GET /api/admin/accounts and PATCH /api/admin/accounts/:id/access: JD-only list/activation/pause with audit; customer owners cannot invoke these endpoints.
- GET /api/admin/accounts/:id/usage: internal cost visibility; no billing UI.
- POST /api/onboarding/test-drive -> 202 {job_id}; GET /api/onboarding/test-drive/:id -> bounded, account-scoped job progress/results.

Approved for day two: all /api/admin/* endpoints authorize only JD’s platform-operator account using its authenticated, stable user ID. Customer owner/setter roles never grant this privilege. Enforce it server-side on every admin endpoint, including usage reads; deny by default. The frontend is_platform_admin flag is for display only.

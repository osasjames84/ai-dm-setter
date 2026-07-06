# Connecting your Instagram

This app talks to Instagram through the **official Meta Graph API** only — no
unofficial automation. It stays dormant (simulator-only) until three environment
variables are set, then it goes live. Nothing here needs code changes; it's all
configuration on Meta's side plus three env vars on your server.

The Settings page in the app (gear icon, PIN-gated) shows your live status, the
exact **webhook callback URL**, the verify token state, the subscribe field, and
the required permissions. Keep it open while you do this — the "Test connection"
button confirms each step.

---

## What you need first

1. An **Instagram professional account** (Business or Creator — switch in the IG
   app under Settings → Account type).
2. A **Meta developer account** at https://developers.facebook.com.
3. Your app **deployed to a public HTTPS URL** (Meta will not call `localhost`).
   The webhook URL shown in Settings will use whatever domain the app is served
   from, e.g. `https://your-app.onrender.com/webhook/instagram`.

---

## Step 1 — Create the Meta app

1. https://developers.facebook.com/apps → **Create app**.
2. Choose the use case that exposes **Instagram** messaging (the "Instagram" /
   business messaging product). Add the **Instagram** product to the app.
3. In the Instagram product's **API setup with Instagram login**, connect your
   Instagram professional account.

## Step 2 — Collect the three values

- **`IG_BUSINESS_ID`** — your Instagram professional account's ID (shown in the
  Instagram API setup panel; it's a long number like `17841400000000000`).
- **`IG_PAGE_TOKEN`** — a **long-lived access token** for that account,
  generated in the Instagram API setup panel. Use a long-lived one so it doesn't
  expire in an hour.
- **`IG_VERIFY_TOKEN`** — a secret **you invent** (any random string, e.g. a
  password-generator value). You'll paste the *same* string into the webhook
  config in Step 4.

## Step 3 — Set the env vars on your server

On your host (Render, Railway, a VM — wherever `server.js` runs), set:

```
IG_BUSINESS_ID=17841400000000000
IG_PAGE_TOKEN=<your long-lived token>
IG_VERIFY_TOKEN=<the secret you invented>
```

Restart the server. Open **Settings → Test connection**. If the token and ID are
right, it flips to **Connected as @yourhandle**. (Verify token can show "Set"
even before the webhook is wired — that only needs Step 4.)

## Step 4 — Point Meta's webhook at the app

In the Meta app → the Instagram product → **Webhooks / Configure**:

- **Callback URL**: the exact URL from the app's Settings page
  (`https://your-domain/webhook/instagram`).
- **Verify token**: the same `IG_VERIFY_TOKEN` value from Step 2.
- Click verify — Meta sends a `GET` challenge; the app echoes it and the webhook
  turns green. (This is why the verify token must be set *before* you click.)
- **Subscribe** to the **`messages`** field.

**Permissions** the app requests (approve them / add to the app):
`instagram_business_manage_messages`, `pages_manage_metadata`.

## Step 5 — Go live

- New DMs now appear in **Messages** as `instagram` conversations in real time.
- Each conversation has a per-thread mode: **Copilot** (AI drafts, you approve),
  **Autopilot** (auto-sends after a short human-like delay), or **Off**.
- The global **kill switch** (Settings) halts all AI drafting instantly.
- Booking a call and marking a Sale always require your manual confirmation — the
  AI can suggest them but never finalizes them.

---

## How it behaves

- **Inbound**: `POST /webhook/instagram` → the app parses Meta's payload, creates
  or updates the Instagram conversation, and runs the engine per the thread mode.
- **Outbound**: replies go out via the Graph API Send API using `IG_PAGE_TOKEN`.
  Every message is run through the outbound filter first (blocks currency+digits
  by default) — a blocked message is held for human review, never sent.
- **Verification**: `GET /webhook/instagram` echoes Meta's `hub.challenge` only
  when `hub.verify_token` matches `IG_VERIFY_TOKEN`; otherwise `403`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Settings shows "Not connected" | All three env vars set? Server restarted? |
| "Credentials set but token check failed" | `IG_PAGE_TOKEN` expired or wrong; regenerate a long-lived token. Confirm `IG_BUSINESS_ID` is the IG account id. |
| Webhook won't verify in Meta | `IG_VERIFY_TOKEN` must be identical on both sides; the app must be on public HTTPS. |
| DMs don't arrive | Subscribe to the **`messages`** field; confirm the callback URL has no typo. |
| Tokens are safe | They live only in server env vars — never entered in the browser, never sent to the client. Settings shows *status*, not values. |

## Tokens & privacy

Meta access tokens are **secrets**. Set them only as server environment
variables. This app never puts them in the browser, in URLs, or in the database,
and the Settings API reports only whether each is set — never the value.

# Connecting Instagram

dmSetter talks to Instagram only through Meta's official **Instagram API with Instagram Login** (graph.instagram.com). There is no unofficial automation, no Facebook Page and no Messenger Platform involved.

Permissions requested: `instagram_business_basic` and `instagram_business_manage_messages`. Nothing else. (The Facebook Login permissions `instagram_manage_messages` and `pages_manage_metadata` belong to a different flow and are not used.)

The full Meta dashboard walkthrough (app creation, webhooks, Business Verification, App Review, screencasts, going Live) is in [docs/META_REVIEW.md](docs/META_REVIEW.md). This page is the short version for day to day use.

## For a business connecting its account

1. The Instagram account must be a **professional** account (Business or Creator).
2. In the Instagram app: Settings, Messages and story replies, Message controls, Connected tools, turn on **Allow access to messages**.
3. In dmSetter: Settings (or onboarding), **Connect Instagram**, sign in to Instagram, **Allow**.
4. dmSetter stores the 60 day token encrypted, refreshes it automatically, and subscribes the account to the `messages` webhook.
5. While the Meta app is in Development mode, only accounts added as **Instagram Testers** can connect.

## For the operator (server side)

Required env on the server (Railway): `IG_APP_ID`, `IG_APP_SECRET` (Instagram app ID and secret from *API setup with Instagram login*), `IG_VERIFY_TOKEN` (any random string, also pasted into the webhook form), `TOKEN_ENC_KEY`, `PUBLIC_BASE_URL`. Recommended: `META_APP_SECRET` (App settings, Basic, App secret) so webhook signatures verify whichever secret Meta signs with.

Meta dashboard values:

| Setting | Value |
|---|---|
| OAuth redirect URI | `https://<domain>/auth/instagram/callback` |
| Webhook callback URL | `https://<domain>/webhook/instagram` |
| Webhook verify token | value of `IG_VERIFY_TOKEN` |
| Webhook field | `messages` |
| Deauthorize callback | `https://<domain>/webhook/meta/deauthorize` |
| Data deletion request URL | `https://<domain>/webhook/meta/data-deletion` |
| Privacy / Terms | `https://<domain>/privacy`, `https://<domain>/terms` |

Settings, Instagram card in the app shows the live connection status and the exact webhook URL for your domain.

### Legacy env token (first workspace only)

Before Instagram Login existed, the first workspace ran on `IG_PAGE_TOKEN` + `IG_BUSINESS_ID` (a long-lived Instagram token generated in the dashboard). That still works as a fallback for the first workspace, but connecting through Instagram Login replaces it, and new setups should not use it.

## How sending behaves

- **Inbound**: `POST /webhook/instagram` verifies Meta's signature, ignores repeats of the same message id, read receipts and reactions, stores the message, and runs the AI per the conversation mode (Off, Copilot, Autopilot).
- **Outbound**: every send goes through one gate (`lib/instagram.js`) that enforces Instagram's 24 hour window (only reply to people who messaged first, within 24 hours of their last message), pauses while the account needs reconnecting, spaces sends out and caps them per hour. A message that cannot go out is kept as a draft and the conversation is flagged with the reason, for example `outside 24h window`. Reply to those from the Instagram app.
- **Kill switch** (Settings) stops all AI drafting and sending at once. Booking a call and marking a sale always need the owner's confirmation.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Connect Instagram says "not configured" | `IG_APP_ID` and `IG_APP_SECRET` are missing on the server. |
| Instagram login says the redirect URI is invalid | The OAuth redirect URI in the dashboard must be exactly `https://<domain>/auth/instagram/callback`. |
| Webhook will not verify | `IG_VERIFY_TOKEN` must be identical on both sides and deployed before you click Verify; the server must be on public HTTPS. |
| Webhooks return 403 in the logs | Signature mismatch: set `META_APP_SECRET` (App settings, Basic) as well as `IG_APP_SECRET`. |
| DMs do not arrive | Subscribe the `messages` field; in Development mode the sender and the business must both be testers; check "Allow access to messages" in the Instagram app. |
| Banner "Instagram needs reconnecting" | The token was revoked or expired. Settings, Connect Instagram again. Sends stay paused until then. |
| Conversation flagged "outside 24h window" | The lead has not written in 24 hours. Reply from the Instagram app; the next message from the lead reopens the window. |

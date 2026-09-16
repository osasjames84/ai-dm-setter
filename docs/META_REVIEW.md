# Meta app review checklist (epic G)

Goal: other people's Instagram accounts can connect. Until this passes, only accounts added as testers on the Meta app can log in.

## Before submitting
1. Business verification (G.1): Meta Business Manager → Security Centre → Verify. Needs the company's legal name, address and a document (utility bill or incorporation certificate). Start it first; it takes days to weeks.
2. App settings → Basic: privacy policy URL `https://<domain>/privacy`, terms URL `https://<domain>/terms`, data deletion callback URL `https://<domain>/webhook/meta/data-deletion`, app icon, category "Business and pages".
3. Instagram product → Business login settings: redirect URI `https://<domain>/auth/instagram/callback`, and the webhook `https://<domain>/webhook/instagram` with the verify token from `IG_VERIFY_TOKEN`, field `messages`.
4. Server env on Railway: `IG_APP_ID`, `IG_APP_SECRET`, `IG_VERIFY_TOKEN`, `OWNER_EMAIL`.
5. Add each beta user's Instagram as a tester (App roles → Instagram testers) and accept the invite from their Instagram app, so they can connect while the app is still in development mode.

## The submission
- Permissions requested: `instagram_business_basic`, `instagram_business_manage_messages`.
- Use case text: "A business owner connects their own Instagram professional account and the app replies to incoming direct messages on their behalf, using rules the owner writes, with a human review queue. No data is shared with third parties."
- Screencast (G.3), one take, under 3 minutes, on the finished onboarding: log in → Connect Instagram → consent screen → connected state → a real DM from a second phone → the reply appearing in the inbox → an AI draft approved by the owner → the reply arriving on the phone → Disconnect.
- Expect one round of feedback. The common asks: a clearer screencast, the privacy policy naming the data kept (conversations, Instagram user ids, profile names) and the retention period.

## After approval
- Switch the app to Live (App settings → Basic → App mode).
- Remove the tester list dependency from your notes; anyone can connect.
- Rotate `IG_APP_SECRET` if it was ever pasted anywhere other than Railway.

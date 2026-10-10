# Meta setup, Business Verification and App Review

This is the owner's checklist for getting dmSetter approved on Meta's Instagram Platform so that any business (not only testers) can connect its Instagram account.

dmSetter uses the **Instagram API with Instagram Login** (graph.instagram.com). It asks for exactly two permissions:

| Permission | What dmSetter uses it for |
|---|---|
| `instagram_business_basic` | Read the connected professional account's id and username, so the inbox shows which account is connected and webhooks are routed to the right workspace. |
| `instagram_business_manage_messages` | Receive the direct messages people send to the business (webhook field `messages`) and send the business's replies. |

It does **not** use Facebook Login, Facebook Pages or the Messenger Platform, so the old Facebook Login permissions (`instagram_manage_messages`, `pages_manage_metadata`, `pages_show_list`, `pages_messaging`) are not requested and must not be added. It also does **not** use the Human Agent feature or any message tag: every send happens inside Instagram's 24 hour standard messaging window, and only to people who messaged the business first. The code enforces this in one place (`outboundGate` in `lib/instagram.js`), so mention it confidently in the review.

Order of work:

1. Build and test everything in Development mode with tester accounts (sections 1 to 6). You can do this now.
2. Register the Ltd company, then complete Business Verification (section 7).
3. Submit App Review (section 8).
4. Switch the app to Live (section 9).

Replace `<domain>` everywhere below with the public HTTPS domain of the Railway service, for example `app.yourcompany.co.uk`. Meta will not call `localhost`.

---

## 1. Create the Meta app

1. Go to https://developers.facebook.com/apps and sign in with the Facebook account that will own the app. Use your own account, not a shared one; you can add other admins later.
2. Click **Create app**.
3. **App details**: app name `dmSetter` (or the product name you will trade under), app contact email: the company email you will put in `COMPANY_EMAIL`.
4. **Use cases**: choose **Manage messaging and content on Instagram** (the Instagram use case). Do not pick a Facebook Login or Messenger use case.
5. **Business**: connect the app to your business portfolio (Meta Business Suite). If the Ltd company is not registered yet, pick or create a portfolio now and rename it to the exact legal name once the company exists. The app has to sit in the portfolio you later verify.
6. Finish the wizard. The app type is Business and it starts in **Development** mode.

## 2. Add Instagram and the two permissions

1. In the app dashboard open **Use cases**, then **Customize** next to *Manage messaging and content on Instagram*.
2. Open **API setup with Instagram login**.
3. Under **Add required messaging permissions**, make sure exactly these are added: `instagram_business_basic`, `instagram_business_manage_messages`. Remove anything else (for example `instagram_business_content_publish` or `instagram_business_manage_comments`): every extra permission needs its own review and its own screencast.
4. Copy the **Instagram app ID** and **Instagram app secret** shown on this page. These are the values for `IG_APP_ID` and `IG_APP_SECRET` (they are different from the Facebook App ID at the top of the dashboard).

## 3. Business login settings (redirect URI)

On the same page open **Set up Instagram business login**, then **Business login settings**:

| Field | Value |
|---|---|
| OAuth redirect URIs | `https://<domain>/auth/instagram/callback` |
| Deauthorize callback URL | `https://<domain>/webhook/meta/deauthorize` |
| Data deletion request URL | `https://<domain>/webhook/meta/data-deletion` |

Save. The redirect URI must match exactly, including `https` and no trailing slash. dmSetter builds the login link itself (`/auth/instagram/start`), so you do not need the embed URL Meta shows.

## 4. Webhooks

1. On **API setup with Instagram login**, open **Configure webhooks**.
2. **Callback URL**: `https://<domain>/webhook/instagram`
3. **Verify token**: the exact value of `IG_VERIFY_TOKEN` on Railway (make one with `openssl rand -hex 24`). Set it on Railway and redeploy **before** clicking Verify.
4. Click **Verify and save**. Meta sends a GET with a challenge; dmSetter echoes it only when the token matches.
5. In the webhook fields list, **subscribe to `messages`**. That single field carries incoming messages and the echoes of messages the business sends from the Instagram app. dmSetter needs nothing else; do not subscribe to `comments`, `mentions` or other fields. (dmSetter ignores read receipts, reactions and typing events even if they arrive.)
6. Webhook payloads are signed. dmSetter verifies `X-Hub-Signature-256` with `IG_APP_SECRET` and, if you set it, `META_APP_SECRET` (the **App secret** under App settings, Basic). Set both to be safe; a 403 in the logs for `/webhook/instagram` means neither matched.

Note: in Development mode, Meta only delivers message webhooks for accounts that have a role on the app (testers). That is expected until the app is Live with Advanced Access.

When a business connects through Instagram Login, dmSetter also subscribes that account to the `messages` field automatically (`POST /<ig-user-id>/subscribed_apps`).

## 5. Railway environment variables

Set these on the Railway service (Variables tab), then redeploy. Full list with optional ones is in the README.

| Variable | Value |
|---|---|
| `IG_APP_ID` | Instagram app ID from section 2 |
| `IG_APP_SECRET` | Instagram app secret from section 2 |
| `META_APP_SECRET` | App settings, Basic, App secret (optional but recommended, see section 4) |
| `IG_VERIFY_TOKEN` | the random string you also pasted into the webhook form |
| `PUBLIC_BASE_URL` | `https://<domain>` (Railway sets `RAILWAY_PUBLIC_DOMAIN` automatically; set this when you use a custom domain) |
| `TOKEN_ENC_KEY` | 64 hex characters, `openssl rand -hex 32`. Encrypts Instagram tokens at rest. Keep it forever: changing it means every account must reconnect. |
| `DATA_DIR` | the Railway volume mount path, for example `/data` |
| `OWNER_EMAIL` | your login email (you become the platform admin) |
| `ANTHROPIC_API_KEY` | AI drafting |
| `RESEND_API_KEY`, `NOTIFY_FROM` | sign-in links and notifications |
| `COMPANY_NAME` | the registered company name, exactly as on Companies House |
| `COMPANY_EMAIL` | the privacy and support email shown on the legal pages |
| `COMPANY_ADDRESS` | the registered office address |
| `COMPANY_NUMBER` | the Companies House number |
| `COMPANY_ICO_NUMBER` | your ICO data protection fee registration number, once you have it |

Until `COMPANY_NAME`, `COMPANY_EMAIL` and `COMPANY_ADDRESS` are set, the legal pages show a red `[... not set]` placeholder. Do not submit for review while any placeholder shows. Open `https://<domain>/privacy` and check.

UK note: a company that processes personal data must normally pay the ICO data protection fee (https://ico.org.uk/for-organisations/data-protection-fee/). Do it right after incorporation and put the number in `COMPANY_ICO_NUMBER`.

## 6. App settings, Basic

Open **App settings**, **Basic** and fill in:

| Field | Value |
|---|---|
| Display name | dmSetter (or your trading name) |
| App domains | `<domain>` |
| Contact email | same as `COMPANY_EMAIL` |
| Privacy Policy URL | `https://<domain>/privacy` |
| Terms of Service URL | `https://<domain>/terms` |
| User data deletion | choose **Data deletion callback URL**: `https://<domain>/webhook/meta/data-deletion`. (If the form asks for instructions instead, use `https://<domain>/data-deletion`. Both work.) |
| App icon | 1024 x 1024 PNG, the dmSetter logo on a plain background, no Instagram or Meta logos in it |
| Category | **Business and pages** (if not offered, **Messaging**) |

Save changes. Meta checks that the privacy URL loads and is a real policy, so make sure it opens without logging in.

### Testers (Development mode)

1. **App roles**, **Roles**, **Add people**, choose the **Instagram Tester** role and enter the Instagram username. Add your own business account, your second test account, and each beta user.
2. Each tester accepts the invite in Instagram: on the web at https://www.instagram.com/accounts/manage_access/ under **Tester invites**, or in the app under Settings, Apps and websites.
3. Tester accounts that will be connected to dmSetter must be **professional** accounts (Business or Creator). In the Instagram app: Settings, Account type and tools, Switch to professional account.
4. On each connected account, allow API access to messages: Instagram app, Settings, Messages and story replies, Message controls, Connected tools, turn on **Allow access to messages**.
5. Test the full flow: log in to dmSetter, **Connect Instagram**, accept the consent screen, send a DM from a second account, see it in the inbox, approve a reply, see it arrive.

## 7. Business Verification (needs the registered Ltd)

Advanced Access to the two permissions is only granted to apps owned by a verified business. Start this as soon as the company is incorporated; it is usually the slowest step.

What you need:

- The **Certificate of Incorporation** from Companies House (PDF). It shows the exact legal name and the company number.
- A second document with the legal name and the registered address if Meta asks for one: a business bank statement or a utility bill in the company name. A bank statement from the new business account is the easiest.
- A **website** on your own domain that shows the company name. The dmSetter privacy and terms pages (with `COMPANY_NAME` set) count; a simple landing page on the same domain is better.
- An **email address on that domain** (for example `privacy@yourcompany.co.uk`) or a business phone number Meta can call or text. Domain email is the fastest verification method.

Steps:

1. Rename the business portfolio to the exact legal name, for example `Lean Is Law Ltd`. Spelling, punctuation and the `Ltd` suffix must match the certificate.
2. Meta Business Suite, **Settings** (business settings), **Business info**: fill in legal name, registered address, phone, website.
3. **Security Centre** (or the **Business verification** prompt in the app dashboard under App settings, Basic): **Start verification**.
4. Choose United Kingdom, enter the company number if asked, upload the certificate, then confirm by domain email or phone.
5. Wait for the result (often a few working days, sometimes longer). Meta may ask for another document; reply quickly.
6. Back in the app dashboard, check that the app is connected to this verified portfolio (App settings, Basic, **Verification** or business portfolio section).

If the dashboard also shows an **Access verification** step (Meta asks apps that serve other businesses to confirm they are a tech provider), complete it. Describe dmSetter as: "a software service that lets small businesses manage the direct messages sent to their own Instagram professional accounts; each business connects its own account through Instagram Login".

## 8. App Review submission

Open **App Review**, **Permissions and features**. For each of the two permissions click **Request advanced access**, then fill the forms. Everything below is ready to paste. Edit the bits in brackets.

### 8.1 App settings and verification details

- **Platform**: Website. Site URL `https://<domain>`.
- **Test credentials**: create a reviewer login. Add the reviewer email to `OPEN_LOGIN_EMAILS` (or invite it to a demo workspace) so they can sign in without an email link, and connect a test Instagram professional account to that workspace before submitting. Write in the notes:

> Sign in at https://<domain> with [reviewer email] (no password needed: enter the email and press Continue). The workspace is already connected to the Instagram professional account @[test business account]. To send a test DM, message @[test business account] from any Instagram account. The account @[second test account] is available for this: [login details if you share one]. Replies only go to people who messaged the business first and only within 24 hours of their last message.

### 8.2 instagram_business_basic

**How will your app use this permission?**

> dmSetter is a web app that helps a small business manage the direct messages sent to its own Instagram professional account. When the business owner clicks Connect Instagram, they sign in with Instagram Login and we use instagram_business_basic to read the connected account's Instagram user id and username. We use the id to link incoming message webhooks to the right business workspace, and we show the username in the app ("Connected as @username") so the owner can see which account is connected. We do not read or store any other profile data, media or followers, and we never use this data for advertising or share it with other businesses.

**How does this permission add value for the user?** (if asked)

> It lets the owner connect their own account in one click and always see which Instagram account the inbox belongs to.

### 8.3 instagram_business_manage_messages

**How will your app use this permission?**

> dmSetter shows the direct messages that people send to the business's own Instagram professional account in a shared inbox, and lets the business reply. For each incoming message (webhook field "messages") the app can prepare a suggested reply with AI, which the business owner reviews and approves, or which is sent automatically if the owner has turned that on for the conversation. All replies are sent with the Instagram Send API on behalf of the business.
>
> We only reply to people who messaged the business first, and only inside Instagram's 24 hour standard messaging window: our server refuses any send when the person's last message is older than 24 hours, and holds it for the owner to handle in the Instagram app instead. We do not use message tags or the Human Agent feature, we never start conversations, and we limit how many messages an account and each conversation can send per hour. Message content is stored only to show the conversation history to the business, is never sold or used for advertising, and is deleted on request (data deletion callback and https://<domain>/data-deletion).

**How does this permission add value for the user?** (if asked)

> Small businesses get many DMs from people asking about their services. dmSetter makes sure each person gets a timely, relevant answer in the business's own voice, while the owner keeps control: every AI draft can be reviewed, edited or discarded before it is sent.

### 8.4 Screencasts

Record one video per permission, each under 3 minutes, 1080p, browser full screen, English UI. Use a voiceover or on-screen captions. Before recording: sign out of dmSetter, use a clean browser profile, have the business account and a second phone or browser with the test sender account ready, and set the conversation mode to **Copilot** (AI drafts, you approve).

**Video 1: instagram_business_basic** (about 1 minute 30)

| Time | What to show (click) | What to say or caption |
|---|---|---|
| 0:00 | `https://<domain>` login page. Type the email, press Continue. | "This is dmSetter. A business owner signs in to their workspace." |
| 0:15 | Settings (or the onboarding step), **Instagram** card shows Not connected. Click **Connect Instagram**. | "To connect their own Instagram professional account they click Connect Instagram." |
| 0:25 | Instagram Login page: sign in as the business account. The consent screen lists the permissions. Pause 2 seconds on it, then **Allow**. | "Instagram Login asks the owner to allow access. We request instagram_business_basic and instagram_business_manage_messages." |
| 0:50 | Back in dmSetter: **Connected as @[business]**. Point the cursor at the username. | "We use instagram_business_basic to read the account id and username. The username is shown here so the owner knows which account is connected, and the id routes incoming messages to this workspace." |
| 1:10 | Click **Disconnect**, confirm, card shows Not connected. | "The owner can disconnect at any time, which deletes the stored token." |
| 1:25 | End. | |

**Video 2: instagram_business_manage_messages** (about 2 minutes 40)

| Time | What to show (click) | What to say or caption |
|---|---|---|
| 0:00 | Signed in, Instagram connected (reconnect if you used Video 1's disconnect). Open **Messages** (inbox). | "Instagram is connected. This is the dmSetter inbox." |
| 0:10 | Second screen: from the test sender account in the Instagram app, send the business a DM: "Hi, how does your coaching work?" | "A customer sends the business a direct message on Instagram." |
| 0:25 | The new conversation appears in the inbox. Open it. | "The message arrives through the messages webhook, which needs instagram_business_manage_messages." |
| 0:40 | The AI draft appears under the conversation. Edit one word in it. | "dmSetter prepares a suggested reply. The owner reviews and can edit it." |
| 1:00 | Click **Approve and send**. | "When the owner approves, we send the reply with the Instagram Send API." |
| 1:10 | Second screen: the reply arrives in the test sender's Instagram. | "The customer receives the reply in Instagram." |
| 1:25 | Back in dmSetter, type a manual reply in the composer and send it. Show it arriving. | "The owner can also type replies directly." |
| 1:45 | Open an older test conversation whose last customer message is more than 24 hours old. Try to send. Show the message "Not sent: outside Instagram's 24 hour window" and the flag on the conversation. | "We only reply within Instagram's 24 hour window after the customer's last message. Outside it, nothing is sent and the conversation is flagged for the owner." |
| 2:10 | Show the conversation mode switch (Off, Copilot, Autopilot) and the kill switch in Settings. | "The owner decides per conversation whether replies need approval, and can stop all automated replies instantly." |
| 2:25 | Open `https://<domain>/privacy` briefly, then `/data-deletion`. | "Our privacy policy explains what we store and how people can have their data deleted." |
| 2:40 | End. | |

Prepare the "older than 24 hours" conversation a day ahead: message the business from a test account, then wait 24 hours before recording.

### 8.5 Data handling questions

Meta asks a short questionnaire with the submission (and yearly in the Data Use Checkup). Answers:

- **Responsible entity / data controller**: [COMPANY_NAME], [COMPANY_ADDRESS], United Kingdom.
- **Do you share Platform Data with data processors or service providers?** Yes:
  - Anthropic PBC (United States): generates reply drafts from conversation text.
  - Railway Corporation (United States): application hosting and database.
  - Resend (United States): sends sign-in and notification emails to the business (contains a handle and a short reason, not conversation history).
  - Groq, Inc. or OpenAI (United States), optional: transcribes voice notes, only when the business adds a key.
  - Calendly LLC (United States), optional: call booking, only when the business connects it.
  - Sentry and an S3 compatible backup store, only if you have turned them on (`SENTRY_DSN`, `BACKUP_S3_*`). If you list the backup store, set a 30 day lifecycle rule on the bucket (the privacy policy promises at most 30 days).
- **Countries where data is processed**: United Kingdom, United States.
- **Requests from public authorities**: answer truthfully (normally "no"), and confirm you have a policy to review such requests (the privacy policy contact).
- **Data deletion**: callback URL `https://<domain>/webhook/meta/data-deletion`, instructions `https://<domain>/data-deletion`.

### 8.6 Submit

Tick the confirmation boxes, submit. Typical feedback and fixes:

- "Screencast does not show the permission in use": re-record and make the consent screen and the place the data appears clearly visible.
- "Privacy policy does not describe data deletion / retention": check that no placeholder is showing on `/privacy`.
- "Unable to test": make sure the reviewer login works in a private window and the demo workspace is still connected (tokens last 60 days and refresh automatically while the app runs).

## 9. Going Live

1. After both permissions show **Advanced access** and Business Verification is complete, switch the toggle at the top of the dashboard from **Development** to **Live**.
2. Connect a non-tester Instagram professional account to a fresh workspace and send a DM to confirm webhooks arrive.
3. Remove tester-only notes from your onboarding material; any professional account can now connect.
4. If `IG_APP_SECRET` or `META_APP_SECRET` was ever pasted anywhere except Railway, reset it in the dashboard and update Railway.
5. Remove the reviewer address from `OPEN_LOGIN_EMAILS` after approval.

## What the app enforces (for your answers and for support)

- **24 hour window** on every outbound path (manual inbox sends, draft approval, send all, autopilot replies, follow-ups, booking reminders, the Call Booked message, voice notes, keyword openers, typing indicators). Outside it nothing is sent; the conversation is flagged `outside 24h window` and the message is kept as a draft so the owner can reply from the Instagram app. A person who never messaged the business can never be messaged.
- **No message tags**: the app never sends `tag` or `HUMAN_AGENT`.
- **Rate limits**: at least 2 seconds between sends per account, at most 100 sends per hour per account by default (env `IG_RATE_*`, or per account settings `rate_min_interval_sec`, `rate_max_per_hour`, which can only be set within safe bounds). A Meta rate-limit error makes the account back off (1 minute, doubling up to 1 hour).
- **No burst after downtime**: follow-ups, reminders and owed replies that became due more than 30 minutes ago (`stale_send_minutes`, env `IG_STALE_SEND_MINUTES`) are parked for review instead of sent.
- **Idempotency**: each send is recorded before the Graph call, so a retry, double click or restart never sends a message twice. A send cut off by a restart is flagged "send outcome unknown" and never retried automatically. Duplicate webhooks (same message id) are ignored.
- **Errors**: token or permission errors flip the account to "needs reconnect" and pause all sends until it is healthy; a lead who blocked the business is flagged; Meta's policy restriction (code 368) pauses sending for 6 hours and emails the owner.

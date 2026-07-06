/**
 * Instagram channel adapter — DORMANT until IG_PAGE_TOKEN, IG_VERIFY_TOKEN and
 * IG_BUSINESS_ID are set in the environment (same pattern as the Stripe
 * scaffold: ships safely, lights up when credentials appear).
 *
 * Wiring on the Meta side (one-time, done by the owner):
 *  1. developers.facebook.com → create app → add "Messenger" product with
 *     Instagram messaging, connect the IG professional account.
 *  2. Webhook: point it at  GET/POST {your-domain}/webhook/instagram  with the
 *     same verify token as IG_VERIFY_TOKEN. Subscribe to `messages`.
 *  3. Generate a long-lived page access token → IG_PAGE_TOKEN.
 */

const GRAPH = 'https://graph.instagram.com/v21.0';

export function igConfigured() {
  return !!(process.env.IG_PAGE_TOKEN && process.env.IG_VERIFY_TOKEN && process.env.IG_BUSINESS_ID);
}

/** GET /webhook/instagram — Meta's subscription verification handshake. */
export function igVerifyWebhook(req, res) {
  if (
    req.query['hub.mode'] === 'subscribe' &&
    req.query['hub.verify_token'] === process.env.IG_VERIFY_TOKEN
  ) {
    return res.send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
}

/**
 * Normalize a webhook POST body into inbound events:
 * [{ senderId, text, timestamp }]. Ignores echoes/read receipts.
 */
export function igParseInbound(body) {
  const out = [];
  for (const entry of body?.entry || []) {
    for (const ev of entry.messaging || []) {
      if (!ev.message || ev.message.is_echo) continue;
      const text = ev.message.text || (ev.message.attachments?.length ? '[attachment]' : '');
      if (!text) continue;
      out.push({ senderId: String(ev.sender?.id || ''), text, timestamp: ev.timestamp });
    }
  }
  return out.filter((e) => e.senderId);
}

/** Send a text DM via the Graph API. */
export async function igSendText(recipientId, text) {
  const res = await fetch(`${GRAPH}/me/messages?access_token=${process.env.IG_PAGE_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: recipientId }, message: { text } }),
  });
  if (!res.ok) throw new Error(`IG send failed ${res.status}: ${await res.text()}`);
  return res.json();
}

/**
 * Connection status for the Settings page. Reports which credentials are set
 * (never their values) and, when fully configured, does a live Graph API call
 * to confirm the token works and fetch the connected account's @handle.
 */
export async function igStatus() {
  const out = {
    configured: igConfigured(),
    has_page_token: !!process.env.IG_PAGE_TOKEN,
    has_verify_token: !!process.env.IG_VERIFY_TOKEN,
    has_business_id: !!process.env.IG_BUSINESS_ID,
    account: null,
    error: null,
  };
  if (!out.configured) return out;
  try {
    const res = await fetch(`${GRAPH}/${process.env.IG_BUSINESS_ID}?fields=id,username,name&access_token=${process.env.IG_PAGE_TOKEN}`);
    if (res.ok) out.account = await res.json();
    else { out.error = `Graph API ${res.status}`; out.reachable = false; }
  } catch (e) { out.error = e.message; }
  return out;
}

/** Best-effort profile lookup for a new inbound sender. */
export async function igProfile(senderId) {
  try {
    const res = await fetch(`${GRAPH}/${senderId}?fields=username,name&access_token=${process.env.IG_PAGE_TOKEN}`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

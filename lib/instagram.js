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

// Graph base — overridable via IG_GRAPH_BASE for local end-to-end tests (prod never sets it).
const GRAPH = process.env.IG_GRAPH_BASE || 'https://graph.instagram.com/v21.0';

// ---- per-account credentials ----
// server.js registers a resolver that returns { token, businessId } for the
// CURRENT account (AsyncLocalStorage), or null when that account has no
// connected Instagram. The first account falls back to the env token while it
// still exists. Every Graph call below reads creds() so nothing here knows
// about accounts.
let credsResolver = () => (process.env.IG_PAGE_TOKEN && process.env.IG_BUSINESS_ID
  ? { token: process.env.IG_PAGE_TOKEN, businessId: String(process.env.IG_BUSINESS_ID) } : null);
export function setCredsResolver(fn) { credsResolver = fn; }
function creds() { try { return credsResolver() || null; } catch { return null; } }
const tokenOf = () => creds()?.token || '';

/** Does the current account have a usable Instagram connection? */
export function igConfigured() {
  return !!creds();
}

// ---- Instagram Login (OAuth) ----
// Uses "Instagram API with Instagram Login": the account owner authorises the
// Meta app once; we exchange the code for a 60-day token, store it encrypted,
// and refresh it before it expires. Needs IG_APP_ID + IG_APP_SECRET.
export const IG_SCOPES = ['instagram_business_basic', 'instagram_business_manage_messages'];
export function igOauthConfigured() { return !!(process.env.IG_APP_ID && process.env.IG_APP_SECRET); }

export function igAuthUrl(redirectUri, state) {
  const q = new URLSearchParams({
    client_id: process.env.IG_APP_ID, redirect_uri: redirectUri, scope: IG_SCOPES.join(','), response_type: 'code', state,
  });
  return `https://www.instagram.com/oauth/authorize?${q}`;
}

/** code → short-lived token → long-lived token + profile. Throws with a readable message. */
export async function igCompleteOauth(code, redirectUri) {
  const form = new URLSearchParams({ client_id: process.env.IG_APP_ID, client_secret: process.env.IG_APP_SECRET, grant_type: 'authorization_code', redirect_uri: redirectUri, code });
  const r1 = await fetch('https://api.instagram.com/oauth/access_token', { method: 'POST', body: form });
  const j1 = await r1.json().catch(() => ({}));
  if (!r1.ok || !j1.access_token) throw new Error(`code exchange failed: ${j1.error_message || j1.error?.message || r1.status}`);
  const q = new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: process.env.IG_APP_SECRET, access_token: j1.access_token });
  const r2 = await fetch(`https://graph.instagram.com/access_token?${q}`);
  const j2 = await r2.json().catch(() => ({}));
  if (!r2.ok || !j2.access_token) throw new Error(`long-lived exchange failed: ${j2.error?.message || r2.status}`);
  const me = await igMe(j2.access_token);
  return {
    token: j2.access_token,
    expiresAt: new Date(Date.now() + (Number(j2.expires_in) || 60 * 86400) * 1000).toISOString(),
    scopes: Array.isArray(j1.permissions) ? j1.permissions.join(',') : String(j1.permissions || ''),
    appScopedId: String(j1.user_id || me.id || ''),
    businessId: String(me.user_id || me.id || ''),
    username: me.username || null,
  };
}

/** Profile of the token's owner: { id (app-scoped), user_id (professional account id), username }. */
export async function igMe(token) {
  const r = await fetch(`${GRAPH}/me?fields=id,user_id,username,name&access_token=${encodeURIComponent(token)}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`profile failed: ${j.error?.message || r.status}`);
  return j;
}

/** Refresh a long-lived token (must be >24h old and not expired). Returns { token, expiresAt }. */
export async function igRefreshToken(token) {
  const q = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: token });
  const r = await fetch(`https://graph.instagram.com/refresh_access_token?${q}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`refresh failed: ${j.error?.message || r.status}`);
  return { token: j.access_token, expiresAt: new Date(Date.now() + (Number(j.expires_in) || 60 * 86400) * 1000).toISOString() };
}

/** Subscribe the app to this professional account's message webhooks. Best-effort; returns true on success. */
export async function igSubscribeApp(token, businessId) {
  try {
    const r = await fetch(`${GRAPH}/${businessId}/subscribed_apps?subscribed_fields=messages&access_token=${encodeURIComponent(token)}`, { method: 'POST' });
    return r.ok;
  } catch { return false; }
}

// ---- IG auth-error surfacing (FEATURE 2) ----
// A dead/revoked IG_PAGE_TOKEN otherwise fails silently. server.js registers a
// handler via onIgAuthError; we invoke it (fire-and-forget) with a detail string
// on any detected AUTH failure, and with null to CLEAR after a successful status
// fetch. Kept module-level so every Graph call funnels through the same signal.
let authErrorHandler = null;
export function onIgAuthError(fn) { authErrorHandler = fn; }

/** Fire the registered handler; wrapped so a handler bug never breaks a send. */
function emitAuthError(detail) {
  try { authErrorHandler && authErrorHandler(detail); } catch { /* handler is best-effort */ }
}

/** An HTTP 401/403 OR a Graph body with code 190 / OAuthException is an auth failure. */
function isAuthFailure(status, body) {
  if (status === 401 || status === 403) return true;
  const b = String(body || '');
  return b.includes('"code":190') || b.includes('OAuthException');
}

/**
 * Send-style Graph helper shared by igSendText/igSendAudio/igSendAction: reads the
 * body once, detects+emits auth failures, then throws the same error the callers
 * used to throw (so existing {ok:false}/catch handling upstream is unchanged).
 */
async function graphSend(res, label) {
  if (res.ok) return res.json();
  const body = await res.text();
  if (isAuthFailure(res.status, body)) emitAuthError(`${label} ${res.status}: ${body}`.slice(0, 300));
  throw new Error(`${label} ${res.status}: ${body}`);
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
 * Extract a normalized event from one messaging-style entry. Returns
 * { direction, leadId, text, mid, timestamp } or null (empty/non-text events).
 *   direction 'in'  = a message the LEAD sent us → attribute to the sender.
 *   direction 'out' = a message the ACCOUNT sent — either dmSetter itself OR the
 *                     owner typing in the Instagram app (an "echo"). We attribute
 *                     it to the RECIPIENT (the lead) so it shows in that thread.
 * An event is 'out' when Messenger marks it is_echo OR (Instagram) when the
 * sender IS the connected business account.
 */
function extractMessageEvent(ev, businessId) {
  if (!ev?.message) return null;
  const text = String(ev.message.text || '');
  const attachments = (ev.message.attachments || [])
    .map((a) => ({ type: String(a?.type || 'file'), url: a?.payload?.url || '' }))
    .filter((a) => a.url);
  if (!text && !attachments.length) return null;
  const senderId = String(ev.sender?.id || '');
  const recipientId = String(ev.recipient?.id || '');
  const isOut = !!ev.message.is_echo || (!!businessId && senderId === businessId);
  const leadId = isOut ? recipientId : senderId; // the OTHER party is always the lead
  // GUARD 2 (belt-and-suspenders) — self-DM edge: if the resolved lead is ALSO the
  // business account, there is no real lead here. Drop it so server.js never answers
  // the owner's own typed text as if a lead (atunrolaaluko, mangoboymangoman).
  if (businessId && leadId === businessId) return null;
  return {
    direction: isOut ? 'out' : 'in',
    leadId,
    text,
    attachments,
    mid: ev.message.mid ? String(ev.message.mid) : null,
    timestamp: ev.timestamp,
  };
}

/**
 * Normalize a webhook POST body into events: [{ direction, leadId, text, mid }].
 * Includes BOTH inbound lead messages AND outbound echoes (so the owner's own
 * Instagram-app replies appear in the thread). Meta delivers Instagram messaging
 * webhooks in two observed shapes — entry[].messaging[] (Messenger-style) and
 * entry[].changes[] with field:"messages" (Graph-API style / dashboard Test) —
 * so both are parsed. read receipts / reactions / typing have no `message` and
 * are dropped.
 */
export function igParseInbound(body, resolveBusiness = null) {
  const out = [];
  for (const entry of body?.entry || []) {
    // Which professional account is this entry for? entry.id is the account's
    // id in the OAuth era; the env-token era relies on IG_BUSINESS_ID.
    const entryId = String(entry?.id || '');
    const businessId = (typeof resolveBusiness === 'function' ? resolveBusiness(entryId, entry) : null) || String(process.env.IG_BUSINESS_ID || entryId || '');
    for (const ev of entry.messaging || []) {
      const parsed = extractMessageEvent(ev, businessId);
      if (parsed) out.push({ ...parsed, businessId });
    }
    for (const change of entry.changes || []) {
      if (change.field !== 'messages') continue;
      const parsed = extractMessageEvent(change.value, businessId);
      if (parsed) out.push({ ...parsed, businessId });
    }
  }
  return out.filter((e) => e.leadId);
}

/**
 * Send a sender_action to the recipient: 'mark_seen' (read receipt), 'typing_on'
 * or 'typing_off'. Used for the humanizing typing indicator before autopilot
 * replies. Best-effort — callers swallow errors so a presence hiccup never
 * blocks the actual message.
 */
export async function igSendAction(recipientId, action) {
  const res = await fetch(`${GRAPH}/me/messages?access_token=${encodeURIComponent(tokenOf())}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: recipientId }, sender_action: action }),
  });
  return graphSend(res, `IG action ${action} failed`);
}

/** Send a text DM via the Graph API. */
export async function igSendText(recipientId, text) {
  const res = await fetch(`${GRAPH}/me/messages?access_token=${encodeURIComponent(tokenOf())}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: recipientId }, message: { text } }),
  });
  return graphSend(res, 'IG send failed');
}

/**
 * Send an audio attachment (Audio Arsenal voice note) by public URL — Instagram
 * fetches the file itself, so `url` must be reachable (our /api/attachments/:id).
 * m4a/mp3/aac are the safe formats; a browser-recorded webm may be rejected.
 */
export async function igSendAudio(recipientId, url) {
  const res = await fetch(`${GRAPH}/me/messages?access_token=${encodeURIComponent(tokenOf())}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: recipientId }, message: { attachment: { type: 'audio', payload: { url, is_reusable: false } } } }),
  });
  return graphSend(res, 'IG audio send failed');
}

/**
 * Connection status for the Settings page. Reports which credentials are set
 * (never their values) and, when fully configured, does a live Graph API call
 * to confirm the token works and fetch the connected account's @handle.
 */
export async function igStatus() {
  const c = creds();
  const out = {
    configured: !!c,
    has_page_token: !!c,
    has_verify_token: !!process.env.IG_VERIFY_TOKEN,
    has_business_id: !!c?.businessId,
    oauth_available: igOauthConfigured(),
    account: null,
    error: null,
  };
  if (!out.configured) return out;
  try {
    const res = await fetch(`${GRAPH}/${c.businessId}?fields=id,username,name&access_token=${encodeURIComponent(c.token)}`);
    if (res.ok) { out.account = await res.json(); emitAuthError(null); } // healthy token → clear any prior auth error
    else {
      const body = await res.text();
      out.error = `Graph API ${res.status}`; out.reachable = false;
      if (isAuthFailure(res.status, body)) emitAuthError(`IG status ${res.status}: ${body}`.slice(0, 300));
    }
  } catch (e) { out.error = e.message; }
  return out;
}

/**
 * Best-effort profile lookup for a new inbound sender (IGSID → username/name).
 * NOTE: on Standard Access (no App Review) Instagram returns {} here — the
 * sender's username/name/profile_pic are gated behind Advanced Access. So this
 * usually resolves nothing and callers fall back to the raw sender id. Kept so
 * it lights up automatically if the app later gains Advanced Access.
 */
export async function igProfile(senderId) {
  try {
    const res = await fetch(`${GRAPH}/${senderId}?fields=name,username,profile_pic&access_token=${encodeURIComponent(tokenOf())}`);
    if (!res.ok) {
      const body = await res.text();
      if (isAuthFailure(res.status, body)) emitAuthError(`IG profile ${res.status}: ${body}`.slice(0, 300));
      return null;
    }
    const json = await res.json();
    return (json && (json.username || json.name)) ? json : null;
  } catch { return null; }
}

/**
 * Backfill existing conversations + their recent message history from the
 * Conversations API. Returns [{ leadId, handle, name, messages:[{mid, role,
 * text, created_time}] }] where role is 'setter' for the business's own messages
 * (from.id === IG_BUSINESS_ID) and 'lead' otherwise. Attachment-only messages get
 * a '[attachment]' text placeholder (media isn't downloaded in this pass — the
 * API's history URLs are short-lived). Pages up to maxPages. [] if not configured.
 */
export async function igFetchHistory({ convLimit = 25, msgLimit = 40, maxPages = 8, concurrency = 10, reqTimeout = 8000 } = {}) {
  const c = creds();
  if (!c) return [];
  const token = c.token, businessId = c.businessId;
  const tok = encodeURIComponent(token);

  // Fetch JSON with a hard per-request timeout so one slow/hung call can't stall
  // the whole backfill. Returns null on any non-2xx / abort / network error.
  const getJson = async (url) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), reqTimeout);
    try {
      const res = await fetch(url, { signal: ac.signal });
      if (res.ok) return res.json();
      const body = await res.text();
      if (isAuthFailure(res.status, body)) emitAuthError(`IG history ${res.status}: ${body}`.slice(0, 300));
      return null;
    } catch { return null; } finally { clearTimeout(timer); }
  };

  // 1) Page the conversation LIST (light: participants only). A single nested
  //    conversations+messages call trips Meta's "reduce the amount of data" 500,
  //    so messages are fetched per-conversation below instead.
  const convs = [];
  let next = `${GRAPH}/me/conversations?platform=instagram&fields=participants&limit=${convLimit}&access_token=${tok}`;
  for (let page = 0; next && page < maxPages; page++) {
    const json = await getJson(next);
    if (!json) break;
    for (const c of (json.data || [])) convs.push(c);
    next = json.paging?.next || null;
  }

  // 2) Fetch each conversation's messages in its own small request, in parallel
  //    batches (sequential N+1 over ~25 threads is too slow / times out).
  const fields = encodeURIComponent(`messages.limit(${msgLimit}){id,from,message,created_time}`);
  const buildThread = (conv, mjson) => {
    const parts = conv.participants?.data || [];
    const lead = parts.find((p) => String(p.id) !== businessId);
    const messages = (mjson?.messages?.data || []).map((m) => ({
      mid: String(m.id || ''),
      fromId: String(m.from?.id || ''),
      role: String(m.from?.id || '') === businessId ? 'setter' : 'lead',
      text: (m.message || '').trim() || '[attachment]', // empty text ⇒ a media/non-text message
      created_time: m.created_time || null,
    })).filter((m) => m.mid);
    const leadId = lead?.id || messages.map((m) => m.fromId).find((id) => id && id !== businessId) || null;
    if (!leadId || !messages.length) return null;
    return { leadId: String(leadId), handle: lead?.username || String(leadId), name: lead?.name || null, messages };
  };

  const threads = [];
  for (let i = 0; i < convs.length; i += concurrency) {
    const batch = convs.slice(i, i + concurrency);
    const built = await Promise.all(batch.map(async (conv) =>
      buildThread(conv, await getJson(`${GRAPH}/${conv.id}?fields=${fields}&access_token=${tok}`))));
    for (const t of built) if (t) threads.push(t);
  }
  return threads;
}

/**
 * Instagram channel adapter, built on Meta's "Instagram API with Instagram
 * Login" (graph.instagram.com) with exactly two permissions:
 * instagram_business_basic and instagram_business_manage_messages.
 *
 * Accounts connect through Instagram Login (OAuth, see igAuthUrl) and their
 * 60-day token is stored encrypted per account. The first account may still run
 * on the legacy env token (IG_PAGE_TOKEN + IG_BUSINESS_ID) during the transition.
 *
 * EVERY outbound call to the Send API (text, audio, sender actions) passes
 * through outboundGate() below. The gate is the single place that enforces
 * Meta's rules and our anti-spam limits, so no caller can bypass them:
 *   1. the 24-hour standard messaging window (never initiate, never send after
 *      24h of lead silence; message tags such as HUMAN_AGENT are never used),
 *   2. an automation pause while the account needs reconnecting,
 *   3. per-account send spacing, a per-account hourly cap and a per-lead
 *      hourly cap for automated sends,
 *   4. a back-off after Meta answers with a rate-limit error.
 * Graph errors are classified (classifyGraphError) into a typed IgSendError so
 * callers park the message for a human instead of retrying.
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
// A dead/revoked token otherwise fails silently. server.js registers a handler
// via onIgAuthError; we invoke it (fire-and-forget) with a detail string on any
// detected AUTH or PERMISSION failure, and with null to CLEAR after a successful
// status fetch. server.js flips the account to needs_reconnect, which pauses
// every send through the outbound gate until the token is healthy again.
let authErrorHandler = null;
export function onIgAuthError(fn) { authErrorHandler = fn; }

/** Fire the registered handler; wrapped so a handler bug never breaks a send. */
function emitAuthError(detail) {
  try { authErrorHandler && authErrorHandler(detail); } catch { /* handler is best-effort */ }
}

// Other send problems the owner should hear about (policy restriction, rate
// limit back-off). server.js registers a notifier; best-effort like the above.
let sendIssueHandler = null;
export function onIgSendIssue(fn) { sendIssueHandler = fn; }
function emitSendIssue(kind, detail) {
  try { sendIssueHandler && sendIssueHandler(kind, detail); } catch { /* best-effort */ }
}

// ---- Meta error classification ----
// Instagram Platform error codes we act on. Anything not listed is 'unknown'
// (or 'transient' for 5xx), which callers treat as a plain failure.
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80002, 80006]);
const WINDOW_SUBCODES = new Set([2534022, 2018278]);                        // "sent outside of allowed window"
const UNAVAILABLE_SUBCODES = new Set([2534014, 1545041, 2018001, 2534013]); // user gone, blocked us, or not found
const PERMISSION_CODES = new Set([10, 200, 3, 299]);
const AUTH_CODES = new Set([190, 102, 463, 467]);

/** Parse a Graph error body (string or object) into { code, subcode, message, type }. */
function parseGraphError(body) {
  let j = body;
  if (typeof body === 'string') { try { j = JSON.parse(body); } catch { j = null; } }
  const e = (j && j.error) || {};
  return {
    code: Number(e.code) || null,
    subcode: Number(e.error_subcode) || null,
    message: String(e.message || (typeof body === 'string' ? body : '') || '').slice(0, 300),
    type: e.type || null,
  };
}

/**
 * Map an HTTP status + Graph error body to one of:
 *   outside_window | blocked_user | rate_limit | auth | permission |
 *   policy_block | transient | invalid | unknown
 * Body codes win over the HTTP status: Meta can answer a window error with 400
 * or 403, and that must never be read as a dead token.
 */
export function classifyGraphError(status, body) {
  const { code, subcode, message, type } = parseGraphError(body);
  const out = (kind) => ({ kind, code, subcode, message });
  if (subcode && WINDOW_SUBCODES.has(subcode)) return out('outside_window');
  if (/outside of (the )?allowed window/i.test(message)) return out('outside_window');
  if (code === 551 || (subcode && UNAVAILABLE_SUBCODES.has(subcode))) return out('blocked_user');
  if (code === 368) return out('policy_block');
  if ((code && RATE_LIMIT_CODES.has(code)) || status === 429) return out('rate_limit');
  if ((code && AUTH_CODES.has(code)) || (type === 'OAuthException' && !code)) return out('auth');
  if (code && PERMISSION_CODES.has(code)) return out('permission');
  if (code === 1 || code === 2 || status >= 500) return out('transient');
  if (code === 100) return out('invalid');
  if (status === 401) return out('auth');
  if (status === 403) return out('permission');
  return out('unknown');
}

/** True when a status/body pair means the token or its permissions are no good. */
function isAuthFailure(status, body) {
  const k = classifyGraphError(status, body).kind;
  return k === 'auth' || k === 'permission';
}

// Reasons shown to the owner (needs_human_reason and API errors). Plain words.
export const SEND_REASONS = {
  outside_window: 'outside 24h window',
  paused: 'instagram needs reconnect',
  auth: 'instagram needs reconnect',
  permission: 'instagram needs reconnect',
  not_connected: 'instagram not connected',
  blocked_user: 'lead unavailable (blocked or account gone)',
  policy_block: 'instagram restricted sending, automation paused',
  rate_limit: 'rate limited by instagram, review before sending',
  backoff: 'rate limited by instagram, review before sending',
  throttled: 'send rate limit reached, review before sending',
  account_cap: 'hourly send limit reached, review before sending',
  lead_cap: 'per lead hourly limit reached, review before sending',
  network: 'send outcome unknown, check instagram before resending',
};

/**
 * Typed send failure. `kind` is a SEND_REASONS key, or transient / invalid /
 * unknown. `park` is true when the caller must NOT retry and should hand the
 * message to a human (window, block, limits, auth, unknown outcome). `gate` is
 * true when the send was refused locally and nothing reached Meta.
 */
export class IgSendError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'IgSendError';
    this.kind = kind;
    this.reason = SEND_REASONS[kind] || ('send failed: ' + String(message || kind).slice(0, 120));
    this.park = Object.prototype.hasOwnProperty.call(SEND_REASONS, kind);
    this.status = extra.status ?? null;
    this.code = extra.code ?? null;
    this.subcode = extra.subcode ?? null;
    this.gate = !!extra.gate;
  }
}

// ---- 24-hour standard messaging window ----
export const IG_WINDOW_MS = 24 * 3600 * 1000;
// Safety margin: last_lead_message_at is stamped when we PROCESS the webhook,
// slightly after the lead actually wrote, and clocks drift. Closing the window
// five minutes early keeps every send clear of Meta's edge.
export const IG_WINDOW_SAFETY_MS = 5 * 60 * 1000;
/** May we message a lead whose last inbound message was at `lastInboundAt`? null/unknown = no (never initiate). */
export function igWindowOpen(lastInboundAt, now = Date.now()) {
  if (!lastInboundAt) return false;
  const t = typeof lastInboundAt === 'number' ? lastInboundAt : Date.parse(lastInboundAt);
  if (!Number.isFinite(t)) return false;
  return now - t < IG_WINDOW_MS - IG_WINDOW_SAFETY_MS;
}

// ---- outbound context + send policy (registered by server.js) ----
// The outbound context says, for a recipient of the CURRENT account, when the
// lead last messaged us and whether automation is paused. An unknown recipient
// (no conversation) has no inbound time, so the gate refuses: we never start a
// conversation with someone who has not messaged first.
let outboundContextResolver = () => null;
export function setOutboundContextResolver(fn) { outboundContextResolver = fn; }
let sendPolicyResolver = () => ({});
export function setSendPolicyResolver(fn) { sendPolicyResolver = fn; }

const envNum = (k, d) => {
  const raw = process.env[k];
  if (raw == null || raw === '') return d;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : d;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
/**
 * Effective send policy. Operator defaults come from env; an account's own
 * settings may only move within safe bounds (spacing at least 1s, at most 200
 * messages an hour, at most 30 automated messages per lead an hour).
 */
export function sendPolicy() {
  const p = {
    minIntervalMs: envNum('IG_RATE_MIN_INTERVAL_MS', 2000),
    maxPerHour: envNum('IG_RATE_MAX_PER_HOUR', 100),
    maxPerLeadHour: envNum('IG_RATE_MAX_PER_LEAD_HOUR', 10),
    maxQueueWaitMs: envNum('IG_RATE_MAX_QUEUE_WAIT_MS', 60_000),
    backoffBaseMs: envNum('IG_RATE_BACKOFF_MS', 60_000),
  };
  let o = {};
  try { o = sendPolicyResolver() || {}; } catch { o = {}; }
  const n = (v) => (v === '' || v == null ? NaN : Number(v));
  if (Number.isFinite(n(o.minIntervalMs))) p.minIntervalMs = clamp(n(o.minIntervalMs), 1000, 60_000);
  if (Number.isFinite(n(o.maxPerHour))) p.maxPerHour = clamp(n(o.maxPerHour), 1, 200);
  if (Number.isFinite(n(o.maxPerLeadHour))) p.maxPerLeadHour = clamp(n(o.maxPerLeadHour), 1, 30);
  return p;
}

// Per professional account: the next free send slot, a sliding hour of sends,
// per-lead logs and the back-off deadline. In memory; the after-restart burst is
// handled by the scheduler parking stale work and by the persisted send state
// in server.js.
const HOUR = 3600 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A gated Send API client for one Meta messaging channel. Instagram uses it
 * below; lib/messenger.js builds a second one for Facebook Pages, so both
 * channels get the same 24h window, pause, spacing, caps and back-off.
 *   graphBase   Graph host + version (Instagram and Messenger differ)
 *   creds       () => { token, businessId } | null for the CURRENT account
 *   context     (recipientId) => { lastInboundAt, paused } for the CURRENT account
 *   onAuthError / onSendIssue   owner notifications (best-effort)
 *   label       channel name for error messages ('Instagram' | 'Messenger')
 *   payload     (payload) => payload, a last hook for channel-specific fields
 */
export function createMetaSender({ graphBase, creds: credsFn, context, onAuthError = () => {}, onSendIssue = () => {}, label = 'Instagram', payload: shape = (p) => p }) {
  const state = new Map();
  const stateFor = (businessId) => {
    let st = state.get(businessId);
    if (!st) { st = { nextSlotAt: 0, sends: [], leads: new Map(), backoffUntil: 0, backoffStep: 0 }; state.set(businessId, st); }
    return st;
  };
  const credsNow = () => { try { return credsFn() || null; } catch { return null; } };

  /**
   * The single outbound gate. kind 'message' (text/audio) or 'action' (typing,
   * mark_seen). Throws IgSendError (gate = true) when the send must not happen.
   * For messages it also reserves a send slot and waits for it, so sends from one
   * account are spaced by minIntervalMs whichever code path fired them.
   */
  async function outboundGate(recipientId, { kind = 'message', source = 'ai' } = {}) {
    const c = credsNow();
    if (!c) throw new IgSendError('not_connected', `${label} is not connected`, { gate: true });
    let ctx = null;
    try { ctx = context(String(recipientId)) || null; } catch { ctx = null; }
    if (ctx && ctx.paused) throw new IgSendError('paused', String(ctx.paused), { gate: true });
    if (!igWindowOpen(ctx && ctx.lastInboundAt)) {
      throw new IgSendError('outside_window', 'Outside the 24 hour messaging window: the lead has not messaged in the last 24 hours', { gate: true });
    }
    if (kind !== 'message') return;
    const st = stateFor(c.businessId);
    const p = sendPolicy();
    const now = Date.now();
    if (st.backoffUntil > now) throw new IgSendError('backoff', `Backing off after a ${label} rate limit`, { gate: true });
    st.sends = st.sends.filter((t) => t > now - HOUR);
    if (st.sends.length >= p.maxPerHour) throw new IgSendError('account_cap', `Hourly send cap (${p.maxPerHour}) reached`, { gate: true });
    const rid = String(recipientId);
    const leadLog = (st.leads.get(rid) || []).filter((t) => t > now - HOUR);
    if (source !== 'human' && leadLog.length >= p.maxPerLeadHour) {
      throw new IgSendError('lead_cap', `Per lead hourly cap (${p.maxPerLeadHour}) reached`, { gate: true });
    }
    const slot = Math.max(now, st.nextSlotAt);
    if (slot - now > p.maxQueueWaitMs) throw new IgSendError('throttled', 'Too many sends queued for this account', { gate: true });
    st.nextSlotAt = slot + p.minIntervalMs;
    st.sends.push(slot);
    leadLog.push(slot); st.leads.set(rid, leadLog);
    if (slot > now) await sleep(slot - now);
    if (st.backoffUntil > Date.now()) throw new IgSendError('backoff', `Backing off after a ${label} rate limit`, { gate: true });
  }

  /**
   * POST to the Send API through the gate, then classify any failure. A network
   * error (no HTTP answer) is kind 'network': the message MAY have been delivered,
   * so callers must not resend it blindly.
   */
  async function send(recipientId, body, errLabel, gateOpts) {
    // Message tags (HUMAN_AGENT and friends) are never used: standard window only.
    if (body.tag || body.messaging_type === 'MESSAGE_TAG') throw new IgSendError('invalid', 'message tags are not used by this app', { gate: true });
    await outboundGate(recipientId, gateOpts);
    const c = credsNow();
    if (!c) throw new IgSendError('not_connected', `${label} is not connected`, { gate: true });
    let res;
    try {
      res = await fetch(`${graphBase}/me/messages?access_token=${encodeURIComponent(c.token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(shape({ recipient: { id: String(recipientId) }, ...body })),
      });
    } catch (e) {
      throw new IgSendError('network', `${errLabel}: ${e.message}`);
    }
    if (res.ok) {
      stateFor(c.businessId).backoffStep = 0;
      return res.json().catch(() => ({}));
    }
    const text = await res.text();
    const cls = classifyGraphError(res.status, text);
    const detail = `${errLabel} ${res.status}: ${text}`.slice(0, 300);
    if (cls.kind === 'auth' || cls.kind === 'permission') onAuthError(detail);
    if (cls.kind === 'rate_limit') {
      const st = stateFor(c.businessId);
      const wait = Math.min(HOUR, sendPolicy().backoffBaseMs * 2 ** st.backoffStep);
      st.backoffStep = Math.min(st.backoffStep + 1, 10);
      st.backoffUntil = Date.now() + wait;
      onSendIssue('rate_limit', `${detail} (backing off ${Math.round(wait / 1000)}s)`);
    }
    if (cls.kind === 'policy_block') {
      stateFor(c.businessId).backoffUntil = Date.now() + 6 * HOUR;
      onSendIssue('policy_block', detail);
    }
    throw new IgSendError(cls.kind, detail, { status: res.status, code: cls.code, subcode: cls.subcode });
  }

  return { send, resetState: () => state.clear() };
}

const igSender = createMetaSender({
  graphBase: GRAPH, creds, context: (rid) => outboundContextResolver(rid), onAuthError: emitAuthError, onSendIssue: emitSendIssue, label: 'Instagram',
});
const sendViaGraph = (recipientId, payload, label, gateOpts) => igSender.send(recipientId, payload, label, gateOpts);
/** Test hook: forget all throttle and back-off state. */
export function _resetSendState() { igSender.resetState(); }

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
  // read/seen receipts, reactions, postbacks and typing carry no `message`;
  // an unsent ("deleted") message is not something to answer either.
  if (!ev?.message || ev.read || ev.message.is_deleted) return null;
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
 * replies. Passes the window gate (no throttle slot). Callers treat it as
 * best-effort.
 */
export async function igSendAction(recipientId, action) {
  return sendViaGraph(recipientId, { sender_action: action }, `IG action ${action} failed`, { kind: 'action' });
}

/** Send a text DM. opts.source ('ai' | 'followup' | 'human') decides which caps apply. */
export async function igSendText(recipientId, text, opts = {}) {
  return sendViaGraph(recipientId, { message: { text } }, 'IG send failed', { kind: 'message', source: opts.source || 'ai' });
}

/**
 * Send an audio attachment (Audio Arsenal voice note) by public URL. Instagram
 * fetches the file itself, so `url` must be reachable (our /api/attachments/:id).
 * m4a/mp3/aac are the safe formats; a browser-recorded webm may be rejected.
 */
export async function igSendAudio(recipientId, url, opts = {}) {
  return sendViaGraph(recipientId, { message: { attachment: { type: 'audio', payload: { url, is_reusable: false } } } }, 'IG audio send failed', { kind: 'message', source: opts.source || 'ai' });
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

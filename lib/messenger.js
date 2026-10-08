/**
 * Facebook Messenger channel adapter (Messenger Platform on a Facebook Page).
 *
 * Messenger is close to Instagram messaging: the same Send API shape
 * (POST /me/messages with a Page access token), the same webhook shape
 * (entry[].messaging[] with is_echo for the Page's own sends) and the same
 * 24-hour standard messaging window. So every send goes through the shared
 * gate from lib/instagram.js (createMetaSender): window, pause on reconnect,
 * spacing, caps and back-off are identical to Instagram's. Message tags are
 * never used.
 *
 * Credentials: a Page id + Page access token per account, stored encrypted in
 * messenger_pages by server.js (Settings > Messenger). The first account may also
 * run on env vars (FB_PAGE_ID + FB_PAGE_TOKEN). Needs the pages_messaging
 * permission on the Meta app.
 */
import { createMetaSender, igParseInbound, classifyGraphError } from './instagram.js';

// Graph base — overridable via FB_GRAPH_BASE for local end-to-end tests (prod never sets it).
const GRAPH = process.env.FB_GRAPH_BASE || 'https://graph.facebook.com/v21.0';

// ---- per-account credentials (registered by server.js) ----
let credsResolver = () => (process.env.FB_PAGE_TOKEN && process.env.FB_PAGE_ID
  ? { token: process.env.FB_PAGE_TOKEN, businessId: String(process.env.FB_PAGE_ID) } : null);
export function setFbCredsResolver(fn) { credsResolver = fn; }
function creds() { try { return credsResolver() || null; } catch { return null; } }

/** Does the current account have a usable Messenger (Page) connection? */
export function fbConfigured() { return !!creds(); }

let outboundContextResolver = () => null;
export function setFbOutboundContextResolver(fn) { outboundContextResolver = fn; }
let authErrorHandler = null;
export function onFbAuthError(fn) { authErrorHandler = fn; }
const emitAuthError = (detail) => { try { authErrorHandler && authErrorHandler(detail); } catch { /* best-effort */ } };
let sendIssueHandler = null;
export function onFbSendIssue(fn) { sendIssueHandler = fn; }
const emitSendIssue = (kind, detail) => { try { sendIssueHandler && sendIssueHandler(kind, detail); } catch { /* best-effort */ } };

const fbSender = createMetaSender({
  graphBase: GRAPH, creds, context: (rid) => outboundContextResolver(rid), onAuthError: emitAuthError, onSendIssue: emitSendIssue, label: 'Messenger',
  // Messenger requires messaging_type on every message; replies inside the
  // 24h window are RESPONSE. Sender actions (typing, mark_seen) carry none.
  payload: (p) => (p.message ? { messaging_type: 'RESPONSE', ...p } : p),
});
/** Test hook: forget all throttle and back-off state. */
export function _resetFbSendState() { fbSender.resetState(); }

/** 'mark_seen' | 'typing_on' | 'typing_off'. Window-gated, no throttle slot. Best-effort for callers. */
export async function fbSendAction(recipientId, action) {
  return fbSender.send(recipientId, { sender_action: action }, `Messenger action ${action} failed`, { kind: 'action' });
}
/** Send a text message. opts.source ('ai' | 'followup' | 'human') decides which caps apply. */
export async function fbSendText(recipientId, text, opts = {}) {
  return fbSender.send(recipientId, { message: { text } }, 'Messenger send failed', { kind: 'message', source: opts.source || 'ai' });
}
/** Send an audio attachment by public URL (our /api/attachments/:id). */
export async function fbSendAudio(recipientId, url, opts = {}) {
  return fbSender.send(recipientId, { message: { attachment: { type: 'audio', payload: { url, is_reusable: false } } } }, 'Messenger audio send failed', { kind: 'message', source: opts.source || 'ai' });
}

/**
 * Normalize a Messenger webhook body (object 'page') into the same events
 * Instagram produces: [{ direction, leadId, text, attachments, mid, timestamp, businessId }].
 * entry.id is the Page id; echoes (is_echo) are the Page's own sends.
 */
export function fbParseInbound(body) {
  if (body?.object && body.object !== 'page') return [];
  return igParseInbound({ entry: body?.entry || [] }, (entryId) => entryId || null);
}

/** GET /webhook/messenger — Meta's subscription handshake (FB_VERIFY_TOKEN, else IG_VERIFY_TOKEN). */
export function fbVerifyWebhook(req, res) {
  const expected = process.env.FB_VERIFY_TOKEN || process.env.IG_VERIFY_TOKEN;
  if (expected && req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === expected) {
    return res.send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
}

const isAuthFailure = (status, body) => ['auth', 'permission'].includes(classifyGraphError(status, body).kind);

/** Look up a Page with a token: { id, name } or throws a readable error. Used when connecting. */
export async function fbPageInfo(pageId, token) {
  const r = await fetch(`${GRAPH}/${encodeURIComponent(pageId)}?fields=id,name&access_token=${encodeURIComponent(token)}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.id) throw new Error(j.error?.message || `Facebook answered ${r.status}`);
  return { id: String(j.id), name: j.name || null };
}

/** Subscribe the app to this Page's message webhooks. Best-effort; returns true on success. */
export async function fbSubscribePage(pageId, token) {
  try {
    const r = await fetch(`${GRAPH}/${encodeURIComponent(pageId)}/subscribed_apps?subscribed_fields=messages,message_echoes&access_token=${encodeURIComponent(token)}`, { method: 'POST' });
    return r.ok;
  } catch { return false; }
}

/** Connection status for Settings: live check of the stored token, clears a prior auth error when healthy. */
export async function fbStatus() {
  const c = creds();
  const out = { configured: !!c, page: null, error: null };
  if (!c) return out;
  try {
    const r = await fetch(`${GRAPH}/${c.businessId}?fields=id,name&access_token=${encodeURIComponent(c.token)}`);
    if (r.ok) { out.page = await r.json(); emitAuthError(null); }
    else {
      const body = await r.text();
      out.error = `Graph API ${r.status}`;
      if (isAuthFailure(r.status, body)) emitAuthError(`Messenger status ${r.status}: ${body}`.slice(0, 300));
    }
  } catch (e) { out.error = e.message; }
  return out;
}

/**
 * Name of a new sender (Page-scoped id → first/last name). Messenger's user
 * profile API returns these with pages_messaging. Best-effort: null on failure.
 */
export async function fbProfile(psid) {
  const c = creds();
  if (!c) return null;
  try {
    const r = await fetch(`${GRAPH}/${encodeURIComponent(psid)}?fields=first_name,last_name,name&access_token=${encodeURIComponent(c.token)}`);
    if (!r.ok) {
      const body = await r.text();
      if (isAuthFailure(r.status, body)) emitAuthError(`Messenger profile ${r.status}: ${body}`.slice(0, 300));
      return null;
    }
    const j = await r.json();
    const name = j?.name || [j?.first_name, j?.last_name].filter(Boolean).join(' ');
    return name ? { name, first_name: j.first_name || null } : null;
  } catch { return null; }
}

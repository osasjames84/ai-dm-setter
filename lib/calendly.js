/**
 * Calendly availability (read-only). Calendly's public API exposes availability
 * but does NOT allow creating a booking programmatically, so this fetches the
 * account's next open slots; the setter proposes those REAL times in-DM and the
 * lead confirms via the scheduling link. Dormant until calendly_token is set.
 *
 * A module-level cache (refreshed on a timer by server.js) lets the otherwise
 * synchronous engineSettings() read formatted availability without awaiting.
 */
import { randomBytes } from 'node:crypto';

const API = 'https://api.calendly.com';
let _cache = null; // { at, text }

async function cget(token, pathQ) {
  const res = await fetch(API + pathQ, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Calendly ${res.status}: ${await res.text()}`);
  return res.json();
}

/**
 * Fetch the next `limit` available slots for the account's first active event
 * type. Returns { slots:[ISO], link, timezone, duration } or null. `now` is
 * injectable for tests.
 */
export async function fetchAvailability(token, { limit = 5, days = 7, now = Date.now() } = {}) {
  if (!token) return null;
  const me = await cget(token, '/users/me');
  const user = me?.resource;
  if (!user?.uri) return null;
  const ets = await cget(token, `/event_types?user=${encodeURIComponent(user.uri)}&active=true&count=1`);
  const et = ets?.collection?.[0];
  if (!et?.uri) return null;
  // Calendly caps the window at 7 days; keep start just ahead of now.
  const start = new Date(now + 60 * 60 * 1000).toISOString();
  const end = new Date(now + Math.min(days, 7) * 24 * 60 * 60 * 1000).toISOString();
  const avail = await cget(token, `/event_type_available_times?event_type=${encodeURIComponent(et.uri)}&start_time=${start}&end_time=${end}`);
  const slots = (avail?.collection || []).map((s) => s.start_time).filter(Boolean).slice(0, limit);
  return { slots, link: et.scheduling_url || user.scheduling_url || '', timezone: user.timezone || 'UTC', duration: et.duration || null };
}

/** Format an ISO slot in a timezone as e.g. "Tue Jul 8, 2:00 PM". */
export function formatSlot(iso, timezone) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: timezone || 'UTC',
    }).format(new Date(iso));
  } catch { return iso; }
}

/** Build the prompt snippet from an availability object ('' when none). */
export function availabilityText(avail) {
  if (!avail || !Array.isArray(avail.slots) || !avail.slots.length) return '';
  const lines = avail.slots.map((s) => `- ${formatSlot(s, avail.timezone)}`);
  return [
    `== YOUR REAL CALENDLY AVAILABILITY (propose these ACTUAL open times when booking; times shown in ${avail.timezone}) ==`,
    ...lines,
    avail.link ? `Booking link (send only when they pick a time or ask for it): ${avail.link}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * Subscribe Calendly to POST booking events to our webhook. Calendly API v2:
 *   1. GET /users/me → the current user's uri + organization.
 *   2. GET /webhook_subscriptions (scoped to this user) and DELETE any existing
 *      subscription whose callback_url matches ours — a pre-existing one may lack
 *      a signing key (unverified), so it MUST be replaced, not kept.
 *   3. POST /webhook_subscriptions for invitee.created / invitee.canceled, scoped
 *      to the user, with a signing_key WE generate (Calendly does not mint one;
 *      the creator supplies it in the create body).
 * Returns { id, signing_key } — the new subscription uri plus OUR generated HMAC
 * key (which the webhook endpoint verifies inbound events against). Throws with a
 * useful message on failure.
 * Dormant until the owner has pasted a Calendly PAT into the calendly_token setting.
 */
export async function setupWebhook(token, callbackUrl) {
  if (!token) throw new Error('Calendly token missing');
  if (!callbackUrl) throw new Error('callback URL missing (set PUBLIC_BASE_URL / RAILWAY_PUBLIC_DOMAIN)');
  const me = await cget(token, '/users/me');
  const user = me?.resource;
  const organization = user?.current_organization;
  const userUri = user?.uri;
  if (!organization || !userUri) throw new Error('Calendly /users/me did not return organization + uri');

  // We supply the signing key; Calendly does not generate one. 32 random bytes → 64 hex chars.
  const signingKey = randomBytes(32).toString('hex');

  // Remove any existing subscription for this exact callback URL. A pre-existing
  // one (e.g. created manually without a signing key) accepts deliveries
  // unverified, so it must be replaced — after this a create-409 is a real error.
  const listQ = `/webhook_subscriptions?organization=${encodeURIComponent(organization)}&user=${encodeURIComponent(userUri)}&scope=user`;
  const existing = await cget(token, listQ);
  for (const sub of existing?.collection || []) {
    if (sub?.callback_url !== callbackUrl || !sub?.uri) continue;
    const del = await fetch(sub.uri, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    // 204 = deleted, 404 = already gone (raced). Anything else is a real failure.
    if (!del.ok && del.status !== 404) {
      throw new Error(`Calendly delete webhook ${del.status}: ${await del.text()}`);
    }
  }

  const res = await fetch(API + '/webhook_subscriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: callbackUrl,
      events: ['invitee.created', 'invitee.canceled'],
      organization,
      user: userUri,
      scope: 'user',
      signing_key: signingKey,
    }),
  });
  if (!res.ok) throw new Error(`Calendly webhook_subscriptions ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const sub = body?.resource;
  // Return OUR generated key — Calendly echoes but never mints the signing key.
  return { id: sub?.uri || '', signing_key: signingKey };
}

/** Refresh the module cache from the API. Safe to call on a timer; swallows errors. */
export async function refreshCalendly(token, opts = {}) {
  if (!token) { _cache = null; return; }
  try {
    const avail = await fetchAvailability(token, opts);
    _cache = { at: opts.now || Date.now(), text: availabilityText(avail) };
  } catch (e) { /* keep last good cache; availability is best-effort */ }
}

/** Synchronous cached availability snippet for engineSettings(). '' when none. */
export function calendlyText() {
  return _cache?.text || '';
}

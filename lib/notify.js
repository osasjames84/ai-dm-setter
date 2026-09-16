/**
 * Owner email notifications via Resend — DORMANT until RESEND_API_KEY is set
 * (same pattern as the Stripe/Calendly/transcribe scaffolds: ships safely, lights
 * up when a key appears). server.js wires the recipient list in via initNotify's
 * getEmails getter (reads the comma/space-separated notify_emails setting) so this
 * module owns no db access. notify() is fire-and-forget and NEVER throws — a mail
 * hiccup must never break the send path or become an unhandled rejection.
 */

let _getEmails = () => [];

/** @param {{ getEmails: () => string[] }} deps — getEmails returns the parsed recipient list. */
export function initNotify({ getEmails } = {}) {
  if (typeof getEmails === 'function') _getEmails = getEmails;
}

/** True when the integration is live (key present). Frontend reads this via /api/settings. */
export function notifyReady() {
  return !!process.env.RESEND_API_KEY;
}

/**
 * Best-effort owner email. No-op (silently) when no key or no recipients configured.
 * Catches everything and console.errors once — never throws.
 */
export async function notify(subject, text) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return;                                  // dormant until configured
  let emails = [];
  try { emails = _getEmails() || []; } catch { emails = []; }
  if (!Array.isArray(emails) || !emails.length) return; // nobody to notify
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.NOTIFY_FROM || 'dmSetter <onboarding@resend.dev>',
        to: emails,
        subject: '[dmSetter] ' + String(subject || ''),
        text: String(text || ''),
      }),
    });
  } catch (e) {
    console.error('[notify] email failed:', e.message);
  }
}

/**
 * Send one transactional email to an explicit address (magic links, invites).
 * Returns true when it went to Resend, false when no key is set (the caller
 * logs the link instead). Never throws.
 */
export async function sendEmail(to, subject, text) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.NOTIFY_FROM || 'dmSetter <onboarding@resend.dev>', to: [String(to)], subject: String(subject || ''), text: String(text || '') }),
    });
    return r.ok;
  } catch (e) { console.error('[notify] sendEmail failed:', e.message); return false; }
}

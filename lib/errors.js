/**
 * Error reporting to Sentry without the SDK: one POST to the DSN's envelope
 * endpoint per captured error, tagged with the current account. Dormant until
 * SENTRY_DSN is set. Never throws, never blocks: a reporting failure is logged
 * once and dropped. Rate limited to 30 events a minute so an error loop cannot
 * flood the project.
 */
import crypto from 'node:crypto';
import { currentAccount } from './tenancy.js';

let parsed = null;
let warned = false;
let windowStart = 0, windowCount = 0;

function dsn() {
  if (parsed) return parsed;
  const raw = process.env.SENTRY_DSN;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const projectId = u.pathname.replace(/^\/+/, '');
    parsed = { key: u.username, url: `${u.protocol}//${u.host}/api/${projectId}/envelope/`, release: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.SENTRY_RELEASE || undefined };
    return parsed;
  } catch { if (!warned) { console.error('[errors] SENTRY_DSN is not a valid URL'); warned = true; } return null; }
}

export const errorsReady = () => !!dsn();

function frames(err) {
  const lines = String(err?.stack || '').split('\n').slice(1);
  return lines.map((l) => {
    const m = l.match(/at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/);
    return m ? { function: m[1] || '?', filename: m[2], lineno: Number(m[3]), colno: Number(m[4]) } : null;
  }).filter(Boolean).reverse();
}

/** Report an error with optional extra context. Fire-and-forget. */
export function captureException(err, context = {}) {
  const d = dsn();
  if (!d) return;
  const now = Date.now();
  if (now - windowStart > 60_000) { windowStart = now; windowCount = 0; }
  if (++windowCount > 30) return;
  const e = err instanceof Error ? err : new Error(String(err));
  const event = {
    event_id: crypto.randomUUID().replace(/-/g, ''),
    timestamp: new Date().toISOString(),
    platform: 'node',
    level: 'error',
    release: d.release,
    environment: process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV || 'development',
    tags: { account: currentAccount() || 'none', ...(context.tags || {}) },
    extra: context.extra || {},
    exception: { values: [{ type: e.name, value: String(e.message).slice(0, 500), stacktrace: { frames: frames(e) } }] },
  };
  const envelope = JSON.stringify({ event_id: event.event_id, sent_at: event.timestamp, dsn: process.env.SENTRY_DSN }) + '\n'
    + JSON.stringify({ type: 'event' }) + '\n' + JSON.stringify(event) + '\n';
  fetch(d.url, { method: 'POST', headers: { 'Content-Type': 'application/x-sentry-envelope', 'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${d.key}, sentry_client=dmsetter/0.1` }, body: envelope })
    .catch((x) => { if (!warned) { console.error('[errors] sentry post failed:', x.message); warned = true; } });
}

/** Express error middleware: report, then answer 500 without leaking the stack. */
export function errorMiddleware(err, req, res, next) {
  captureException(err, { tags: { route: req.route?.path || req.path, method: req.method } });
  console.error(`[http] ${req.method} ${req.path} failed:`, err.message);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong' });
}

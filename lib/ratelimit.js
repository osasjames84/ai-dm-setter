/**
 * Small in-memory fixed-window rate limiter. No dependencies, one process.
 *
 *   const lim = createLimiter({ windowMs: 15 * 60_000, max: 20 });
 *   const r = lim.hit('ip:1.2.3.4');   // { ok, remaining, retryAfterS }
 *
 * Counts reset when the window for a key ends. A sweep drops finished windows
 * so the map cannot grow without bound. `now` is injectable for tests.
 */
export function createLimiter({ windowMs, max, now = () => Date.now() }) {
  const hits = new Map(); // key → { n, resetAt }
  let lastSweep = now();
  function sweep(t) {
    if (t - lastSweep < windowMs && hits.size < 50_000) return;
    lastSweep = t;
    for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
  }
  return {
    hit(key) {
      const t = now();
      sweep(t);
      let rec = hits.get(key);
      if (!rec || rec.resetAt <= t) { rec = { n: 0, resetAt: t + windowMs }; hits.set(key, rec); }
      rec.n++;
      const ok = rec.n <= max;
      return { ok, remaining: Math.max(0, max - rec.n), retryAfterS: ok ? 0 : Math.max(1, Math.ceil((rec.resetAt - t) / 1000)) };
    },
    reset() { hits.clear(); },
    size() { return hits.size; },
  };
}

/**
 * Express middleware: one limiter, keyed per request by `key(req)` (return null
 * to skip). Answers 429 with Retry-After and a plain sentence when over.
 */
export function rateLimit({ windowMs, max, key, message = 'Too many attempts. Please wait a few minutes and try again.', json = true }) {
  const lim = createLimiter({ windowMs, max });
  const mw = (req, res, next) => {
    const k = key(req);
    if (k == null) return next();
    const r = lim.hit(String(k));
    if (r.ok) return next();
    res.set('Retry-After', String(r.retryAfterS));
    if (json) return res.status(429).json({ error: message, retry_after_s: r.retryAfterS });
    return res.status(429).type('text').send(message);
  };
  mw.limiter = lim;
  return mw;
}

/** Positive integer from an env value, else the fallback. */
export function envInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

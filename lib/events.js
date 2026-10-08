/**
 * Live updates over server-sent events, one stream per browser tab, scoped to
 * the account that opened it. The server calls bump(accountId, type, id) after
 * a write; every open stream of that account gets one small event and the
 * page refetches what it shows. Nothing sensitive travels on the stream: just
 * a type and an id. A heartbeat every 25s keeps proxies from closing idle
 * connections. Falls back cleanly: when a client cannot use SSE it keeps polling.
 *
 * Streams belong to a session. They end when the session is revoked: logout,
 * logout everywhere, the user being removed or the account deleted call
 * closeStreams(); a periodic sweep re-checks every stream's session with the
 * validator passed to initEvents() in case a revocation path was missed (or the
 * session simply expired). Each account may hold at most `maxPerAccount` open
 * streams; the next one gets a 429 and the page keeps polling.
 */
const streams = new Map(); // accountId → Set<entry>  entry = { res, accountId, userId, sessionHash, beat }
let opts = { maxPerAccount: 20, revalidateMs: 60_000, validate: null };
let sweepTimer = null;

export function initEvents(o = {}) {
  opts = { ...opts, ...o };
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = setInterval(revalidateStreams, opts.revalidateMs);
  sweepTimer.unref?.();
}

function endEntry(e, reason = 'revoked') {
  clearInterval(e.beat);
  streams.get(e.accountId)?.delete(e);
  try { e.res.write(`event: bye\ndata: ${JSON.stringify({ reason })}\n\n`); } catch { /* closed */ }
  try { e.res.end(); } catch { /* closed */ }
}

/**
 * Open a stream. Returns false (after answering 429) when the account is at its
 * limit. `who` = { userId, sessionHash } identifies the session for revocation.
 */
export function openStream(accountId, req, res, who = {}) {
  const set = streams.get(accountId) || new Set();
  if (set.size >= opts.maxPerAccount) {
    res.status(429).set('Retry-After', '30').json({ error: 'Too many live connections for this account. Close some tabs; the page keeps refreshing without one.' });
    return false;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  res.write(`event: hello\ndata: ${JSON.stringify({ account: accountId, at: new Date().toISOString() })}\n\n`);
  streams.set(accountId, set);
  const entry = { res, accountId, userId: who.userId || null, sessionHash: who.sessionHash || null, beat: null };
  entry.beat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 25_000);
  set.add(entry);
  req.on('close', () => { clearInterval(entry.beat); streams.get(accountId)?.delete(entry); });
  return true;
}

/** Tell every open stream of the account that something changed. Never throws. */
export function bump(accountId, type, id = null) {
  const set = streams.get(accountId);
  if (!set || !set.size) return;
  const line = `event: change\ndata: ${JSON.stringify({ type, id, at: new Date().toISOString() })}\n\n`;
  for (const e of set) { try { e.res.write(line); } catch { set.delete(e); } }
}

/**
 * End streams matching any of { accountId, userId, sessionHash }. Returns how
 * many closed. With only accountId every stream of that account ends.
 */
export function closeStreams({ accountId = null, userId = null, sessionHash = null } = {}, reason = 'revoked') {
  let n = 0;
  for (const [acc, set] of streams) {
    if (accountId && acc !== accountId) continue;
    for (const e of [...set]) {
      if (userId && e.userId !== userId) continue;
      if (sessionHash && e.sessionHash !== sessionHash) continue;
      endEntry(e, reason); n++;
    }
  }
  return n;
}

/** Re-check every stream's session; end the ones that are no longer valid. */
export function revalidateStreams() {
  if (typeof opts.validate !== 'function') return 0;
  let n = 0;
  for (const set of streams.values()) {
    for (const e of [...set]) {
      let ok = true;
      try { ok = !!opts.validate(e); } catch { ok = true; }   // a failing check never drops everyone
      if (!ok) { endEntry(e, 'session_ended'); n++; }
    }
  }
  return n;
}

export function streamCount(accountId) { return streams.get(accountId)?.size || 0; }

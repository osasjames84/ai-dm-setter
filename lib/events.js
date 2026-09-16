/**
 * Live updates over server-sent events, one stream per browser tab, scoped to
 * the account that opened it. The server calls bump(accountId, type, id) after
 * a write; every open stream of that account gets one small event and the
 * page refetches what it shows. Nothing sensitive travels on the stream: just
 * a type and an id. A heartbeat every 25s keeps proxies from closing idle
 * connections. Falls back cleanly: when a client cannot use SSE it keeps polling.
 */
const streams = new Map(); // accountId → Set<res>

export function openStream(accountId, req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  res.write(`event: hello\ndata: ${JSON.stringify({ account: accountId, at: new Date().toISOString() })}\n\n`);
  if (!streams.has(accountId)) streams.set(accountId, new Set());
  streams.get(accountId).add(res);
  const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 25_000);
  req.on('close', () => { clearInterval(beat); streams.get(accountId)?.delete(res); });
}

/** Tell every open stream of the account that something changed. Never throws. */
export function bump(accountId, type, id = null) {
  const set = streams.get(accountId);
  if (!set || !set.size) return;
  const line = `event: change\ndata: ${JSON.stringify({ type, id, at: new Date().toISOString() })}\n\n`;
  for (const res of set) { try { res.write(line); } catch { set.delete(res); } }
}

export function streamCount(accountId) { return streams.get(accountId)?.size || 0; }

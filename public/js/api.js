'use strict';
// All transports share cookies and invalidate late responses after logout.
async function sessionFetch(path, opts = {}) {
  const epoch = state.sessionEpoch;
  const { allowUnauthenticated = false, ...request } = opts;
  const res = await fetch(path, { ...request, credentials: 'same-origin' });
  if (epoch !== state.sessionEpoch) throw new Error('Session changed. Please try again.');
  if (res.status === 401 && !allowUnauthenticated) {
    showLogin('Your session expired. Request a new sign-in link.');
    const err = new Error('Please sign in again.'); err.status = 401; throw err;
  }
  return res;
}
async function api(path, opts = {}) {
  const epoch = state.sessionEpoch;
  const res = await sessionFetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    allowUnauthenticated: opts.allowUnauthenticated,
  });
  const data = await res.json().catch(() => ({}));
  if (epoch !== state.sessionEpoch) throw new Error('Session changed. Please try again.');
  if (!res.ok) { const e = new Error(data.error || ('HTTP ' + res.status)); e.status = res.status; e.data = data; throw e; }
  return data;
}

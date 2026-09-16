'use strict';
async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'x-admin-pin': state.pin },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { logout(); throw new Error('Wrong PIN'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || ('HTTP ' + res.status)); e.status = res.status; e.data = data; throw e; }
  return data;
}

/**
 * Timezone helpers for analytics. An account's `timezone` setting is an IANA
 * name (Europe/London). Anything the runtime does not recognise falls back to
 * the server's own zone, and the response says which one was used.
 */
export function serverTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

export function isValidTimezone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return true; } catch { return false; }
}

/** { timezone, source: 'account'|'server' } */
export function resolveTimezone(accountTz) {
  const t = String(accountTz || '').trim();
  if (isValidTimezone(t)) return { timezone: t, source: 'account' };
  return { timezone: serverTimezone(), source: 'server' };
}

/** Returns hourOf(isoOrDate) → 0..23 in the zone, or -1 when the date is unreadable. */
export function hourFormatter(tz) {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' });
  return (v) => {
    const d = v instanceof Date ? v : new Date(v);
    if (Number.isNaN(d.getTime())) return -1;
    const h = Number(fmt.formatToParts(d).find((p) => p.type === 'hour')?.value);
    return Number.isInteger(h) ? h % 24 : -1;
  };
}

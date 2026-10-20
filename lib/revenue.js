/**
 * Revenue card periods, Stripe "Reports overview" style. Pure functions so the
 * date maths is testable: period ranges in the account's time zone, the
 * comparable previous range, and the chart buckets.
 *
 *   1W / 4W / 1Y  rolling 7 / 28 / 365 days; previous = the same length before
 *   MTD / QTD / YTD  from the start of the month / quarter / year to now;
 *                    previous = the same stretch of the previous month / quarter / year
 *   ALL           since the first booking; no previous period
 */

export const PERIODS = ['1W', '4W', '1Y', 'MTD', 'QTD', 'YTD', 'ALL'];
const DAY = 86400_000;

/** Wall-clock parts of `ms` in time zone `tz`. */
function parts(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
  return p;
}
/** UTC ms of local midnight on y-m-d (month 0-based, overflow allowed) in `tz`. */
export function zonedMidnight(y, m, d, tz) {
  const guess = Date.UTC(y, m, d);
  const p = parts(guess, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const offset = asUtc - guess;                       // zone offset at that moment
  const first = guess - offset;
  const q = parts(first, tz);                         // re-check across a DST change
  return first - (Date.UTC(q.year, q.month - 1, q.day, q.hour, q.minute, q.second) - first - offset);
}
const daysInMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/**
 * { start, end, prevStart, prevEnd } in UTC ms for `period` at `now` in `tz`.
 * prevStart/prevEnd are null for ALL. `firstAt` is the earliest booking (ALL only).
 */
export function periodRange(period, now, tz, firstAt = null) {
  const p = parts(now, tz);
  const y = p.year, m = p.month - 1, d = p.day;
  const todayStart = zonedMidnight(y, m, d, tz);
  const elapsed = now - todayStart;                   // time already passed today
  const rolling = { '1W': 7, '4W': 28, '1Y': 365 }[period];
  if (rolling) {
    const start = zonedMidnight(y, m, d - rolling + 1, tz);
    return { start, end: now, prevStart: zonedMidnight(y, m, d - 2 * rolling + 1, tz), prevEnd: start };
  }
  if (period === 'MTD' || period === 'QTD' || period === 'YTD') {
    const sm = period === 'MTD' ? m : period === 'QTD' ? m - (m % 3) : 0;
    const len = period === 'MTD' ? 1 : period === 'QTD' ? 3 : 12;
    const start = zonedMidnight(y, sm, 1, tz);
    // Same day offset into the previous period, capped at that period's own length.
    const dayIndex = Math.round((todayStart - start) / DAY);
    const ps = new Date(Date.UTC(y, sm - len, 1)), py = ps.getUTCFullYear(), pm = ps.getUTCMonth();
    const prevStart = zonedMidnight(py, pm, 1, tz);
    const prevLimit = zonedMidnight(py, pm + len, 1, tz);
    const prevDay = zonedMidnight(py, pm, 1 + dayIndex, tz);
    const prevEnd = Math.min(prevDay + elapsed, prevLimit);
    return { start, end: now, prevStart, prevEnd };
  }
  const first = firstAt ? parts(firstAt, tz) : p;
  return { start: zonedMidnight(first.year, first.month - 1, first.day, tz), end: now, prevStart: null, prevEnd: null };
}

/**
 * Chart buckets between start and end: daily up to ~3 months, monthly beyond.
 * Returns [{ key, start, end }] with key 'YYYY-MM-DD' (day) or 'YYYY-MM' (month).
 */
export function buckets(start, end, tz) {
  const spanDays = (end - start) / DAY;
  const out = [];
  const s = parts(start, tz);
  if (spanDays <= 93) {
    for (let i = 0; ; i++) {
      const b = zonedMidnight(s.year, s.month - 1, s.day + i, tz);
      if (b >= end) break;
      const bp = parts(b, tz);
      out.push({ key: `${bp.year}-${String(bp.month).padStart(2, '0')}-${String(bp.day).padStart(2, '0')}`, start: b, end: zonedMidnight(s.year, s.month - 1, s.day + i + 1, tz) });
      if (out.length > 400) break;
    }
    return { unit: 'day', list: out };
  }
  for (let i = 0; ; i++) {
    const b = i === 0 ? start : zonedMidnight(s.year, s.month - 1 + i, 1, tz);
    if (b >= end) break;
    const bp = parts(b, tz);
    out.push({ key: `${bp.year}-${String(bp.month).padStart(2, '0')}`, start: b, end: zonedMidnight(s.year, s.month + i, 1, tz) });
    if (out.length > 120) break;
  }
  return { unit: 'month', list: out };
}

/** Local calendar date 'YYYY-MM-DD' of `ms` in `tz` (for range labels). */
export function localDate(ms, tz) {
  const p = parts(ms, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

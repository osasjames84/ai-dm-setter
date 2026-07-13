/**
 * Pure trigger-matching helpers (no I/O) so they're deterministic + unit-testable.
 * Used by the scheduler for the Story/Reel Keyword Trigger and the
 * "Turn On AI When I Send…" handoff phrases.
 */

/** Normalize free text for matching: lowercase, strip punctuation, collapse spaces. */
export function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // punctuation → space (Unicode-aware)
    .replace(/\s+/g, ' ')
    .trim();
}

/** Parse a comma-separated keyword string into a clean, normalized list. */
export function parseKeywords(csv) {
  return String(csv || '')
    .split(',')
    .map((k) => normalizeText(k))
    .filter(Boolean);
}

/**
 * Does an inbound message trigger on any of the comma-separated keywords?
 * Fires when the message IS the keyword, when the keyword is the first word, or
 * when the message starts with the keyword (e.g. "COACH I need help"). Case- and
 * punctuation-insensitive. Returns the matched keyword (normalized) or null.
 */
export function matchKeyword(text, keywordsCsv) {
  const norm = normalizeText(text);
  if (!norm) return null;
  for (const kw of parseKeywords(keywordsCsv)) {
    if (norm === kw || norm.startsWith(kw + ' ')) return kw;
  }
  return null;
}

/**
 * Flag Handling: pick the final message to send when a lead is being flagged.
 * Returns '' when the feature is off or nothing is configured. Prefers the
 * per-reason message for `code`, falling back to the generic final message.
 */
export function selectFlagMessage(settings, code) {
  if (!settings || settings.flag_send_final !== '1') return '';
  let map; try { map = JSON.parse(settings.flag_messages || '{}'); } catch { map = {}; }
  const c = String(code || '').trim();
  return String((c && map[c]) || settings.flag_final_message || '').trim();
}

/**
 * Does a coach's OUTBOUND message exactly match any handoff phrase? Whitespace
 * is normalized and comparison is case-insensitive (punctuation preserved so
 * "let's go" ≠ "lets go" would still differ — we only collapse whitespace/case).
 * Returns true on first match.
 */
export function matchExactPhrase(text, phrases) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const t = norm(text);
  if (!t) return false;
  return (Array.isArray(phrases) ? phrases : []).some((p) => norm(p) && norm(p) === t);
}

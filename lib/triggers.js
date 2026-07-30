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
 * Does a coach's OUTBOUND message exactly match any handoff phrase? Compared
 * via normalizeText (case-, punctuation-, and whitespace-insensitive): the
 * owner types these from his PHONE, and a missed comma or apostrophe silently
 * failing the handoff is worse than "let's go" matching "lets go". The message
 * must still BE the whole phrase — not merely contain it.
 * Returns true on first match.
 */
export function matchExactPhrase(text, phrases) {
  // Not normalizeText: that turns punctuation into SPACES, so "how's" would
  // become "how s" and never match a typed "hows". Apostrophes (straight AND
  // the curly U+2019 iPhones auto-insert) must vanish entirely first.
  const norm = (s) => String(s || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const t = norm(text);
  if (!t) return false;
  return (Array.isArray(phrases) ? phrases : []).some((p) => {
    const n = norm(p);
    return n && n === t;
  });
}

/**
 * AI usage reporting. The engine and content modules call report() after every
 * Anthropic response; server.js installs a hook that writes the numbers to the
 * ai_usage table for the current account. No hook installed = nothing happens.
 */
let _hook = null;
export function setUsageHook(fn) { _hook = typeof fn === 'function' ? fn : null; }
export function reportUsage(model, res) {
  if (!_hook || !res || !res.usage) return;
  try {
    _hook({
      model: String(model || ''),
      input: Number(res.usage.input_tokens || 0),
      output: Number(res.usage.output_tokens || 0),
      cache_read: Number(res.usage.cache_read_input_tokens || 0),
      cache_write: Number(res.usage.cache_creation_input_tokens || 0),
    });
  } catch (e) { console.error('[usage] hook failed:', e.message); }
}

/** USD per million tokens (Anthropic list prices, cached 2026-06). Cache reads bill at 0.1x input, cache writes at 1.25x. */
export const PRICES = {
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-opus-5': { input: 5, output: 25 },
};
export function costUsd(row) {
  const p = PRICES[row.model] || PRICES['claude-sonnet-5'];
  return (row.input_tokens * p.input + row.output_tokens * p.output + row.cache_read_tokens * p.input * 0.1 + row.cache_write_tokens * p.input * 1.25) / 1e6;
}

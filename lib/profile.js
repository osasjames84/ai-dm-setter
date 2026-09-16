/**
 * Per-lead profile (E.9): after the lead speaks, a small model reads the
 * thread and keeps a short structured note (goal, blocker, budget signal,
 * objections raised, facts). The engine gets it in the system note so the
 * setter never re-asks what the lead already said, even past the history cap.
 * Best-effort: any failure leaves the previous profile in place.
 */
import { reportUsage } from './usage.js';

const MODEL = 'claude-haiku-4-5-20251001';
const EMPTY = { goal: '', blocker: '', budget_signal: '', objections: [], facts: [], next_step_status: '' };

export function parseProfile(json) {
  try { const p = json ? JSON.parse(json) : null; return p && typeof p === 'object' ? { ...EMPTY, ...p } : null; } catch { return null; }
}

/** One paragraph for the system note, or '' when there is nothing useful yet. */
export function profileNote(profile) {
  if (!profile) return '';
  const parts = [];
  if (profile.goal) parts.push(`goal: ${profile.goal}`);
  if (profile.blocker) parts.push(`main blocker: ${profile.blocker}`);
  if (profile.budget_signal) parts.push(`budget signal: ${profile.budget_signal}`);
  if (Array.isArray(profile.objections) && profile.objections.length) parts.push(`objections raised: ${profile.objections.join('; ')}`);
  if (Array.isArray(profile.facts) && profile.facts.length) parts.push(`facts they told you: ${profile.facts.join('; ')}`);
  if (profile.next_step_status) parts.push(`next step: ${profile.next_step_status}`);
  return parts.length ? `What you already know about this lead (do not ask again): ${parts.join('. ')}.` : '';
}

/** Extract or refresh the profile from the history. Returns the new profile or null on failure. */
export async function extractProfile(anthropic, history, previous) {
  if (!anthropic || !history?.length) return null;
  const transcript = history.slice(-30).map((m) => `${m.role === 'lead' ? 'LEAD' : 'SETTER'}: ${String(m.text).slice(0, 400)}`).join('\n');
  try {
    const res = await anthropic.messages.create({
      model: MODEL, max_tokens: 400,
      system: 'You maintain a short factual profile of a prospect from an Instagram DM thread. Reply with JSON only, this exact shape: {"goal":"","blocker":"","budget_signal":"","objections":[],"facts":[],"next_step_status":""}. Use the lead\'s own words where possible, under 15 words per field, at most 4 objections and 6 facts (age, location, job, injuries, schedule, past attempts). budget_signal is what they said about money, or "". next_step_status is where the booking or next step stands, or "". Leave fields empty when unknown. Never invent.',
      messages: [{ role: 'user', content: `${previous ? 'PREVIOUS PROFILE:\n' + JSON.stringify(previous) + '\n\n' : ''}THREAD:\n${transcript}` }],
    });
    reportUsage(MODEL, res);
    const text = res.content.find((b) => b.type === 'text')?.text || '';
    const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    const str = (v) => String(v || '').slice(0, 200);
    const arr = (v, n) => (Array.isArray(v) ? v.map((x) => String(x).slice(0, 120)).filter(Boolean).slice(0, n) : []);
    return { goal: str(j.goal), blocker: str(j.blocker), budget_signal: str(j.budget_signal), objections: arr(j.objections, 4), facts: arr(j.facts, 6), next_step_status: str(j.next_step_status), updated_at: new Date().toISOString() };
  } catch { return null; }
}

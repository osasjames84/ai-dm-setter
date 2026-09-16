/**
 * Test drive (onboarding step 5): runs the owner's script against simulated
 * leads without touching the inbox. Claude plays each persona, the engine plays
 * the setter, and a small grader model writes short notes on how the script
 * held up. Runs are in memory per process, keyed by job id; the caller stores
 * the pass timestamp in settings.
 *
 *   startTestDrive({ personas, settings, accountId, anthropic, generateMove, leadMove, reportUsage })
 *     → job { id, status: 'running'|'done'|'error', runs: [...], started_at, finished_at }
 */
import crypto from 'node:crypto';
import { PERSONAS, PERSONA_BY_ID } from './personas.js';

const LEAD_MODEL = 'claude-sonnet-5';
const GRADER_MODEL = 'claude-haiku-4-5-20251001';
const MAX_SETTER_TURNS = 6;
const DEFAULT_IDS = ['warm_keyword', 'price_shock', 'think_about_it', 'broke_student', 'skeptic'];
// Ids the frontend contract uses that differ from personas.js.
const ALIASES = { price_hunter: 'price_shock', broke: 'broke_student', underage: 'under_18' };
const DONE_STAGES = new Set(['routed', 'dead', 'call_booked', 'sale']);

const jobs = new Map();
const KEEP_MS = 6 * 60 * 60 * 1000;

export function resolvePersonas(ids) {
  const list = Array.isArray(ids) && ids.length ? ids : DEFAULT_IDS;
  const out = [];
  for (const raw of list) {
    const id = ALIASES[raw] || raw;
    const p = PERSONA_BY_ID.get(id);
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

export function getJob(id) { return jobs.get(String(id)) || null; }
export function listJobs(accountId) { return [...jobs.values()].filter((j) => j.account_id === accountId); }

/** Public shape (no internals). */
export function shapeJob(j) {
  if (!j) return null;
  return { id: j.id, status: j.status, passed: j.passed, started_at: j.started_at, finished_at: j.finished_at, error: j.error || null, runs: j.runs };
}

export function startTestDrive({ personas, settings, accountId, anthropic, generateMove, leadMove, runAs, reportUsage, onDone }) {
  const id = 'td_' + crypto.randomBytes(6).toString('hex');
  const job = { id, account_id: accountId, status: 'running', passed: null, started_at: new Date().toISOString(), finished_at: null, error: null,
    runs: personas.map((p) => ({ persona: { id: p.id, name: p.name, handle: p.handle }, status: 'pending', transcript: [], final_stage: 'lead', flagged: false, flag_reason: '', notes: [], verdict: null })) };
  jobs.set(id, job);
  for (const [k, j] of jobs) if (Date.now() - Date.parse(j.started_at) > KEEP_MS) jobs.delete(k);

  const runOne = async (run, persona) => {
    run.status = 'running';
    const history = [];
    const conv = { id: 'test-' + persona.id, channel: 'sim', handle: persona.handle, display_name: persona.name, persona: persona.id, stage: 'lead', mode: 'autopilot' };
    const offer = settings.prompt_offer || '';
    try {
      let lead = await leadMove(anthropic, LEAD_MODEL, offer, persona, history);
      if (!lead) lead = 'hey';
      history.push({ role: 'lead', text: lead });
      for (let turn = 0; turn < MAX_SETTER_TURNS; turn++) {
        const move = await generateMove(settings, conv, history);
        if (move.needs_human) { run.flagged = true; run.flag_reason = String(move.reason || move.flag_reason_code || 'flagged'); break; }
        for (const m of move.messages || []) history.push({ role: 'setter', text: m });
        conv.stage = move.stage || conv.stage;
        if (DONE_STAGES.has(conv.stage)) break;
        const reply = await leadMove(anthropic, LEAD_MODEL, offer, persona, history);
        if (!reply) break;   // the persona ghosted
        history.push({ role: 'lead', text: reply });
      }
      run.transcript = history;
      run.final_stage = conv.stage;
      const graded = await grade(anthropic, settings, persona, history, reportUsage);
      run.notes = graded.notes; run.verdict = graded.verdict;
      run.status = 'done';
    } catch (e) {
      run.transcript = history; run.status = 'error'; run.notes = ['Run failed: ' + String(e.message).slice(0, 160)]; run.verdict = 'fail';
    }
  };

  (async () => {
    try {
      await runAs(accountId, async () => {
        // Two at a time keeps the run under ~90s without hammering the API.
        for (let i = 0; i < personas.length; i += 2) {
          await Promise.all(personas.slice(i, i + 2).map((p, k) => runOne(job.runs[i + k], p)));
        }
        job.status = 'done';
        job.passed = job.runs.length > 0 && job.runs.every((r) => r.status === 'done' && r.verdict !== 'fail');
        job.finished_at = new Date().toISOString();
        if (typeof onDone === 'function') onDone(job);   // still inside the account context
      });
    } catch (e) { job.status = 'error'; job.error = String(e.message).slice(0, 200); job.passed = false; job.finished_at = new Date().toISOString(); }
  })();
  return job;
}

/** Short notes on how the script held up. Never throws: a grader failure just yields no notes. */
async function grade(anthropic, settings, persona, history, reportUsage) {
  const script = ['prompt_qualification', 'prompt_booking', 'prompt_routing', 'prompt_hard_rules']
    .map((k) => (settings[k] ? `## ${k}\n${settings[k]}` : '')).filter(Boolean).join('\n\n').slice(0, 6000);
  const transcript = history.map((m) => `${m.role === 'lead' ? 'LEAD' : 'SETTER'}: ${m.text}`).join('\n').slice(0, 6000);
  try {
    const res = await anthropic.messages.create({
      model: GRADER_MODEL, max_tokens: 300,
      system: 'You review a short Instagram DM conversation where an AI setter followed the business owner\'s script. Reply with JSON only: {"verdict":"pass"|"warn"|"fail","notes":["…"]}. Up to 3 notes, each under 20 words, plain English, no praise. "fail" only for a clear breach of the hard rules or the qualification order, or for quoting a price the script says not to quote. An affordability question that repeats a range written in the script is NOT a price quote. "warn" for a missed step. Empty notes and "pass" when it followed the script.',
      messages: [{ role: 'user', content: `OWNER SCRIPT:\n${script || '(no script sections)'}\n\nLEAD PERSONA: ${persona.name} — ${persona.brief}\n\nCONVERSATION:\n${transcript}` }],
    });
    if (typeof reportUsage === 'function') reportUsage(GRADER_MODEL, res);
    const text = res.content.find((b) => b.type === 'text')?.text || '';
    const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    const verdict = ['pass', 'warn', 'fail'].includes(j.verdict) ? j.verdict : 'warn';
    return { verdict, notes: Array.isArray(j.notes) ? j.notes.map((n) => String(n).slice(0, 160)).slice(0, 3) : [] };
  } catch { return { verdict: 'warn', notes: [] }; }
}

export { PERSONAS };

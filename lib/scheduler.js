/**
 * Phase 4 — the automation layer that sits on top of the Phase 1-3 API.
 *
 * Everything time-driven or self-play lives here so server.js stays a thin
 * HTTP layer. The module is a FACTORY: server.js hands it the db helpers and
 * settings accessors it already owns (dependency injection), so the scheduler
 * never reaches into the database directly and is trivially testable.
 *
 * Three moving parts:
 *   A. Live simulator personas  — Claude roleplays the lead and replies to a
 *      setter message after a short delay (self-play), then feeds that lead
 *      message back through the normal inbound path.
 *   B. Autopilot / copilot turn — on every inbound lead message, generate the
 *      setter's move; autopilot auto-sends after a humanizing delay (with the
 *      max-2 / needs_human / call_booked-and-sale guardrails), copilot queues a draft.
 *   C. Follow-up sweep          — a 15s loop that nudges quiet leads in
 *      qualifying/qualified/booking_sent, escalates #1 → #2 → dead.
 *
 * FAST_TIMERS=1 collapses every delay to seconds and reinterprets the
 * follow-up 'hours' settings as seconds, so the redline suite runs in ~90s.
 */

import Anthropic from '@anthropic-ai/sdk';
import { generateMove, applyOutboundFilter } from './engine.js';
import { PERSONA_BY_ID, leadMove } from './personas.js';

const LEAD_MODEL = 'claude-sonnet-5'; // the persona (lead) roleplay model

const FAST = () => process.env.FAST_TIMERS === '1';

/** Random integer delay in ms, inclusive of both bounds (seconds → ms). */
const randDelayMs = (loSec, hiSec) =>
  Math.round((loSec + Math.random() * (hiSec - loSec)) * 1000);

// Timing knobs — real values, or the fast-test values under FAST_TIMERS.
const autopilotDelayMs = () => (FAST() ? randDelayMs(2, 4) : randDelayMs(60, 180));
const personaDelayMs = () => (FAST() ? randDelayMs(1, 2) : randDelayMs(3, 8));
const FOLLOWUP_SWEEP_MS = 15_000;

/**
 * Interpret a follow-up 'hours' setting. Real mode: hours. FAST_TIMERS: the
 * same number is read as SECONDS so tests set '2'/'3' and wait seconds.
 * @returns {number} milliseconds
 */
export function followupOffsetMs(hoursSetting) {
  const n = Number(hoursSetting);
  if (!Number.isFinite(n) || n <= 0) return FAST() ? 2_000 : 4 * 3_600_000;
  return FAST() ? n * 1000 : n * 3_600_000;
}

/** Terminal-ish stages a persona will never reply into. */
const PERSONA_SILENT_STAGES = new Set(['routed', 'dead', 'call_booked', 'sale']);

/**
 * Stages the engine may SUGGEST but that a human must confirm — autopilot sends
 * the messages, leaves the stage unchanged, and raises needs_human. Kept in
 * sync with server.js HUMAN_CONFIRM_STAGES; the module falls back to this set
 * when deps don't supply one (keeps the exported pure functions self-contained
 * for the unit test).
 */
const DEFAULT_HUMAN_CONFIRM_STAGES = new Set(['call_booked', 'sale']);
const isHumanConfirm = (stage, confirmSet) => (confirmSet || DEFAULT_HUMAN_CONFIRM_STAGES).has(stage);

/**
 * Decide what an autopilot move does to a conversation. PURE except for the
 * db writes it delegates to `deps` — no timers, no network, no engine call.
 * Structured as a standalone export so the call_booked/sale-requires-human
 * guardrail is unit-testable with a synthetic move (redline test #5).
 *
 * @param {object} move  { messages, stage, needs_human, reason } from the engine
 * @param {object} conv  the conversation row (as it was when the move was generated)
 * @param {object} deps  { setStage, setNeedsHuman, incrementAiSends, humanConfirmStages? }
 * @returns {{ action:'needs_human'|'limit'|'send', stage?:string, confirm?:boolean }}
 *   Describes what happened; the caller does the actual delivery for 'send'.
 *   For 'needs_human'/'limit' the caller stores a pending draft and does NOT send.
 */
export function decideAutopilotMove(move, conv, deps) {
  // 1. Engine flagged needs_human → hand off: no send, drop to copilot.
  if (move.needs_human) {
    deps.setNeedsHuman(conv.id, move.reason || 'needs_human', 'copilot');
    return { action: 'needs_human' };
  }
  // 2. Max-2 consecutive AI sends without a lead reply → queue, stay autopilot.
  if ((conv.consecutive_ai_sends || 0) >= 2) {
    return { action: 'limit' };
  }
  // 3. Clear to send. A call_booked/sale suggestion still SENDS (the human
  //    confirms the stage afterward) — flagged via `confirm`.
  return { action: 'send', stage: move.stage, confirm: isHumanConfirm(move.stage, deps.humanConfirmStages) };
}

/**
 * Apply the stage/counter side-effects AFTER an autopilot send has landed.
 * A call_booked/sale suggestion is special: the messages went out, but the
 * stage does NOT change (human confirms via PATCH) and the conversation is
 * flagged. booking_sent and all earlier stages auto-apply normally.
 * Exported alongside decideAutopilotMove for the same unit test.
 */
export function applyAutopilotSendEffects(move, conv, deps) {
  deps.incrementAiSends(conv.id);
  if (isHumanConfirm(move.stage, deps.humanConfirmStages)) {
    deps.setNeedsHuman(conv.id, 'booking confirmation required', null); // keep autopilot mode
    return { stage: conv.stage, confirm: true };
  }
  if (move.stage && move.stage !== conv.stage) deps.setStage(conv.id, move.stage);
  return { stage: move.stage, confirm: false };
}

/**
 * Build the scheduler. `deps` is the surface server.js exposes:
 *   getConv, getSettings, historyOf, addLeadMessage, deliver, storeDraft,
 *   setStage, setNeedsHuman, incrementAiSends, setFollowup, onLeadMessage,
 *   latestLeadMessageId, pendingDraftId
 * Each is a thin wrapper over the existing db so the scheduler owns no schema.
 */
export function createScheduler(deps) {
  let _anthropic = null;
  const anthropic = () => {
    if (!_anthropic && process.env.ANTHROPIC_API_KEY) _anthropic = new Anthropic({ maxRetries: 2, timeout: 60_000 });
    return _anthropic;
  };

  // One pending persona reply per conversation (loop guard).
  const pendingPersona = new Set();
  // Timers we own, so tests / shutdown can clear them.
  const timers = new Set();
  let sweepTimer = null;

  const track = (t) => { timers.add(t); return t; };
  const later = (fn, ms) => track(setTimeout(async () => { try { await fn(); } catch (e) { console.error('[sched]', e.message); } }, ms));

  // ---------------------------------------------------------------- personas
  /**
   * A setter message was just delivered on a sim conversation. If it has a
   * persona and it's the persona's turn, schedule the lead's reply.
   * Guards: last message must be from the setter, no reply already pending,
   * conversation not flagged needs_human, stage not routed/dead/call_booked/sale.
   */
  function onSetterDelivered(convId) {
    const conv = deps.getConv(convId);
    if (!conv || conv.channel !== 'sim' || !conv.persona) return;
    if (conv.needs_human) return;                       // human handles flagged threads
    if (PERSONA_SILENT_STAGES.has(conv.stage)) return;  // conversation is over
    if (pendingPersona.has(convId)) return;             // one reply in flight
    const persona = PERSONA_BY_ID.get(conv.persona);
    if (!persona) return;

    pendingPersona.add(convId);
    later(async () => {
      try {
        const fresh = deps.getConv(convId);
        // Re-check: the world may have moved while we waited.
        if (!fresh || fresh.needs_human || PERSONA_SILENT_STAGES.has(fresh.stage)) return;
        const history = deps.historyOf(convId);
        // The persona only replies to a setter message. If the last message is
        // already the lead's, there is nothing to answer (guards double-replies).
        if (!history.length || history[history.length - 1].role === 'lead') return;
        const a = anthropic();
        if (!a) return;
        const offer = deps.getSettings().prompt_offer || '';
        const text = await leadMove(a, LEAD_MODEL, offer, persona, history);
        if (!text) return; // persona chose to ghost
        deps.addLeadMessage(convId, text);   // stores role 'lead', source 'ai'
        deps.onLeadMessage(convId);          // reset counter, clear follow-up timer
        onInboundLead(convId);               // run the setter's autopilot/copilot turn
      } finally {
        pendingPersona.delete(convId);
      }
    }, personaDelayMs());
  }

  // ------------------------------------------------------------- inbound turn
  /**
   * Entry point for every inbound lead message (sim persona, sim manual, or IG).
   * copilot → generate a pending draft. autopilot → auto-send after a delay
   * (with guardrails). off → nothing.
   */
  function onInboundLead(convId) {
    const conv = deps.getConv(convId);
    if (!conv) return;
    if (deps.getSettings().kill_switch === '1') return; // global halt
    if (conv.needs_human) return;                       // already handed off
    if (conv.mode === 'off') return;
    if (conv.mode === 'copilot') { generateCopilotDraft(convId); return; }
    if (conv.mode === 'autopilot') { runAutopilotTurn(convId); return; }
  }

  /** Copilot: fill the queue with a pending draft so the owner doesn't click. */
  async function generateCopilotDraft(convId, opts = {}) {
    later(async () => {
      const conv = deps.getConv(convId);
      if (!conv || conv.mode !== 'copilot' || conv.needs_human) return;
      if (deps.getSettings().kill_switch === '1') return;
      const move = await generateMove(deps.getSettings(), conv, deps.historyOf(convId), opts);
      const messages = normalizeMessages(move);
      const reason = opts.followup ? `follow-up${move.needs_human ? ' — ' + (move.reason || '') : ''}` : (move.reason || '');
      deps.storeDraft(convId, messages, move.needs_human ? null : (move.stage || null), move.needs_human, reason);
      if (move.needs_human) deps.setNeedsHuman(convId, move.reason || 'needs_human', 'copilot');
    }, 0);
  }

  /** Autopilot: generate, guardrail, then (maybe) send after a humanizing delay. */
  async function runAutopilotTurn(convId) {
    const conv = deps.getConv(convId);
    if (!conv) return;
    const move = await generateMove(deps.getSettings(), conv, deps.historyOf(convId));
    const messages = normalizeMessages(move);
    const decision = decideAutopilotMove(move, conv, autopilotDeps());

    if (decision.action === 'needs_human') {
      deps.storeDraft(convId, messages, null, true, move.reason || 'needs_human');
      return; // setNeedsHuman + drop-to-copilot already applied by decideAutopilotMove
    }
    if (decision.action === 'limit') {
      deps.storeDraft(convId, messages, move.stage || null, false, 'autopilot limit reached');
      return;
    }

    // action 'send': snapshot what we're answering, wait, re-check, deliver.
    const answeringLeadId = deps.latestLeadMessageId(convId);
    later(() => finishAutopilotSend(convId, move, messages, answeringLeadId, 'ai'), autopilotDelayMs());
  }

  /**
   * The delayed tail of an autopilot send. Re-validates that the world hasn't
   * changed (mode still autopilot, not flagged, no newer draft, the same lead
   * message is still the latest unanswered one), then delivers.
   */
  async function finishAutopilotSend(convId, move, messages, answeringLeadId, source) {
    const conv = deps.getConv(convId);
    if (!conv) return;
    if (conv.mode !== 'autopilot') return;                 // switched to copilot/off mid-delay
    if (conv.needs_human) return;                          // flagged mid-delay
    if (deps.getSettings().kill_switch === '1') return;    // killed mid-delay
    // A newer lead message arrived → this move is stale, a fresh turn owns it.
    if (source === 'ai' && deps.latestLeadMessageId(convId) !== answeringLeadId) return;

    // Deliver every message through the outbound filter. A block flips to
    // copilot with the draft preserved (deliver() already flags needs_human).
    for (const m of messages) {
      const out = await deps.deliver(conv, m, source);
      if (!out.ok) {
        deps.storeDraft(convId, messages, move.stage || null, true, out.reason || 'outbound_filter');
        deps.setMode(convId, 'copilot');
        return;
      }
    }
    applyAutopilotSendEffects(move, conv, autopilotDeps());
    // Note: deps.deliver() already scheduled the persona's reply (single source
    // of truth: every successful setter send on a sim conv triggers it).
  }

  /** deps subset decideAutopilotMove / applyAutopilotSendEffects need. */
  function autopilotDeps() {
    return {
      setStage: deps.setStage,
      incrementAiSends: deps.incrementAiSends,
      humanConfirmStages: deps.humanConfirmStages || DEFAULT_HUMAN_CONFIRM_STAGES,
      setNeedsHuman: (id, reason, mode) => {
        deps.setNeedsHuman(id, reason);
        if (mode) deps.setMode(id, mode);
      },
    };
  }

  // -------------------------------------------------------------- follow-ups
  /**
   * Sweep every 15s. For each conversation in qualifying/qualified/booking_sent that is not
   * flagged, mode != off, whose LAST message is from the setter and whose lead
   * has been quiet past the due threshold: generate follow-up #1, then #2, then
   * move to 'dead'. followup_count drives which step is due.
   */
  async function followupSweep() {
    const s = deps.getSettings();
    if (s.kill_switch === '1') return;
    const due = deps.followupCandidates(); // rows already filtered by SQL
    for (const conv of due) {
      const history = deps.historyOf(conv.id);
      if (!history.length || history[history.length - 1].role !== 'setter') continue;
      const lastAt = new Date(conv.last_message_at || conv.created_at).getTime();
      const count = conv.followup_count || 0;

      if (count >= 2) { deps.setStage(conv.id, 'dead'); continue; } // exhausted → dead

      const offsetMs = followupOffsetMs(count === 0 ? s.followup_1_hours : s.followup_2_hours);
      if (Date.now() < lastAt + offsetMs) continue; // not due yet
      await generateFollowup(conv, count + 1); // #1 or #2
    }
  }

  /** Generate + deliver (autopilot) or queue (copilot) a follow-up. Bumps count. */
  async function generateFollowup(conv, n) {
    const fresh = deps.getConv(conv.id);
    if (!fresh || fresh.needs_human || fresh.mode === 'off') return;
    if (!['qualifying', 'qualified', 'booking_sent'].includes(fresh.stage)) return;
    // Bump the count + schedule the NEXT due time up front so the sweep won't
    // re-fire this same follow-up while the engine call is in flight.
    const s = deps.getSettings();
    const nextOffset = n >= 2 ? null : followupOffsetMs(s.followup_2_hours);
    deps.setFollowup(conv.id, n, nextOffset ? new Date(Date.now() + nextOffset).toISOString() : null);

    const move = await generateMove(s, fresh, deps.historyOf(conv.id), { followup: n });
    const messages = normalizeMessages(move);

    if (fresh.mode === 'copilot') {
      const reason = `follow-up #${n}${move.needs_human ? ' — ' + (move.reason || '') : ''}`;
      deps.storeDraft(conv.id, messages, move.needs_human ? null : (move.stage || null), move.needs_human, reason);
      if (move.needs_human) deps.setNeedsHuman(conv.id, move.reason || 'needs_human', 'copilot');
      return;
    }
    // autopilot follow-up: send directly (source 'followup'), same guardrails.
    if (fresh.mode === 'autopilot') {
      const decision = decideAutopilotMove(move, fresh, autopilotDeps());
      if (decision.action === 'needs_human') {
        deps.storeDraft(conv.id, messages, null, true, `follow-up #${n} — ${move.reason || 'needs_human'}`);
        return;
      }
      if (decision.action === 'limit') {
        deps.storeDraft(conv.id, messages, move.stage || null, false, `follow-up #${n} — autopilot limit reached`);
        return;
      }
      // send now (no humanizing delay needed — the lead is already quiet)
      await finishAutopilotSend(conv.id, move, messages, null, 'followup');
    }
  }

  // ---------------------------------------------------------------- plumbing
  function normalizeMessages(move) {
    return (Array.isArray(move?.messages) && move.messages.length)
      ? move.messages.slice(0, 2).map((m) => String(m)) : [''];
  }

  function start() {
    if (sweepTimer) return;
    sweepTimer = setInterval(() => { followupSweep().catch((e) => console.error('[sweep]', e.message)); }, FOLLOWUP_SWEEP_MS);
    if (sweepTimer.unref) sweepTimer.unref();
  }

  function stop() {
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
    for (const t of timers) clearTimeout(t);
    timers.clear();
    pendingPersona.clear();
  }

  return { start, stop, onInboundLead, onSetterDelivered, generateCopilotDraft, followupSweep };
}

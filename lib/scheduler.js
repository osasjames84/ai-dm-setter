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
 *      qualifying/qualified/booking_sent, escalates #1 → #2 then lets the thread
 *      go dormant (never auto-marks 'dead' — dead means the lead explicitly said no).
 *
 * FAST_TIMERS=1 collapses every delay to seconds and reinterprets the
 * follow-up 'hours' settings as seconds, so the redline suite runs in ~90s.
 */

import Anthropic from '@anthropic-ai/sdk';
import { generateMove, applyOutboundFilter } from './engine.js';
import { PERSONA_BY_ID, leadMove } from './personas.js';
import { matchKeyword, selectFlagMessage } from './triggers.js';

const LEAD_MODEL = 'claude-sonnet-5'; // the persona (lead) roleplay model

const FAST = () => process.env.FAST_TIMERS === '1';

/** Random integer delay in ms, inclusive of both bounds (seconds → ms). */
const randDelayMs = (loSec, hiSec) =>
  Math.round((loSec + Math.random() * (hiSec - loSec)) * 1000);

// Timing knobs — real values, or the fast-test values under FAST_TIMERS.
// The autopilot delay reads the owner's Settings › Autopilot › Response Time
// (response_min/response_max, seconds; falls back to 10-30). It was hardcoded
// 60-180s for months, silently ignoring the setting. It is a TOTAL
// time-to-send target: runAutopilotTurn subtracts the time generation already
// took (and the typing-indicator lead-in), so replies land inside the window
// whenever the model is fast enough, instead of stacking delay on top.
const autopilotDelayMs = (s) => {
  if (FAST()) return randDelayMs(2, 4);
  let min = Number(s && s.response_min), max = Number(s && s.response_max);
  if (!Number.isFinite(min) || min < 0) min = 10;
  if (!Number.isFinite(max) || max < min) max = Math.max(30, min);
  return randDelayMs(min, max);
};
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

/**
 * The AI follow-up ladder from settings: [#1, #2, #3, #4] hour-delays, each
 * counted from the PREVIOUS message. All blank by default (no AI follow-ups
 * until the owner sets timings). A blank/0/invalid step disables that step
 * AND every step after it, so the owner shortens the ladder by clearing a box.
 * @returns {string[]} hour settings, in firing order (possibly empty)
 */
export function followupLadder(s) {
  const ladder = [];
  for (const v of [s.followup_1_hours, s.followup_2_hours, s.followup_3_hours, s.followup_4_hours]) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) break;
    ladder.push(v);
  }
  return ladder;
}

const UNIT_MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };
/** Stable 0..1 pseudo-random from a string key (so a step's random delay/variant
 *  doesn't jitter across 15s sweeps — same conversation+step → same value). */
export function seededUnit(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}
/** Normalize a stored follow-up step (old {delay_hours,message} or new shape) to
 *  { kind, variants[], audio_id, delay_min, delay_max, unit }. */
export function normalizeStep(x) {
  x = x || {};
  const kind = x.kind === 'audio' ? 'audio' : 'text';
  let message = x.message != null ? String(x.message)
    : (Array.isArray(x.variants) && x.variants[0] != null ? String(x.variants[0]) : '');
  message = message.trim();
  const unit = ['minutes', 'hours', 'days'].includes(x.unit) ? x.unit : 'hours';
  let dmin = Number(x.delay_min); if (!Number.isFinite(dmin)) dmin = Number(x.delay_hours);
  let dmax = Number(x.delay_max); if (!Number.isFinite(dmax)) dmax = dmin;
  if (!Number.isFinite(dmin)) dmin = 0;
  if (!Number.isFinite(dmax) || dmax < dmin) dmax = dmin;
  return { kind, message, variation: !!x.variation, audio_id: String(x.audio_id || '').trim(), delay_min: dmin, delay_max: dmax, unit };
}
export const stepHasContent = (st) => !!st && (st.kind === 'audio' ? !!st.audio_id : !!st.message);
/** Due offset for a step: a stable-random time within [min,max]*unit (FAST → seconds). */
export function stepOffsetMs(st, seedKey) {
  if (FAST()) return Math.round((st.delay_min || 1) * 1000) || 1000;
  const unit = UNIT_MS[st.unit] || UNIT_MS.hours;
  const lo = Math.max(0, st.delay_min), hi = Math.max(lo, st.delay_max);
  const amount = lo === hi ? lo : lo + seededUnit(String(seedKey)) * (hi - lo);
  return Math.max(1000, amount * unit);
}
/** The lead's first name from display_name (blank when we only have the raw handle). */
export function firstNameOf(conv) {
  const dn = String((conv && conv.display_name) || '').trim();
  const handle = String((conv && conv.handle) || '').toLowerCase();
  if (!dn || dn.toLowerCase() === handle) return '';
  const first = dn.split(/\s+/)[0];
  return /^[A-Za-z][A-Za-z'’-]*$/.test(first) ? first.charAt(0).toUpperCase() + first.slice(1) : '';
}
/** Replace {{FIRST_NAME}} with the lead's name, or strip it + tidy leftover spacing. */
export function interpolateName(text, conv) {
  const name = firstNameOf(conv);
  const tag = /\{\{\s*FIRST_NAME\s*\}\}/gi;
  if (name) return String(text).replace(tag, name);
  return String(text).replace(tag, '').replace(/\s{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1').trim();
}

/**
 * Instagram 24-hour messaging window (FEATURE 1). Meta only allows a business to
 * message a lead within 24h of the lead's LAST message. SCHEDULED sends (Core
 * Sequence steps, legacy follow-ups) can fire outside that window — IG rejects
 * them and repeated attempts risk the account. Inbound replies are inherently
 * within-window so they're never guarded.
 *   true  → safe to send now.
 *   false → outside the window (or unknown: last_lead_message_at null on
 *           historical synced convs → treat as OUTSIDE, park a manual draft).
 * FAST_TIMERS always returns true so the redline suite stays meaningful.
 */
const WINDOW_REASON = 'outside 24h window — send manually';
export function withinMessagingWindow(conv) {
  if (FAST()) return true;
  const at = conv && conv.last_lead_message_at;
  if (!at) return false; // never heard from the lead (or pre-window historical sync)
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t < 24 * 3600 * 1000;
}

/** Terminal-ish stages a persona will never reply into. */
const PERSONA_SILENT_STAGES = new Set(['routed', 'dead', 'call_booked', 'sale']);

// How long after the call start with no lead message before we treat it as a no-show.
const NOSHOW_GRACE_MS = 30 * 60 * 1000;

/** Normalize a stored booking reminder to { hours_before:Number>0, message:String }; null when unusable. */
export function normalizeReminder(x) {
  x = x || {};
  const h = Number(x.hours_before);
  const message = String(x.message == null ? '' : x.message).trim();
  if (!Number.isFinite(h) || h <= 0 || !message) return null;
  return { hours_before: h, message };
}

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
 * @param {object} [opts] { skipConsecutiveLimit? } — scheduled follow-ups set this so
 *   the max-2 ceiling (meant for back-to-back INBOUND replies) doesn't block them.
 * @returns {{ action:'needs_human'|'limit'|'send', stage?:string, confirm?:boolean }}
 *   Describes what happened; the caller does the actual delivery for 'send'.
 *   For 'needs_human'/'limit' the caller stores a pending draft and does NOT send.
 */
export function decideAutopilotMove(move, conv, deps, opts = {}) {
  // 1. Engine flagged needs_human → hand off: no send, drop to copilot.
  if (move.needs_human) {
    deps.setNeedsHuman(conv.id, move.reason || 'needs_human', 'copilot');
    return { action: 'needs_human' };
  }
  // 2. Max-2 consecutive AI sends without a lead reply → queue, stay autopilot.
  //    Scheduled follow-ups are EXEMPT (like Core Sequence steps): the reply→#1→#2
  //    cadence would otherwise trip the ceiling and never send follow-up #2.
  if (!opts.skipConsecutiveLimit && (conv.consecutive_ai_sends || 0) >= 2) {
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
 *   latestLeadMessageId, pendingDraftId, notify
 * Each is a thin wrapper over the existing db so the scheduler owns no schema
 * (the scheduler still never touches the db).
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
  /**
   * Story/Reel Keyword Trigger. If the latest lead message matches a configured
   * keyword and this conversation hasn't triggered before, send the exact Initial
   * Message (not AI-generated), flip the chat to autopilot, and own this turn.
   * Returns true when it fired (caller stops — the initial message IS the reply).
   */
  const pendingKw = new Set(); // convs with a keyword opener scheduled (in-memory)
  function maybeFireKeywordTrigger(convId, conv) {
    if (conv.kw_triggered || pendingKw.has(convId)) return false;
    const s = deps.getSettings();
    let kt; try { kt = JSON.parse(s.keyword_trigger || '{}'); } catch { kt = {}; }
    const initial = String(kt.initial_message || '').trim();
    if (!kt.keywords || !initial) return false;
    const text = deps.latestLeadText ? deps.latestLeadText(convId) : '';
    if (!matchKeyword(text, kt.keywords)) return false;

    // The once-only mark and the autopilot flip happen WHEN the opener sends,
    // not before: a restart mid-delay used to leave the thread marked+autopilot
    // with the exact opener never sent (the boot rescue then improvised an AI
    // reply). Now a restart simply re-runs this path and sends the opener.
    pendingKw.add(convId);
    later(async () => {
      try {
        const fresh = deps.getConv(convId);
        if (!fresh || fresh.needs_human || fresh.kw_triggered || deps.getSettings().kill_switch === '1') return;
        deps.markKwTriggered(convId);      // once-only guard
        deps.setMode(convId, 'autopilot'); // keyword hands the chat to the AI
        await deps.deliver(fresh, initial, 'ai'); // exact message, not AI-generated
      } finally { pendingKw.delete(convId); }
    }, keywordDelayMs(kt));
    return true;
  }

  /** Random wait before the keyword initial reply; falls back to autopilot Response Time. */
  function keywordDelayMs(kt) {
    const min = Number(kt.delay_min), max = Number(kt.delay_max);
    if (Number.isFinite(min) && Number.isFinite(max) && min >= 0 && max >= min && max > 0) {
      return FAST() ? randDelayMs(1, 2) : randDelayMs(min, max);
    }
    return autopilotDelayMs(deps.getSettings());
  }

  // Leads often send 2-3 messages in a burst. Debounce the turn per
  // conversation so ONE generation answers the whole burst instead of one per
  // message (the extra generations were billed and then discarded on delivery).
  const INBOUND_DEBOUNCE_MS = () => (FAST() ? 0 : 2500);
  const pendingTurns = new Map(); // convId → timer
  function onInboundLead(convId) {
    const prev = pendingTurns.get(convId);
    if (prev) { clearTimeout(prev); timers.delete(prev); }
    const t = later(() => { pendingTurns.delete(convId); runInboundLead(convId); }, INBOUND_DEBOUNCE_MS());
    pendingTurns.set(convId, t);
  }
  function runInboundLead(convId) {
    const conv = deps.getConv(convId);
    if (!conv) return;
    if (deps.getSettings().kill_switch === '1') return; // global halt
    if (conv.needs_human) return;                       // already handed off
    // dead = the owner moved on. NEVER reply or draft, regardless of mode — legacy
    // dead convs predate the dead→mode-off rule and may still carry autopilot.
    if (conv.stage === 'dead') return;
    // Keyword trigger runs BEFORE the mode-off gate: with default_mode 'off'
    // (AI opt-in per thread), a fresh lead DMing the keyword is the owner's
    // configured opt-in — it must wake the thread, send his exact opener, and
    // flip autopilot. Everything else on an 'off' thread stays silent.
    if (maybeFireKeywordTrigger(convId, conv)) return;  // keyword → exact reply + autopilot
    if (conv.mode === 'off') return;
    if (conv.mode === 'copilot') { generateCopilotDraft(convId); return; }
    if (conv.mode === 'autopilot') { runAutopilotTurn(convId); return; }
  }

  /** Copilot: fill the queue with a pending draft so the owner doesn't click. */
  async function generateCopilotDraft(convId, opts = {}) {
    later(async () => {
      try {
        const conv = deps.getConv(convId);
        if (!conv || conv.mode !== 'copilot' || conv.needs_human) return;
        if (deps.getSettings().kill_switch === '1') return;
        const move = await generateMove(deps.getSettings(), conv, deps.historyOf(convId), opts);
        const messages = normalizeMessages(move);
        const reason = opts.followup ? `follow-up${move.needs_human ? ' — ' + (move.reason || '') : ''}` : (move.reason || '');
        deps.storeDraft(convId, messages, move.needs_human ? null : (move.stage || null), move.needs_human, reason);
        if (move.needs_human) deps.setNeedsHuman(convId, move.reason || 'needs_human', 'copilot');
      } catch (e) {
        // A Claude timeout here used to vanish: no draft, no flag, no email — the
        // lead waited for the next redeploy. Surface it like the autopilot path.
        console.error('[copilot] draft failed:', e.message);
        try { deps.storeDraft(convId, [''], null, true, 'copilot error: ' + e.message); deps.setNeedsHuman(convId, 'copilot error: ' + e.message); } catch { /* best-effort */ }
      }
    }, 0);
  }

  /** Send the owner's Flag Handling final message (per-reason or fallback) if enabled. Returns true if sent. */
  async function maybeSendFlagMessage(conv, move) {
    const msg = selectFlagMessage(deps.getSettings(), move.flag_reason_code);
    if (!msg) return false;
    await deps.deliver(conv, msg, 'ai');
    return true;
  }

  /** Autopilot: generate, guardrail, then (maybe) send after a humanizing delay. */
  async function runAutopilotTurn(convId) {
    // Fire-and-forget from onInboundLead — an Anthropic/IG error in here must not
    // become an unhandled rejection (crashes Node 23). Catch, log, and surface the
    // lead in Needs Review via a flagged draft instead of letting it vanish.
    try {
      const conv = deps.getConv(convId);
      if (!conv) return;
      // The Response Time window counts from NOW (the lead's message), not from
      // when generation finishes — generation time spends the same budget.
      const turnStart = Date.now();
      // Snapshot the lead message we're answering BEFORE generation. A newer lead
      // message that arrives while generateMove is in flight then invalidates this
      // turn at delivery time (finishAutopilotSend re-checks), preventing double-replies.
      const answeringLeadId = deps.latestLeadMessageId(convId);
      const move = await generateMove(deps.getSettings(), conv, deps.historyOf(convId));
      const messages = normalizeMessages(move);
      // Flag Handling: if the engine is flagging/disqualifying and the owner enabled
      // "send final message before flagging", send their closer BEFORE handing off.
      const flagSent = move.needs_human ? await maybeSendFlagMessage(conv, move) : false;
      const decision = decideAutopilotMove(move, conv, autopilotDeps());

      if (decision.action === 'needs_human') {
        if (!flagSent) deps.storeDraft(convId, messages, null, true, move.reason || 'needs_human');
        return; // setNeedsHuman + drop-to-copilot already applied by decideAutopilotMove
      }
      if (decision.action === 'limit') {
        deps.storeDraft(convId, messages, move.stage || null, false, 'autopilot limit reached');
        return;
      }

      // action 'send': wait out whatever is LEFT of the Response Time window
      // (generation already spent part of it; the typing-indicator lead-in in
      // deliver() spends up to 8s more, so it's budgeted too), re-check the
      // snapshot, deliver. If generation overran the window, send immediately.
      const s = deps.getSettings();
      const typingMs = (s.typing_indicator === '1' && conv.channel === 'instagram')
        ? Math.min(1000 + String(messages[0] || '').length * 45, 8000) : 0;
      const remaining = Math.max(0, autopilotDelayMs(s) - (Date.now() - turnStart) - typingMs);
      later(() => finishAutopilotSend(convId, move, messages, answeringLeadId, 'ai'), remaining);
    } catch (e) {
      console.error('[autopilot] turn failed:', e.message);
      try { deps.storeDraft(convId, [''], null, true, 'autopilot error: ' + e.message); } catch { /* best-effort surface */ }
    }
  }

  /**
   * The delayed tail of an autopilot send. Re-validates that the world hasn't
   * changed (mode still autopilot, not flagged, no newer draft, the same lead
   * message is still the latest unanswered one), then delivers.
   */
  async function finishAutopilotSend(convId, move, messages, answeringLeadId, source) {
    try { await finishAutopilotSendInner(convId, move, messages, answeringLeadId, source); }
    catch (e) {
      // An IG send that THREW mid-delay used to be logged and forgotten. Park the
      // composed reply as a flagged draft so the owner sees it and can send it.
      console.error('[autopilot] delayed send failed:', e.message);
      try {
        deps.storeDraft(convId, messages, move.stage || null, true, 'send failed: ' + e.message);
        deps.setNeedsHuman(convId, 'send failed: ' + e.message);
        // Mode is left alone: a dead Instagram token used to drop every thread
        // to copilot, so fixing the token still left the AI switched off on all
        // of them. The flag is enough — clearing it resumes autopilot.
      } catch { /* best-effort */ }
    }
  }
  async function finishAutopilotSendInner(convId, move, messages, answeringLeadId, source) {
    const conv = deps.getConv(convId);
    if (!conv) return;
    if (conv.mode !== 'autopilot') return;                 // switched to copilot/off mid-delay
    if (conv.needs_human) return;                          // flagged mid-delay
    if (deps.getSettings().kill_switch === '1') return;    // killed mid-delay
    // A newer lead message arrived → this move is stale, a fresh turn owns it.
    if (source === 'ai' && deps.latestLeadMessageId(convId) !== answeringLeadId) return;

    // Deliver every message through the outbound filter. A block flips to
    // copilot with the draft preserved (deliver() already flags needs_human).
    // Guard: never send a line identical to the one just sent — catches a
    // duplicated bubble or a double-fired turn producing the same text.
    const lastSetter = deps.historyOf(convId).filter((h) => h.role === 'setter').slice(-1)[0];
    let prevText = lastSetter ? String(lastSetter.text || '').trim().toLowerCase() : '';
    for (const m of messages) {
      const t = String(m).trim().toLowerCase();
      if (t && t === prevText) continue;                   // skip a repeat of the immediately-previous send
      const out = await deps.deliver(conv, m, source);
      if (!out.ok) {
        deps.storeDraft(convId, messages, move.stage || null, true, out.reason || 'outbound_filter');
        deps.setMode(convId, 'copilot');
        return;
      }
      prevText = t;
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
   * Which owner-configured Core Sequence applies to a stage. Returns the cleaned
   * step list ([{delay_hours, message}]) or [] when none is set (→ legacy AI nudge).
   */
  function sequenceForStage(s, stage) {
    const key = stage === 'booking_sent' ? 'seq_booking'
      : (stage === 'qualifying' || stage === 'qualified') ? 'seq_qualification'
      : (stage === 'lead' || stage === 'engaged') ? 'seq_lead' : null;
    if (!key) return [];
    let arr; try { arr = JSON.parse(s[key] || '[]'); } catch { arr = []; }
    return Array.isArray(arr) ? arr.map(normalizeStep).filter(stepHasContent) : [];
  }

  /** Send one EXACT configured sequence step (autopilot) or queue it (copilot). Bumps count. */
  async function sendSequenceStep(conv, count, seq) {
    // Advance the step counter only AFTER a successful delivery — advancing up front
    // permanently skips the step (no retry) if the IG send throws. On failure we leave
    // the counter untouched and flag so it surfaces instead of silently dying.
    const advance = () => {
      const next = seq[count + 1];
      const nextAt = next ? new Date(Date.now() + stepOffsetMs(next, conv.id + ':' + (count + 1))).toISOString() : null;
      deps.setFollowup(conv.id, count + 1, nextAt);
    };
    // deliver/deliverVoiceNote also fail by RETURNING {ok:false} (outbound-filter block,
    // missing clip, IG audio error) without throwing — treat that exactly like the catch
    // path: no advance, flag out of the sweep's candidate set so it can't loop-retry.
    const blocked = (reason) => {
      console.error('[sequence] step blocked:', reason || 'unknown');
      deps.setNeedsHuman(conv.id, 'send failed: ' + (reason || 'unknown'));
      deps.setMode(conv.id, 'copilot');
    };
    try {
      const fresh = deps.getConv(conv.id);
      if (!fresh || fresh.needs_human || fresh.mode === 'off') return;
      const step = seq[count];
      if (step.kind === 'audio') {
        if (fresh.mode === 'copilot') { advance(); deps.storeDraft(conv.id, ['[voice note]'], null, false, `sequence follow-up #${count + 1} (voice note)`); return; }
        if (fresh.mode === 'autopilot' && deps.deliverVoiceNote) {
          // 24h window: outside it IG rejects the send. Park a manual draft, CONSUME
          // the step (advance so the sweep doesn't retry every 15s), and notify.
          if (!withinMessagingWindow(fresh)) {
            advance();
            deps.storeDraft(conv.id, ['[voice note]'], null, false, WINDOW_REASON);
            deps.notify && deps.notify('Follow-up needs manual send', `${fresh.handle}: sequence follow-up #${count + 1} (voice note) — ${WINDOW_REASON}`);
            return;
          }
          const out = await deps.deliverVoiceNote(fresh, step.audio_id, 'followup');
          if (!out || !out.ok) { blocked(out && out.reason); return; }
        }
        advance();
        return;
      }
      let msg = interpolateName(step.message, fresh);
      if (step.variation && deps.varyMessage) { try { msg = (await deps.varyMessage(msg)) || msg; } catch { /* keep original on any error */ } }
      if (!msg) return; // nothing to send → do NOT advance
      if (fresh.mode === 'copilot') { advance(); deps.storeDraft(conv.id, [msg], null, false, `sequence follow-up #${count + 1}`); return; }
      if (fresh.mode === 'autopilot') {
        // 24h window guard (see above) — park the composed message as a manual draft.
        if (!withinMessagingWindow(fresh)) {
          advance();
          deps.storeDraft(conv.id, [msg], null, false, WINDOW_REASON);
          deps.notify && deps.notify('Follow-up needs manual send', `${fresh.handle}: sequence follow-up #${count + 1} — ${WINDOW_REASON}`);
          return;
        }
        const out = await deps.deliver(fresh, msg, 'followup');
        if (!out || !out.ok) { blocked(out && out.reason); return; }
        advance();
      }
    } catch (e) {
      // Send THREW (IG API error) — counter NOT advanced, flag for a human.
      console.error('[sequence] step failed:', e.message);
      deps.setNeedsHuman(conv.id, 'send failed: ' + e.message);
      deps.setMode(conv.id, 'copilot');
    }
  }

  /**
   * Sweep every 15s. For each candidate whose LAST message is from the setter and
   * whose lead has been quiet past the due threshold: if the owner configured a
   * Core Sequence for that stage, send the exact step[count] at step.delay_hours
   * (then let the thread go dormant when exhausted); otherwise fall back to the
   * AI follow-up ladder (#1, #2, then long-game #3/#4 days later, then dormant)
   * for qualifying/qualified/booking_sent
   * only. The sweep NEVER marks a conversation 'dead' — dead means the lead
   * explicitly said no; an exhausted sequence just stops nudging (the count gate).
   */
  async function followupSweep() {
    const s = deps.getSettings();
    if (s.kill_switch === '1') return;
    const due = deps.followupCandidates(); // rows already filtered by SQL
    for (const conv of due) {
      // Only the newest message's role matters here; loading whole histories for
      // hundreds of threads every 15s was the sweep's biggest cost.
      const role = deps.lastRole ? deps.lastRole(conv.id)
        : (deps.historyOf(conv.id).slice(-1)[0] || {}).role;
      if (role !== 'setter') continue;
      const lastAt = new Date(conv.last_message_at || conv.created_at).getTime();
      const count = conv.followup_count || 0;
      const seq = sequenceForStage(s, conv.stage);

      if (seq.length) {
        if (count >= seq.length) continue; // sequence done — go dormant, never auto-mark dead
        if (Date.now() < lastAt + stepOffsetMs(seq[count], conv.id + ':' + count)) continue; // not due
        await sendSequenceStep(conv, count, seq);
      } else {
        // AI follow-up ladder (owner-set timings; content comes from the owner's
        // Follow-up Instructions) — only qualifying/qualified/booking_sent get one.
        if (!['qualifying', 'qualified', 'booking_sent'].includes(conv.stage)) continue;
        const ladder = followupLadder(s);
        if (count >= ladder.length) continue; // exhausted → go dormant, never auto-mark dead
        const offsetMs = followupOffsetMs(ladder[count]);
        if (Date.now() < lastAt + offsetMs) continue; // not due yet
        await generateFollowup(conv, count + 1);
      }
    }
  }

  // ---------------------------------------------------------- booking loop
  /**
   * Interpolate {{FIRST_NAME}} + {{CALENDLY}}, then either deliver (inside the 24h
   * window) or park a manual draft with the Wave-2 reason (outside it). Returns a
   * status string the caller keys off:
   *   'sent'   — delivered ok. Mark the reminder consumed.
   *   'parked' — outside the window: draft stored + notify fired ONCE. The caller
   *              must ALSO mark the reminder consumed — the parked draft IS the
   *              reminder (the owner sends it manually); leaving it unmarked would
   *              re-park a duplicate draft + notify every 15s tick.
   *   'failed' — deliver threw or returned {ok:false}. Mirrors sendSequenceStep's
   *              blocked() treatment: flag needs_human + drop to copilot, which
   *              removes the conv from bookedConvs (needs_human = 0 filter) so a
   *              hard IG failure can't hammer the API every 15s. Caller does NOT
   *              mark — the flag already stops the loop.
   * `label` describes the message for the parked-draft notify.
   */
  async function deliverBookingMessage(conv, rawMsg, calendarLink, label) {
    const failed = (reason) => {
      console.error('[booking] send failed:', reason || 'unknown');
      deps.setNeedsHuman(conv.id, 'send failed: ' + (reason || 'unknown'));
      deps.setMode(conv.id, 'copilot');
      return 'failed';
    };
    let msg = interpolateName(rawMsg, conv).replace(/\{\{\s*CALENDLY\s*\}\}/gi, String(calendarLink || '')).trim();
    if (!msg) return 'failed'; // nothing to send (empty setting) — no flag, harmless no-op re-check
    if (!withinMessagingWindow(conv)) {
      deps.storeDraft(conv.id, [msg], null, false, WINDOW_REASON);
      deps.notify && deps.notify('Booking message needs manual send', `${conv.handle}: ${label} — ${WINDOW_REASON}`);
      return 'parked';
    }
    try {
      const out = await deps.deliver(conv, msg, 'followup');
      if (!out || !out.ok) return failed(out && out.reason);
      return 'sent';
    } catch (e) {
      return failed(e.message);
    }
  }

  /**
   * Booking sweep — pre-call reminders + no-show detection for call_booked convs.
   * Runs inside the 15s tick alongside the follow-up sweep. Skipped entirely under
   * FAST_TIMERS (the redline suite never exercises real call_time math). Each conv
   * is fully try/catch-wrapped so one bad row can't kill the tick.
   */
  async function bookingSweep() {
    if (FAST()) return;                          // deterministic redline suite: no booking timers
    const s = deps.getSettings();
    if (s.kill_switch === '1') return;
    if (!deps.bookedConvs) return;               // dep not wired → dormant
    const calendarLink = s.calendar_link || '';
    let reminders = [];
    try { reminders = JSON.parse(s.booking_reminders || '[]'); } catch { reminders = []; }
    reminders = (Array.isArray(reminders) ? reminders : []).map(normalizeReminder).filter(Boolean);
    const now = Date.now();

    for (const conv of deps.bookedConvs()) {
      try {
        const callAt = Date.parse(conv.call_time);
        if (!Number.isFinite(callAt)) continue;  // no / bad call_time → nothing to schedule
        let sent; try { sent = JSON.parse(conv.reminders_sent || '[]'); } catch { sent = []; }
        if (!Array.isArray(sent)) sent = [];

        // Pre-call reminders: due once the lead time is reached, before the call starts.
        let rowFailed = false;
        for (const r of reminders) {
          const key = r.hours_before;
          if (sent.includes(key)) continue;
          if (now < callAt - r.hours_before * 3600e3) continue; // not yet in the reminder window
          if (now >= callAt) continue;                          // call already started → skip stale reminder
          const status = await deliverBookingMessage(conv, r.message, calendarLink, `reminder ${r.hours_before}h before`);
          // 'sent' AND 'parked' both consume the reminder — a parked draft is the
          // reminder, handed to the owner to send manually; without marking it the
          // sweep would re-park a duplicate + re-notify every 15s. 'failed' is NOT
          // marked: deliverBookingMessage already flagged needs_human, which drops
          // the conv out of bookedConvs and stops the loop.
          if (status === 'sent' || status === 'parked') deps.markReminderSent(conv.id, key);
          if (status === 'failed') { rowFailed = true; break; } // flagged — stop touching this conv
        }
        if (rowFailed) continue;

        // No-show: >30min past the call start, still call_booked, lead never spoke since call_time.
        if (now > callAt + NOSHOW_GRACE_MS && !sent.includes('noshow')) {
          if (deps.leadSpokeSince && deps.leadSpokeSince(conv.id, conv.call_time)) continue; // they showed / replied
          const status = await deliverBookingMessage(conv, s.noshow_message || '', calendarLink, 'no-show follow-up');
          // Same contract as above: 'parked' consumes it too (the parked path already
          // notified inside deliverBookingMessage); the extra no-show notify fires
          // only on a real send.
          if (status === 'sent' || status === 'parked') deps.markReminderSent(conv.id, 'noshow');
          if (status === 'sent') deps.notify && deps.notify('Possible no-show', `${conv.handle} did not appear to show for their call.`);
        }
      } catch (e) { console.error('[booking] sweep row failed:', e.message); }
    }
  }

  /** Generate + deliver (autopilot) or queue (copilot) a follow-up. Bumps count. */
  async function generateFollowup(conv, n) {
    // Wrap the whole turn: an Anthropic/IG error here is fire-and-forget from the
    // sweep and must not become an unhandled rejection.
    try {
      const fresh = deps.getConv(conv.id);
      if (!fresh || fresh.needs_human || fresh.mode === 'off') return;
      if (!['qualifying', 'qualified', 'booking_sent'].includes(fresh.stage)) return;
      // Reserve this follow-up slot up front (count → n, schedule next due time) so a
      // second sweep tick can't re-fire the same nudge while generateMove is in flight
      // (the sweep's due gate keys off followup_count). The only non-send outcome below
      // is needs_human, which FLAGS the conversation → it drops out of the sweep's
      // candidate set, so the advanced count can never skip a nudge prematurely.
      const s = deps.getSettings();
      const ladder = followupLadder(s);
      const nextOffset = n >= ladder.length ? null : followupOffsetMs(ladder[n]);
      deps.setFollowup(conv.id, n, nextOffset ? new Date(Date.now() + nextOffset).toISOString() : null);

      const move = await generateMove(s, fresh, deps.historyOf(conv.id), { followup: n });
      const messages = normalizeMessages(move);

      if (fresh.mode === 'copilot') {
        const reason = `follow-up #${n}${move.needs_human ? ' — ' + (move.reason || '') : ''}`;
        deps.storeDraft(conv.id, messages, move.needs_human ? null : (move.stage || null), move.needs_human, reason);
        if (move.needs_human) deps.setNeedsHuman(conv.id, move.reason || 'needs_human', 'copilot');
        return;
      }
      // autopilot follow-up: send directly (source 'followup'). Scheduled follow-ups
      // are EXEMPT from the consecutive-AI-sends ceiling (skipConsecutiveLimit) — that
      // ceiling is for back-to-back inbound replies; the reply→#1→#2 cadence would
      // otherwise trip it and follow-up #2 would never send (the thread would go
      // dormant a nudge early).
      if (fresh.mode === 'autopilot') {
        // 24h window: outside it IG rejects the send. Park the composed message as a
        // manual draft instead. The follow-up count was already reserved above, so
        // this step is 'consumed' and the sweep won't retry it every 15s. notify()
        // is best-effort optional.
        if (!withinMessagingWindow(fresh)) {
          deps.storeDraft(conv.id, messages, null, false, WINDOW_REASON);
          deps.notify && deps.notify('Follow-up needs manual send', `${fresh.handle}: follow-up #${n} — ${WINDOW_REASON}`);
          return;
        }
        const decision = decideAutopilotMove(move, fresh, autopilotDeps(), { skipConsecutiveLimit: true });
        if (decision.action === 'needs_human') {
          deps.storeDraft(conv.id, messages, null, true, `follow-up #${n} — ${move.reason || 'needs_human'}`);
          return; // flagged → leaves the sweep; the reserved count is harmless
        }
        // 'limit' can't occur here (skipConsecutiveLimit). Send now — no humanizing
        // delay needed since the lead is already quiet.
        await finishAutopilotSend(conv.id, move, messages, null, 'followup');
      }
    } catch (e) {
      console.error('[autopilot] follow-up failed:', e.message);
      try { deps.storeDraft(conv.id, [''], null, true, 'autopilot error: ' + e.message); } catch { /* best-effort surface */ }
    }
  }

  // ---------------------------------------------------------------- plumbing
  // GUARD 4 — a bubble that is leaked prompt scaffolding, not a real reply: a
  // 'user '/'assistant '/'system ' role-prefixed line, a [SYSTEM NOTE / [FOLLOW-UP #
  // / [conversation start marker, or raw JSON. These reached leads verbatim
  // (runoitoje_, jakubdobis — a lead replied calling out the broken AI).
  const isScaffolding = (s) =>
    /^(user|assistant|system)\s/i.test(s) ||
    s.includes('[SYSTEM NOTE') ||
    s.includes('[FOLLOW-UP #') ||
    s.includes('[conversation start') ||
    s.startsWith('{"');

  function normalizeMessages(move) {
    const raw = Array.isArray(move?.messages) ? move.messages : [];
    const seen = new Set(); const out = [];
    for (const m of raw) {
      const s = String(m == null ? '' : m).trim();
      if (!s) continue;                       // drop empty bubbles
      if (isScaffolding(s)) { console.log('[sanitize] dropped leaked-scaffolding bubble'); continue; } // GUARD 4
      const k = s.toLowerCase();
      if (seen.has(k)) continue;              // the model sometimes repeats a bubble — never send the same line twice
      seen.add(k); out.push(s);
      if (out.length === 2) break;            // at most 2 bubbles
    }
    // If everything was scaffolding/empty, return []. Prior behavior returned ['']
    // (an empty-string bubble) which deliver() would drop anyway; the guard spec
    // says return an empty array — callers already handle empty (storeDraft/deliver
    // loops both no-op on []).
    return out;
  }

  function start() {
    if (sweepTimer) return;
    // In-flight guard: a slow tick (sequential IG sends + typing delays) must not
    // overlap the next one — overlapping ticks could re-enter the same sequence
    // step or reminder before it was marked and double-send it.
    let sweeping = false;
    sweepTimer = setInterval(async () => {
      if (sweeping) return;
      sweeping = true;
      try {
        await followupSweep().catch((e) => console.error('[sweep]', e.message));
        await bookingSweep().catch((e) => console.error('[booking-sweep]', e.message));
      } finally { sweeping = false; }
    }, FOLLOWUP_SWEEP_MS);
    if (sweepTimer.unref) sweepTimer.unref();
    // BOOT RESCUE (one-shot): the humanizing-delay timers are in-memory, so a
    // restart/redeploy mid-delay silently drops the reply the AI owed — and the
    // follow-up sweep can never revive that thread (it requires the SETTER to
    // have spoken last). Re-run the setter's turn for every conversation where
    // the lead spoke last and nothing is queued or flagged. copilot → a fresh
    // pending draft; autopilot in-window → the normal delayed send. Autopilot
    // OUTSIDE the 24h window is left alone (IG would reject the send) — it
    // stays visible in the inbox for the owner. All onInboundLead guards
    // (kill switch, needs_human, dead, mode off) still apply.
    if (deps.owedReplyConvs) {
      later(() => {
        const owed = deps.owedReplyConvs();
        if (!owed.length) return;
        console.log(`[rescue] ${owed.length} conversation(s) still owed a reply after restart`);
        for (const c of owed) {
          if (c.mode === 'autopilot' && !withinMessagingWindow(c)) {
            console.log(`[rescue] conv ${c.id} (@${c.handle}) outside 24h window — leaving for the owner`);
            continue;
          }
          onInboundLead(c.id);
        }
      }, FAST() ? 1000 : 10_000);
    }
  }

  function stop() {
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
    for (const t of timers) clearTimeout(t);
    timers.clear();
    pendingPersona.clear();
  }

  return { start, stop, onInboundLead, onSetterDelivered, generateCopilotDraft, followupSweep, bookingSweep };
}

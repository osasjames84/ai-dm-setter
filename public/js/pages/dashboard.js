'use strict';
/* ============================== dashboard ============================== */
async function loadDashboard() {
  const q = state.statsDays ? '?days=' + state.statsDays : '';
  try { state.stats = await api('/api/stats' + q); }
  catch (e) {
    if (state.route === 'dashboard' && !state.stats) {
      const page = $('#dash-page');
      if (page && !(page.contains(document.activeElement) && ['SELECT', 'INPUT'].includes(document.activeElement.tagName))) {
        page.innerHTML = '<div class="err-banner">' + icon('alert', 16) + '<span>Unable to load dashboard metrics.</span></div>';
      }
    }
    return;
  }
  renderDashboard();
}
/**
 * SetDM's exact funnel chart, reverse-engineered from setdm.app's rendered SVG:
 * viewBox 0 0 1000 180, center line y=78, first half-height 59, and each
 * stage's half-height = previous x that stage's conversion, clamped at 1.18
 * (2%) so the ribbon tapers into a thin line instead of vanishing. Pills are
 * drawn inside the SVG (rect rx=16, card fill, ring stroke) at column centers.
 */
function funnelSvg(vals, labels) {
  // Compact geometry: two funnels share the card, so both must fit one screen.
  const N = vals.length, W = 1000, CY = 52, H1 = 38, MIN = 1.18;
  const colW = W / N;
  const xs = vals.map((_, i) => (i + 0.5) * colW);
  const convs = vals.map((v, i) => (i === 0 ? 1 : (vals[i - 1] ? Math.min(1, v / vals[i - 1]) : 0)));
  const hs = []; let h = H1;
  for (let i = 0; i < N; i++) { if (i > 0) h = h * convs[i]; hs.push(Math.max(MIN, h)); }
  const f = (n) => n.toFixed(2);
  const edge = (yOf) => {
    let d = 'L ' + f(xs[0]) + ' ' + f(yOf(0));
    for (let i = 1; i < N; i++) {
      const mx = f((xs[i - 1] + xs[i]) / 2);
      d += ' C ' + mx + ' ' + f(yOf(i - 1)) + ', ' + mx + ' ' + f(yOf(i)) + ', ' + f(xs[i]) + ' ' + f(yOf(i));
    }
    return d;
  };
  const edgeBack = (yOf) => {
    let d = 'L ' + f(xs[N - 1]) + ' ' + f(yOf(N - 1));
    for (let i = N - 2; i >= 0; i--) {
      const mx = f((xs[i] + xs[i + 1]) / 2);
      d += ' C ' + mx + ' ' + f(yOf(i + 1)) + ', ' + mx + ' ' + f(yOf(i)) + ', ' + f(xs[i]) + ' ' + f(yOf(i));
    }
    return d;
  };
  const top = (i) => CY - hs[i], bot = (i) => CY + hs[i], hlBot = (i) => CY - hs[i] + hs[i] * 0.6;
  const main = 'M 0 ' + f(top(0)) + ' ' + edge(top) + ' L ' + W + ' ' + f(top(N - 1)) +
    ' L ' + W + ' ' + f(bot(N - 1)) + ' ' + edgeBack(bot) + ' L 0 ' + f(bot(0)) + ' Z';
  const hl = 'M 0 ' + f(top(0)) + ' ' + edge(top) + ' L ' + W + ' ' + f(top(N - 1)) +
    ' L ' + W + ' ' + f(hlBot(N - 1)) + ' ' + edgeBack(hlBot) + ' L 0 ' + f(hlBot(0)) + ' Z';
  const pills = xs.map((cx, i) => {
    const label = i === 0 ? '100%' : (convs[i] * 100).toFixed(1) + '%';
    const w = i === 0 ? 58 : 62;
    const tip = i === 0 ? '100% — start' : labels[i - 1] + ' → ' + labels[i] + ': ' + label;
    return '<g><title>' + esc(tip) + '</title>' +
      '<rect x="' + f(cx - w / 2) + '" y="' + f(CY - 14) + '" width="' + w + '" height="28" rx="14" fill="var(--card)" stroke="var(--ring)" stroke-width="2"/>' +
      '<text x="' + f(cx) + '" y="' + f(CY + 5) + '" text-anchor="middle" fill="var(--text)" font-size="13" font-weight="600" font-family="system-ui, -apple-system, sans-serif">' + label + '</text></g>';
  }).join('');
  return '<svg viewBox="0 0 1000 118" class="funnel-svg" preserveAspectRatio="xMidYMid meet">' +
    '<defs>' +
    '<linearGradient id="funnelGradient" x1="0%" y1="0%" x2="100%" y2="0%">' +
    '<stop offset="0%" stop-color="hsl(38, 92%, 65%)"/><stop offset="100%" stop-color="hsl(28, 90%, 55%)"/></linearGradient>' +
    '<linearGradient id="highlightGradient" x1="0%" y1="0%" x2="0%" y2="100%">' +
    '<stop offset="0%" stop-color="rgba(255, 255, 255, 0.4)"/><stop offset="100%" stop-color="rgba(255, 255, 255, 0)"/></linearGradient>' +
    '<filter id="funnelShadow" x="-5%" y="-15%" width="110%" height="140%">' +
    '<feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="rgba(0,0,0,0.15)"/></filter>' +
    '</defs>' +
    '<path d="' + main + '" fill="url(#funnelGradient)" filter="url(#funnelShadow)"/>' +
    '<path d="' + hl + '" fill="url(#highlightGradient)"/>' +
    pills + '</svg>';
}
/* Compact 'Performance' card: reply latency, stale-stage aging, flag reasons.
   Fields are all optional (backend may not be deployed yet) — renders nothing
   when none of the three sections have data, and each section independently
   hides itself if its own data is absent. */
function renderPerfCard(st) {
  const rl = st.reply_latency;
  const aging = st.stage_aging;
  const reasons = st.flag_reasons;

  let latencyHtml = '';
  if (rl && (rl.ai != null || rl.human != null)) {
    const ai = fmtDuration(rl.ai);
    const human = fmtDuration(rl.human);
    latencyHtml =
      '<div class="perf-section"><div class="perf-h">Median reply time</div>' +
      (ai ? '<div class="perf-row"><span>AI</span><span>' + esc(ai) + '</span></div>' : '') +
      (human ? '<div class="perf-row"><span>You</span><span>' + esc(human) + '</span></div>' : '') +
      '</div>';
  }

  let agingHtml = '';
  if (aging && typeof aging === 'object') {
    const rows = Object.keys(aging).filter((s) => (aging[s] || 0) > 0);
    agingHtml =
      '<div class="perf-section"><div class="perf-h">Going stale</div>' +
      (rows.length
        ? rows.map((s) => '<div class="perf-row perf-stale"><span>' + esc(aging[s]) + ' in ' + esc(STAGE_LABEL[s] || s) + ' &gt; 48h</span></div>').join('')
        : '<div class="perf-row perf-ok">Nothing stale \u{1F389}</div>') +
      '</div>';
  }

  let reasonsHtml = '';
  if (Array.isArray(reasons) && reasons.length) {
    reasonsHtml =
      '<div class="perf-section"><div class="perf-h">Flag reasons</div>' +
      reasons.slice(0, 3).map((r) => '<div class="perf-row"><span>' + esc(r.reason) + '</span><span>' + esc(r.n) + '</span></div>').join('') +
      '</div>';
  }

  if (!latencyHtml && !agingHtml && !reasonsHtml) return '';
  return '<div class="card perf-card">' +
    '<div class="pipe-title">Performance</div>' +
    '<div class="perf-grid">' + latencyHtml + agingHtml + reasonsHtml + '</div>' +
    '</div>';
}
function renderDashboard() {
  const st = state.stats;
  if (!st) return;
  // Don't yank the page out from under an open control (the 5s poll re-renders
  // wholesale); the range select blurs itself before requesting a re-render.
  const page = $('#dash-page');
  if (page.contains(document.activeElement) && ['SELECT', 'INPUT'].includes(document.activeElement.tagName)) return;
  const coach = ((state.settings && state.settings.settings && state.settings.settings.coach_name) || '').trim();
  const cards = [
    { label: 'Ongoing Chats', num: st.active, sub: 'Active conversations', ic: 'chat' },
    { label: 'Autopilot Enabled', num: st.autopilot_count, sub: '—', ic: 'bot', nav: 'ai_on' },
    { label: 'Needs Review', num: st.needs_review, sub: 'Flagged conversations', ic: 'bot', nav: 'flagged' },
    { label: 'In Followup Sequence', num: st.in_followup, sub: 'Queued followups', ic: 'chats' },
  ];
  const funnelLabels = DASH_FUNNEL.map((s) => DASH_STAGE_LABEL[s] || STAGE_LABEL[s]);
  $('#dash-page').innerHTML =
    '<div class="dash-head"><div><h1>Welcome back' + (coach ? ', ' + esc(coach) : '') + '</h1>' +
    '<div class="sub">Let&#39;s start the day off strong!</div></div>' +
    '<div><div class="range-label">Date range</div>' +
    '<select class="range-select" id="range-sel">' +
    ['1|Today', '7|Last 7 days', '28|Last 4 weeks', '182|Last 6 months', '30|Month to date', '90|Quarter to date', '365|Year to date', '|All time'].map((o) => {
      const p = o.split('|');
      return '<option value="' + p[0] + '"' + (state.statsDays === p[0] ? ' selected' : '') + '>' + p[1] + '</option>';
    }).join('') + '</select></div></div>' +

    '<div class="stat-grid">' + cards.map((c) =>
      '<div class="card stat-card' + (c.nav ? ' stat-nav' : '') + '"' + (c.nav ? ' data-statnav="' + c.nav + '" title="Open in Messages"' : '') + '>' +
      '<div><div class="s-label">' + c.label + '</div><div class="s-num" data-count="' + (Number(c.num) || 0) + '">' + c.num + '</div>' +
      '<div class="s-sub">' + c.sub + '</div>' +
      '</div>' +
      '<div class="icon-chip">' + icon(c.ic, 20) + '</div></div>'
    ).join('') + '</div>' +

    '<div class="card pipeline-card">' +
    '<div class="pipe-title">Pipeline funnel</div>' +
    '<div class="pipe-section">Current pipeline</div>' +
    '<div class="stage-row">' + DASH_FUNNEL.map((s) => {
      const cnt = st.by_stage[s] || 0;
      return '<div class="stage-cell"><div class="st-label"><span>' + (DASH_STAGE_LABEL[s] || STAGE_LABEL[s]) + '</span><span title="' + esc(STAGE_INFO[s]) + '">' + icon('info', 12) + '</span></div>' +
        '<div class="st-num">' + cnt + '</div>' +
        '<button class="stage-chat" data-gostage="' + s + '" title="View ' + (DASH_STAGE_LABEL[s] || STAGE_LABEL[s]) + ' conversations">' + icon('chatsq', 16) + '</button></div>';
    }).join('') + '</div>' +
    funnelSvg(DASH_FUNNEL.map((s) => st.by_stage[s] || 0), funnelLabels) +

    '<div class="pipe-section" style="margin-top:14px">Totals</div>' +
    '<div class="funnel-labels" style="grid-template-columns:repeat(' + DASH_TOTALS.length + ',1fr)">' + DASH_TOTALS.map((s) =>
      '<div class="fl"><div class="l">' + (DASH_STAGE_LABEL[s] || STAGE_LABEL[s]) + '</div><div class="n">' + (st.reached[s] || 0) + '</div></div>'
    ).join('') + '</div>' +
    '<div class="totals-bars" style="grid-template-columns:repeat(' + DASH_TOTALS.length + ',1fr)">' + (() => {
      const vals = DASH_TOTALS.map((s) => st.reached[s] || 0);
      const max = Math.max(1, ...vals);
      return vals.map((v, i) => {
        // sqrt scale: 247 leads next to 3 qualified would flatline linearly
        const pct = v > 0 ? Math.max(8, Math.round(Math.sqrt(v / max) * 100)) : 0;
        const isMax = v === max && max > 0;
        const barH = REDUCED_MOTION ? pct + '%' : '0';
        return '<div title="' + esc((DASH_STAGE_LABEL[DASH_TOTALS[i]] || STAGE_LABEL[DASH_TOTALS[i]]) + ': ' + v) + '"><div class="stage-bar-track"><div class="stage-bar' + (isMax ? ' is-max' : '') + '" data-h="' + pct + '" style="height:' + barH + '"></div></div></div>';
      }).join('');
    })() + '</div>' +
    '</div>' +

    renderPerfCard(st) +

    '<div class="outcome-strip">' +
    '<span>Routed <b>' + (st.by_stage.routed || 0) + '</b></span>' +
    '<span>Dead <b>' + (st.by_stage.dead || 0) + '</b></span>' +
    '<span>Booked this week <b>' + st.booked_this_week + '</b></span>' +
    '<span>Qualification rate <b>' + st.qualification_rate + '%</b></span>' +
    '<span>False positives <b>' + st.false_positives + '</b></span>' +
    '<span>Pending drafts <b>' + st.pending_drafts + '</b></span>' +
    '</div>';

  $('#range-sel').addEventListener('change', (e) => { state.statsDays = e.target.value; e.target.blur(); loadDashboard(); });
  $('#dash-page').querySelectorAll('[data-gostage]').forEach((b) => b.addEventListener('click', () => {
    state.filterStage = b.dataset.gostage; state.filterFlagged = false; renderChips(); go('messages');
  }));
  // Stat-card shortcuts: "Needs Review" → Messages w/ Flagged chip, "Autopilot Enabled" → AI On chip.
  $('#dash-page').querySelectorAll('[data-statnav]').forEach((el) => el.addEventListener('click', () => {
    state.filterStage = ''; state.sortAttention = false;
    if (el.dataset.statnav === 'flagged') { state.filterFlagged = true; state.filterMode = ''; }
    else { state.filterMode = 'on'; state.filterFlagged = false; }
    renderChips(); go('messages');
  }));

  // First-render-only entrance: count the stat numbers up + grow the totals bars.
  // Guarded so the 5s dashboard poll doesn't re-trigger it; reduced-motion renders
  // the final bar heights inline at render time so nothing animates.
  const bars = $('#dash-page').querySelectorAll('.stage-bar');
  if (state.dashAnimated || REDUCED_MOTION) {
    bars.forEach((b) => { b.style.height = (b.dataset.h || 0) + '%'; });
  } else {
    state.dashAnimated = true;
    countUpStats($('#dash-page').querySelectorAll('.s-num[data-count]'));
    // next frame so the 0-height start is committed before the transition target
    requestAnimationFrame(() => requestAnimationFrame(() => {
      bars.forEach((b) => { b.style.height = (b.dataset.h || 0) + '%'; });
    }));
  }
}
function countUpStats(nodes) {
  const DUR = 600, t0 = performance.now();
  const targets = Array.from(nodes).map((n) => ({ n, to: Number(n.dataset.count) || 0 }));
  targets.forEach((t) => { t.n.textContent = '0'; });
  const ease = (p) => 1 - Math.pow(1 - p, 3); // ease-out cubic
  function tick(now) {
    const p = Math.min(1, (now - t0) / DUR);
    const e = ease(p);
    targets.forEach((t) => { t.n.textContent = String(Math.round(t.to * e)); });
    if (p < 1) requestAnimationFrame(tick);
    else targets.forEach((t) => { t.n.textContent = String(t.to); }); // exact final value
  }
  requestAnimationFrame(tick);
}

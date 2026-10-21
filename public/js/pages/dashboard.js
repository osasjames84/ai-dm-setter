'use strict';
/* ============================== dashboard ============================== */
async function loadDashboard() {
  const q = state.statsDays ? '?days=' + state.statsDays : '';
  try { [state.stats, state.revenue] = await Promise.all([api('/api/stats' + q), api('/api/revenue?period=' + (state.revPeriod || 'MTD')).catch(() => state.revenue || null)]); }
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
    const tip = i === 0 ? '100%: start' : labels[i - 1] + ' → ' + labels[i] + ': ' + label;
    return '<g><title>' + esc(tip) + '</title>' +
      '<rect x="' + f(cx - w / 2) + '" y="' + f(CY - 14) + '" width="' + w + '" height="28" rx="14" fill="var(--card)" stroke="var(--c-border-strong)" stroke-width="1.5"/>' +
      '<text x="' + f(cx) + '" y="' + f(CY + 5) + '" text-anchor="middle" fill="var(--text)" font-size="13" font-weight="600" font-family="inherit">' + label + '</text></g>';
  }).join('');
  return '<svg viewBox="0 0 1000 118" class="funnel-svg" preserveAspectRatio="xMidYMid meet">' +
    '<defs>' +
    '<linearGradient id="funnelGradient" x1="0%" y1="0%" x2="100%" y2="0%">' +
    '<stop offset="0%" stop-color="var(--funnel-from)"/><stop offset="100%" stop-color="var(--funnel-to)"/></linearGradient>' +
    '<linearGradient id="highlightGradient" x1="0%" y1="0%" x2="0%" y2="100%">' +
    '<stop offset="0%" stop-color="rgba(255, 255, 255, 0.28)"/><stop offset="100%" stop-color="rgba(255, 255, 255, 0)"/></linearGradient>' +
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
function renderDashboard(force) {
  const st = state.stats;
  if (!st) return;
  // Keep the revenue assumptions form intact across the 5s poll while it is open.
  if (!force && state.revEditing && $('#rev-form')) return;
  // Don't yank the page out from under an open control (the 5s poll re-renders
  // wholesale); the range select blurs itself before requesting a re-render.
  const page = $('#dash-page');
  if (page.contains(document.activeElement) && ['SELECT', 'INPUT'].includes(document.activeElement.tagName)) return;
  const coach = ((state.settings && state.settings.settings && state.settings.settings.coach_name) || '').trim();
  const cards = [
    { label: 'Ongoing Chats', num: st.active, sub: 'Active conversations', ic: 'chat' },
    { label: 'Autopilot Enabled', num: st.autopilot_count, sub: 'AI handling replies', ic: 'bot', nav: 'ai_on' },
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

    renderRevenueCard(state.revenue) +

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

  bindRevenueCard();
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

/* ============================== revenue card (Stripe "Reports overview") ============================== */
const REV_PERIODS = ['1W', '4W', '1Y', 'MTD', 'QTD', 'YTD', 'ALL'];
const revMoney = (n, cur, dp = 2) => {
  try { return new Intl.NumberFormat('en-GB', { style: 'currency', currency: cur || 'GBP', minimumFractionDigits: dp, maximumFractionDigits: dp }).format(Number(n) || 0); }
  catch { return (Number(n) || 0).toFixed(dp); }
};
const revDate = (ymd, withYear) => new Date(ymd + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' });
const revBucketLabel = (key, unit) => unit === 'month'
  ? new Date(key + '-15T12:00:00Z').toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' })
  : revDate(key, false);
/** Line chart of pipeline added per day/month in the dashboard's accent: straight segments, faint grid, end dot. */
function revenueChart(r) {
  const s = r.series || [];
  if (!s.length) return '';
  const W = 640, H = 150, top = 14, base = H - 20, padX = 6;
  const max = Math.max(...s.map((p) => p.value), 0);
  const x = (i) => s.length === 1 ? W / 2 : padX + (i / (s.length - 1)) * (W - 2 * padX);
  const y = (v) => max > 0 ? base - (v / max) * (base - top) : base;
  const pts = s.map((p, i) => [x(i), y(p.value)]);
  const every = s.length <= 12 ? 1 : Math.ceil(s.length / 7);
  const grid = s.map((p, i) => (i % every === 0 || i === s.length - 1) ? '<line x1="' + x(i).toFixed(1) + '" x2="' + x(i).toFixed(1) + '" y1="' + top + '" y2="' + base + '" class="rev-grid"/>' : '').join('');
  const last = pts[pts.length - 1];
  const data = esc(JSON.stringify(s.map((p, i) => [pts[i][0], pts[i][1], revBucketLabel(p.key, r.unit), p.value, p.booked])));
  return '<div class="rev-chart" data-points="' + data + '" data-cur="' + esc(r.currency) + '"><div class="rev-plot">' +
    '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="Pipeline added per ' + r.unit + '">' +
    // Same left-to-right gradient as the pipeline funnel ribbon; the fill fades out downwards.
    '<defs><linearGradient id="revGrad" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="' + W + '" y2="0"><stop offset="0%" stop-color="var(--funnel-from)"/><stop offset="100%" stop-color="var(--funnel-to)"/></linearGradient>' +
    '<linearGradient id="revFade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>' +
    '<mask id="revMask" maskUnits="userSpaceOnUse" x="0" y="0" width="' + W + '" height="' + H + '"><rect x="0" y="' + top + '" width="' + W + '" height="' + (base - top) + '" fill="url(#revFade)"/></mask></defs>' +
    grid + '<line x1="0" x2="' + W + '" y1="' + base + '" y2="' + base + '" class="rev-base"/>' +
    '<polygon points="' + pts.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ') + ' ' + last[0].toFixed(1) + ',' + base + ' ' + pts[0][0].toFixed(1) + ',' + base + '" fill="url(#revGrad)" mask="url(#revMask)"/>' +
    '<polyline points="' + pts.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ') + '" class="rev-line"/>' +
    '<line class="rev-cursor" x1="0" x2="0" y1="' + top + '" y2="' + base + '" style="display:none"/></svg>' +
    '<span class="rev-end" style="left:' + (last[0] / W * 100).toFixed(2) + '%;top:' + (last[1] / H * 100).toFixed(2) + '%"></span>' +
    '<div class="rev-tip" hidden></div></div>' +
    '<div class="rev-axis"><span>' + esc(revBucketLabel(s[0].key, r.unit)) + '</span><span>' + esc(r.unit === 'day' ? 'Today' : revBucketLabel(s[s.length - 1].key, r.unit)) + '</span></div></div>';
}
function renderRevenueCard(r) {
  if (!r) return '';
  const owner = state.me?.user?.role === 'owner';
  const cur = r.currency || 'GBP';
  const noValue = !(r.deal_value > 0);
  // Stripe-style ranges: the year shows on the end date, and on the start date when it differs.
  const thisYear = String(new Date().getFullYear());
  const curRange = revDate(r.range.start, r.range.start.slice(0, 4) !== thisYear) + ' – Today';
  const prevRange = r.previous_range ? revDate(r.previous_range.start, r.previous_range.start.slice(0, 4) !== r.previous_range.end.slice(0, 4)) + ' – ' + revDate(r.previous_range.end, true) : '';
  const delta = r.change_pct === null || r.change_pct === undefined ? '' :
    '<span class="tag ' + (r.change_pct >= 0 ? 'green' : 'red') + '">' + (r.change_pct >= 0 ? '+' : '') + r.change_pct + '%</span>';
  const edit = state.revEditing ? '<form class="rev-edit-form" id="rev-form">' +
    '<label>Average deal value (' + esc(cur) + ')<input id="rev-deal" inputmode="decimal" placeholder="e.g. 2000" value="' + esc(r.deal_value || '') + '"></label>' +
    '<label>Close rate on booked calls (%)<input id="rev-rate" inputmode="decimal" placeholder="25" value="' + esc(r.close_rate_set ? r.close_rate : '') + '"></label>' +
    '<div class="rev-edit-actions"><button class="btn btn-primary btn-sm" type="submit">Save</button><button class="btn btn-ghost btn-sm" type="button" id="rev-cancel">Cancel</button></div>' +
    '<p class="rev-err" id="rev-err" role="alert"></p></form>' : '';
  return '<div class="card pipeline-card rev-card">' +
    '<div class="rev-head"><div class="pipe-title">Revenue</div>' +
      '<div class="rev-controls"><div class="rev-periods" role="tablist" aria-label="Period">' + REV_PERIODS.map((p) => '<button type="button" role="tab" class="chip' + (p === r.period ? ' on' : '') + '" aria-selected="' + (p === r.period) + '" data-revperiod="' + p + '">' + p + '</button>').join('') + '</div>' +
      (owner ? '<button class="btn btn-ghost btn-sm" id="rev-edit" type="button">' + (noValue ? 'Set deal value' : 'Edit') + '</button>' : '') + '</div></div>' +
    edit +
    '<div class="pipe-section">Pipeline generated</div>' +
    '<div class="rev-compare">' +
      '<div><div class="rev-num">' + (noValue ? r.booked + (r.booked === 1 ? ' call' : ' calls') : revMoney(r.pipeline, cur)) + ' ' + delta + '</div><div class="rev-range">' + esc(curRange) + '</div></div>' +
      (r.previous ? '<div class="rev-prev"><div class="rev-prev-l">Previous period</div><div class="rev-prev-n">' + (noValue ? r.previous.booked + ' calls' : revMoney(r.previous.pipeline, cur)) + '</div><div class="rev-range">' + esc(prevRange) + '</div></div>' : '') +
    '</div>' +
    (noValue ? '<p class="rev-hint">Add your average deal value to see these calls as money.</p>' : revenueChart(r)) +
  '</div>';
}
function bindRevenueCard() {
  const card = $('#dash-page .rev-card');
  if (!card) return;
  card.querySelectorAll('[data-revperiod]').forEach((b) => b.addEventListener('click', async () => {
    state.revPeriod = b.dataset.revperiod;
    try { state.revenue = await api('/api/revenue?period=' + state.revPeriod); renderDashboard(true); } catch (e) { toast(e.message, 'err'); }
  }));
  card.querySelector('#rev-edit')?.addEventListener('click', () => { state.revEditing = !state.revEditing; renderDashboard(true); $('#rev-deal')?.focus(); });
  card.querySelector('#rev-cancel')?.addEventListener('click', () => { state.revEditing = false; renderDashboard(true); });
  card.querySelector('#rev-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.currentTarget.querySelector('button[type=submit]'); btn.disabled = true;
    try {
      await api('/api/settings', { method: 'PUT', body: { client_value: $('#rev-deal').value.trim(), close_rate: $('#rev-rate').value.trim() } });
      state.revEditing = false; document.activeElement?.blur();
      state.revenue = await api('/api/revenue?period=' + (state.revPeriod || 'MTD'));
      renderDashboard(true); toast('Revenue assumptions saved');
    } catch (err) { $('#rev-err').textContent = err.message; btn.disabled = false; }
  });
  const chart = card.querySelector('.rev-chart');
  if (!chart) return;
  const pts = JSON.parse(chart.dataset.points || '[]'), cur = chart.dataset.cur;
  const svg = chart.querySelector('svg'), tip = chart.querySelector('.rev-tip'), line = chart.querySelector('.rev-cursor');
  chart.addEventListener('pointermove', (ev) => {
    const box = svg.getBoundingClientRect(); if (!box.width || !pts.length) return;
    const xv = ((ev.clientX - box.left) / box.width) * 640;
    let best = pts[0]; for (const p of pts) if (Math.abs(p[0] - xv) < Math.abs(best[0] - xv)) best = p;
    line.setAttribute('x1', best[0]); line.setAttribute('x2', best[0]); line.style.display = '';
    tip.innerHTML = '<b>' + esc(revMoney(best[3], cur)) + '</b><span>' + esc(best[2]) + ' · ' + best[4] + ' booked</span>';
    tip.style.left = Math.min(Math.max((best[0] / 640) * box.width, 70), box.width - 70) + 'px';
    tip.style.top = ((best[1] / 150) * box.height) + 'px'; tip.hidden = false;
  });
  chart.addEventListener('pointerleave', () => { tip.hidden = true; line.style.display = 'none'; });
}

'use strict';
/* ============================== content ============================== */
/** Single numbered row for the ideas list. Old cached payloads may still carry type/hook/outline —
 *  those are ignored on purpose; only title + source_quote are rendered. */
function contentIdeaRow(idea, index) {
  const quote = String(idea.source_quote || '');
  const truncated = quote.length > 70 ? quote.slice(0, 70).trim() + '…' : quote;
  return '<div class="idea-row" data-idea-id="' + esc(idea.id || '') + '">' +
    '<div class="idea-num">' + (index + 1) + '.</div>' +
    '<div class="idea-row-body">' +
      '<div class="idea-row-title">' + esc(idea.title || '') + '</div>' +
      (quote ? '<div class="idea-row-source" title="' + esc(quote) + '">from: &ldquo;' + esc(truncated) + '&rdquo;</div>' : '') +
    '</div>' +
    '<button class="icon-btn idea-row-copy idea-copy" title="Copy">' + icon('copy', 15) + '</button>' +
    '</div>';
}

function contentThemeBlocks(items, empty) {
  return (items && items.length) ? items.map((t) => {
    const quotes = (t.quotes || []).map((q) => '<div class="quote-row">&ldquo;' + esc(q) + '&rdquo;</div>').join('');
    return '<div class="theme-row"><div class="theme-title"><span>' + esc(t.theme || '') + '</span>' +
      (t.count_hint != null ? '<span class="theme-count">' + esc(String(t.count_hint)) + '</span>' : '') + '</div>' + quotes + '</div>';
  }).join('') : '<div class="insight-empty">' + esc(empty) + '</div>';
}

function contentQaBlocks(items, empty, kind) {
  if (!items || !items.length) return '<div class="insight-empty">' + esc(empty) + '</div>';
  if (kind === 'question') {
    return '<div class="phrase-list">' + items.map((q) => '<div class="phrase-line"><span>&ldquo;' + esc(q) + '&rdquo;</span></div>').join('') + '</div>';
  }
  const mainKey = kind === 'objection' ? 'objection' : 'outcome';
  return '<div class="phrase-list">' + items.map((it) => '<div class="phrase-line"><span>' + esc(it[mainKey] || '') + '</span></div>' +
    (it.quote ? '<div class="quote-row">&ldquo;' + esc(it.quote) + '&rdquo;</div>' : '')).join('') + '</div>';
}

const CONTENT_RANGE_MS = { day: 24 * 3600 * 1000, week: 7 * 24 * 3600 * 1000, month: 30 * 24 * 3600 * 1000, all: Infinity };

/** Horizontal bar chart of the top pains for the selected range. Falls back to lifetime count when a pain has no dates[] (pre-migration cache). */
function contentPainChart(pains, range) {
  const rangeMs = CONTENT_RANGE_MS[range] ?? CONTENT_RANGE_MS.month;
  const cutoff = rangeMs === Infinity ? -Infinity : Date.now() - rangeMs;
  let anyMissingDates = false;

  const withCounts = (pains || []).map((p) => {
    const lifetimeCount = p.count ?? (p.quotes ? p.quotes.length : 0);
    let inRangeCount;
    if (Array.isArray(p.dates)) {
      inRangeCount = p.dates.filter((d) => { const t = Date.parse(d); return !isNaN(t) && t >= cutoff; }).length;
    } else {
      anyMissingDates = true;
      inRangeCount = lifetimeCount;
    }
    return { theme: p.theme || '', count: inRangeCount };
  });

  const top = withCounts.filter((p) => p.theme).sort((a, b) => b.count - a.count).slice(0, 8);
  const maxCount = top.reduce((m, p) => Math.max(m, p.count), 0);

  let rowsHtml;
  if (!top.length || maxCount === 0) {
    rowsHtml = '<div class="insight-empty">no pain points in this window — try a wider range</div>';
  } else {
    rowsHtml = '<div class="bar-rows">' + top.map((p) => {
      const pct = p.count > 0 ? Math.max(4, Math.round((p.count / maxCount) * 100)) : 0;
      const label = p.theme.length > 40 ? p.theme.slice(0, 40) + '…' : p.theme;
      return '<div class="bar-row"><div class="bar-row-label" title="' + esc(p.theme) + '">' + esc(label) + '</div>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div>' +
        '<div class="bar-row-count">' + esc(String(p.count)) + '</div></div>';
    }).join('') + '</div>';
  }

  const rangeChips = [['day', 'Daily'], ['week', 'Weekly'], ['month', 'Monthly'], ['all', 'All']].map(([key, label]) =>
    '<button class="chip' + (range === key ? ' on' : '') + '" data-range="' + key + '">' + label + '</button>').join('');

  return '<div class="card chart-card"><div class="chart-card-head"><h2>Top pain points</h2>' +
    '<div class="range-chips">' + rangeChips + '</div></div>' +
    rowsHtml +
    (anyMissingDates ? '<div class="chart-footnote">re-analyze to unlock time filtering</div>' : '') +
    '</div>';
}

async function contentRunAnalyze(endpoint, btn, busyText) {
  if (state.contentBusy) return;
  state.contentBusy = true;
  const prevIdeaCount = (state.content && state.content.ideas) ? state.content.ideas.length : 0;
  if (btn) { btn.disabled = true; btn.textContent = busyText; }
  try {
    const data = await api(endpoint, { method: 'POST' });
    state.content = data;
    if (endpoint === '/api/content/more' && data.ideas) {
      const added = data.ideas.length - prevIdeaCount;
      toast('+' + Math.max(added, 0) + ' new ideas');
    }
  } catch (e) {
    toast(e.message || 'Could not analyze your DMs', 'err');
  }
  state.contentBusy = false;
  if (state.route === 'content') renderContent();
}

async function renderContent() {
  const page = $('#content-page');

  if (!state.content) {
    try {
      const cached = await api('/api/content');
      if (state.route !== 'content') return;
      state.content = cached;
    } catch (e) {
      if (state.route !== 'content') return;
      state.content = { empty: true };
    }
  }

  const c = state.content;

  // ---- empty / not-yet-analyzed state --------------------------------------
  if (!c || c.empty) {
    page.innerHTML = '<div class="content-empty-wrap"><div class="card content-empty-card">' +
      '<div class="content-empty-icon">' + icon('bulb', 30) + '</div>' +
      '<h1>Turn your DMs into content</h1>' +
      '<p>Mine every pain point, question and dream outcome your leads have ever sent you — and turn them into hooks, reels and posts.</p>' +
      '<button class="btn btn-primary" id="content-analyze">' + icon('spark', 16) + 'Analyze my DMs</button>' +
      '</div></div>';
    $('#content-analyze').addEventListener('click', (e) => contentRunAnalyze('/api/content/analyze', e.currentTarget, 'Mining your DMs… this takes ~30s'));
    return;
  }

  // ---- results state --------------------------------------------------------
  const ideas = c.ideas || [];
  const pains = c.pains || [];
  const questions = c.questions || [];
  const objections = c.objections || [];
  const outcomes = c.outcomes || [];
  const language = c.language || [];
  const view = state.contentView === 'ideas' ? 'ideas' : 'pains';

  const header = '<div class="content-head"><div><h1>Content engine</h1>' +
    '<div class="sub">mined from ' + esc(String(c.sample_size ?? 0)) + ' lead messages &middot; ' + (c.generated_at ? timeAgo(c.generated_at) + ' ago' : 'just now') + '</div></div>' +
    '<div class="content-view-row">' +
      '<div class="content-view-toggle">' +
        '<button data-view="pains" class="' + (view === 'pains' ? 'on' : '') + '">Pain points</button>' +
        '<button data-view="ideas" class="' + (view === 'ideas' ? 'on' : '') + '">Content ideas</button>' +
      '</div>' +
      '<button class="btn btn-ghost" id="content-refresh">' + icon('refresh', 16) + 'Re-analyze</button>' +
    '</div></div>';

  let body;
  if (view === 'ideas') {
    body = '<div class="ideas-head"><div class="sub">' + esc(String(ideas.length)) + ' ideas generated</div>' +
      '<button class="btn btn-primary" id="content-more">' + icon('spark', 16) + 'More ideas</button></div>' +
      (ideas.length ? '<div class="card idea-list-card">' + ideas.map(contentIdeaRow).join('') + '</div>' : '<div class="insight-empty">No ideas yet.</div>');
  } else {
    body = contentPainChart(pains, state.contentRange) +
      '<div class="content-raw-grid">' +
        '<div class="card insight-list-card"><div class="insight-card-head"><div><h2>Pain points</h2><p>What they&#39;re running from</p></div></div>' + contentThemeBlocks(pains, 'No pain points captured yet.') + '</div>' +
        '<div class="card insight-list-card"><div class="insight-card-head"><div><h2>Questions they ask</h2></div></div>' + contentQaBlocks(questions, 'No questions captured yet.', 'question') + '</div>' +
        '<div class="card insight-list-card"><div class="insight-card-head"><div><h2>Objections</h2></div></div>' + contentQaBlocks(objections, 'No objections captured yet.', 'objection') + '</div>' +
        '<div class="card insight-list-card"><div class="insight-card-head"><div><h2>Dream outcomes</h2></div></div>' + contentQaBlocks(outcomes, 'No outcomes captured yet.', 'outcome') + '</div>' +
      '</div>' +
      '<div class="card content-lang-card"><div class="insight-card-head"><div><h2>Their words</h2></div></div>' +
        '<div class="content-lang-chips">' + (language.length ? language.map((w) => '<span class="chip">' + esc(w) + '</span>').join('') : '<div class="insight-empty">No language captured yet.</div>') + '</div></div>';
  }

  page.innerHTML = header + body;

  page.querySelectorAll('.content-view-toggle button').forEach((btn) => btn.addEventListener('click', () => {
    state.contentView = btn.dataset.view;
    renderContent();
  }));

  if (view === 'ideas') {
    page.querySelectorAll('.idea-copy').forEach((btn) => btn.addEventListener('click', () => {
      const row = btn.closest('.idea-row');
      const id = row.dataset.ideaId;
      const idea = ideas.find((i) => String(i.id) === String(id)) || {};
      const text = idea.title || '';
      const done = () => toast('Copied');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(done);
      } else { done(); }
    }));
    $('#content-more').addEventListener('click', (e) => contentRunAnalyze('/api/content/more', e.currentTarget, 'Finding more…'));
  } else {
    page.querySelectorAll('.range-chips .chip').forEach((btn) => btn.addEventListener('click', () => {
      state.contentRange = btn.dataset.range;
      renderContent();
    }));
  }

  $('#content-refresh').addEventListener('click', (e) => contentRunAnalyze('/api/content/analyze', e.currentTarget, 'Mining your DMs… this takes ~30s'));
}

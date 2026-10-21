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
const CONTENT_RANGE_DAYS = { day: 1, week: 7, month: 30, all: '' };
const CHATS_PER_PAGE = 7;

/** Rank pain or goal themes inside the range: [{label, count, pct, dates, quote}] (pct of all matches). */
function contentRank(items, labelKey, range) {
  const rangeMs = CONTENT_RANGE_MS[range] ?? CONTENT_RANGE_MS.week;
  const cutoff = rangeMs === Infinity ? -Infinity : Date.now() - rangeMs;
  let dated = true;
  const rows = (items || []).filter((t) => t && t[labelKey]).map((t) => {
    const dates = Array.isArray(t.dates) ? t.dates.filter((d) => { const ms = Date.parse(d); return !isNaN(ms) && ms >= cutoff; }) : null;
    if (!dates) dated = false;
    const ex = (t.examples || []).find((e) => Date.parse(e.at) >= cutoff) || (t.examples || [])[0];
    const quote = ex ? { text: ex.text, handle: ex.handle, at: ex.at } : (t.quotes && t.quotes[0]) ? { text: t.quotes[0] } : t.quote ? { text: t.quote } : null;
    return { label: t[labelKey], count: dates ? dates.length : (t.count ?? (t.quotes ? t.quotes.length : 1)), dates: dates || [], quote };
  }).filter((r) => !dated || r.count > 0).sort((a, b) => b.count - a.count);
  const total = rows.reduce((n, r) => n + r.count, 0);
  rows.forEach((r) => { r.pct = total ? Math.round((r.count / total) * 100) : 0; });
  return { rows, total, dated };
}

/** Tiny trend line of timestamps bucketed across the range. */
function contentSpark(dates, range, color) {
  const now = Date.now();
  const times = (dates || []).map((d) => Date.parse(d)).filter((t) => !isNaN(t));
  const span = CONTENT_RANGE_MS[range] === Infinity ? Math.max(86400_000, now - Math.min(now - 86400_000, ...times)) : CONTENT_RANGE_MS[range];
  const N = 12, start = now - span, b = new Array(N).fill(0);
  for (const t of times) if (t >= start) b[Math.min(N - 1, Math.floor(((t - start) / span) * N))]++;
  const max = Math.max(1, ...b), W = 120, H = 30;
  const pts = b.map((v, i) => (i * (W / (N - 1))).toFixed(1) + ',' + (H - 3 - (v / max) * (H - 6)).toFixed(1)).join(' ');
  return '<svg class="ci-spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true"><polyline points="' + pts + '" fill="none" stroke="' + color + '" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>';
}

/** "2d ago" / "just now". */
function contentAgo(iso) { if (!iso) return ''; const t = timeAgo(iso); return t === 'now' ? 'just now' : t + ' ago'; }

function contentKpi(label, value, sub, spark) {
  return '<div class="card ci-kpi"><div class="ci-kpi-top"><div class="ci-kpi-l">' + label + '</div>' + spark + '</div>' +
    '<div class="ci-kpi-v" title="' + esc(value) + '">' + esc(value) + '</div><div class="ci-kpi-s">' + esc(sub) + '</div></div>';
}

/** Ranked list card (Pain Points red, Goals green); the open item shows the lead's words. */
function contentRankCard(kind, title, sub, ranked, emptyText) {
  const all = state['ci_' + kind + '_all'];
  const open = state['ci_' + kind + '_open'] ?? 0;
  const max = Math.max(1, ...ranked.rows.map((r) => r.count));
  const list = ranked.rows.slice(0, all ? 50 : 5);
  const body = list.length && ranked.total ? list.map((r, i) =>
    '<div class="ci-item' + (i === open ? ' open' : '') + '" data-ci="' + kind + '" data-i="' + i + '" role="button" tabindex="0">' +
      '<div class="ci-item-row"><span class="ci-n">' + (i + 1) + '</span><span class="ci-t">' + esc(r.label) + '</span><span class="ci-c">' + r.count + ' (' + r.pct + '%)</span></div>' +
      '<div class="ci-bar"><div class="ci-fill ' + kind + '" style="width:' + Math.max(r.count ? 4 : 0, Math.round((r.count / max) * 100)) + '%"></div></div>' +
      (i === open && r.quote ? '<div class="ci-quote"><div class="ci-qt">&ldquo;' + esc(r.quote.text) + '&rdquo;</div>' + (r.quote.handle ? '<div class="ci-qm">@' + esc(r.quote.handle) + (r.quote.at ? ' · ' + esc(contentAgo(r.quote.at)) : '') + '</div>' : '') + '</div>' : '') +
    '</div>').join('') : '<div class="insight-empty">' + esc(emptyText) + '</div>';
  return '<div class="card ci-rank"><div class="ci-head"><h2>' + title + '</h2><p>' + sub + '</p></div>' + body +
    (ranked.rows.length > 5 ? '<button class="ci-seeall" data-seeall="' + kind + '" type="button">' + (all ? 'Show less' : 'See all') + '</button>' : '') +
    (!ranked.dated ? '<div class="chart-footnote">Re-analyze to rank these by date range</div>' : '') + '</div>';
}

function contentChatRows(chats) {
  const f = state.ciFilter || 'all', q = (state.ciQuery || '').trim().toLowerCase();
  return chats.filter((c) => (f === 'pain' ? c.pain : f === 'goal' ? c.goal : f === 'icp' ? c.icp : true) &&
    (!q || [c.handle, c.name, c.pain, c.goal, c.pain_quote, c.goal_quote].join(' ').toLowerCase().includes(q)));
}

function contentChatsCard(data) {
  if (!data) return '<div class="card ci-chats"><div class="ci-head"><h2>All Chats</h2><p>Loading…</p></div></div>';
  const rows = contentChatRows(data.chats || []);
  const pages = Math.max(1, Math.ceil(rows.length / CHATS_PER_PAGE));
  const page = Math.min(state.ciPage || 1, pages);
  const shown = rows.slice((page - 1) * CHATS_PER_PAGE, page * CHATS_PER_PAGE);
  const cell = (t, qt) => '<div class="ci-ct">' + esc(t || '—') + '</div>' + (qt ? '<div class="ci-cq">&ldquo;' + esc(qt) + '&rdquo;</div>' : '');
  const initials = (h) => esc(String(h || '?').replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '?');
  return '<div class="card ci-chats"><div class="ci-head"><h2>All Chats</h2><p>Every lead&#39;s pain and goal, in their own words. Tap any chat to open the conversation.</p></div>' +
    '<div class="ci-chats-bar"><div class="ci-filters">' + [['all', 'All'], ['pain', 'Pain'], ['goal', 'Goal'], ['icp', 'ICP only']].map(([k, l]) =>
      '<button type="button" class="chip' + ((state.ciFilter || 'all') === k ? ' on' : '') + '" data-cifilter="' + k + '">' + l + '</button>').join('') + '</div>' +
      '<label class="ci-search">' + icon('search', 14) + '<input id="ci-search" placeholder="Search handle or phrase…" value="' + esc(state.ciQuery || '') + '"></label></div>' +
    (shown.length ? '<div class="ci-table-wrap"><table class="ci-table"><thead><tr><th>From</th><th>Pain</th><th>Goal</th><th class="r">When</th></tr></thead><tbody>' +
      shown.map((c) => '<tr data-openchat="' + esc(c.id) + '" tabindex="0"><td><div class="ci-from"><span class="ci-av">' + initials(c.handle) + '</span><span><span class="ci-h">@' + esc(c.handle) + '</span>' + (c.icp ? '<span class="ci-icp">ICP</span>' : '') + '</span></div></td>' +
        '<td>' + cell(c.pain, c.pain_quote) + '</td><td>' + cell(c.goal, c.goal_quote) + '</td><td class="r ci-when">' + esc(contentAgo(c.at)) + '</td></tr>').join('') +
      '</tbody></table></div>' +
      '<div class="ci-pager"><span>Showing ' + ((page - 1) * CHATS_PER_PAGE + 1) + '–' + ((page - 1) * CHATS_PER_PAGE + shown.length) + ' of ' + rows.length + '</span>' +
        '<span class="ci-pages"><button type="button" class="icon-btn" data-cipage="' + (page - 1) + '"' + (page <= 1 ? ' disabled' : '') + ' aria-label="Previous page">‹</button>Page ' + page + ' of ' + pages +
        '<button type="button" class="icon-btn" data-cipage="' + (page + 1) + '"' + (page >= pages ? ' disabled' : '') + ' aria-label="Next page">›</button></span></div>'
      : '<div class="insight-empty">' + ((data.chats || []).length ? 'No chats match.' : 'Pains and goals show up here as leads talk to you (lead profiles must be on in Settings).') + '</div>') +
    '</div>';
}

/** CSV of the All Chats rows currently matching the filters. */
function contentExportCsv() {
  const rows = contentChatRows((state.ciChats && state.ciChats.chats) || []);
  const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const csv = ['handle,icp,pain,pain_quote,goal,goal_quote,updated'].concat(rows.map((c) => [c.handle, c.icp ? 'yes' : 'no', c.pain, c.pain_quote, c.goal, c.goal_quote, c.at].map(q).join(','))).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'content-insights-chats.csv';
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function contentLoadChats() {
  const range = state.contentRange || 'week';
  if (state.ciChatsRange === range && state.ciChats && Date.now() - (state.ciChatsAt || 0) < 60_000) return;
  if (state.ciChatsLoading) return;
  state.ciChatsLoading = true; state.ciChatsAt = Date.now();
  try {
    const d = await api('/api/content/chats?days=' + CONTENT_RANGE_DAYS[range]);
    state.ciChats = d; state.ciChatsRange = range;
  } catch { state.ciChats = { chats: [], analyzed: 0, qualified: [] }; state.ciChatsRange = range; }
  state.ciChatsLoading = false;
  if (state.route === 'content' && state.contentView !== 'ideas') renderContent();
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
      '<p>Mine every pain point, question and dream outcome your leads have ever sent you, and turn them into hooks, reels and posts.</p>' +
      '<button class="btn btn-primary" id="content-analyze">' + icon('spark', 16) + 'Analyze my DMs</button>' +
      '</div></div>';
    $('#content-analyze').addEventListener('click', (e) => contentRunAnalyze('/api/content/analyze', e.currentTarget, 'Mining your DMs… this takes ~30s'));
    return;
  }

  // ---- results state --------------------------------------------------------
  const ideas = c.ideas || [];
  const questions = c.questions || [];
  const objections = c.objections || [];
  const view = state.contentView === 'ideas' ? 'ideas' : 'insights';
  const range = state.contentRange || 'week';

  const header = '<div class="content-head ci-top"><div><h1>Content Insights <span class="ci-new">New</span></h1>' +
    '<div class="sub">Exactly what your audience is struggling with, in their own words. Mined from ' + esc(String(c.sample_size ?? 0)) + ' lead messages &middot; ' + (c.generated_at ? timeAgo(c.generated_at) + ' ago' : 'just now') + '</div></div>' +
    '<div class="content-view-row">' +
      (view === 'ideas'
        ? '<button class="btn btn-ghost" id="ci-back">' + icon('chevdown', 16) + 'Back to insights</button>'
        : '<div class="content-view-toggle">' + [['day', 'Daily'], ['week', 'Weekly'], ['month', 'Monthly'], ['all', 'All']].map(([k, l]) =>
            '<button data-range="' + k + '" class="' + (range === k ? 'on' : '') + '">' + l + '</button>').join('') + '</div>' +
          '<button class="btn btn-ghost" id="ci-export">' + icon('download', 16) + 'Export</button>') +
      '<button class="btn btn-ghost" id="content-refresh">' + icon('refresh', 16) + 'Re-analyze</button>' +
    '</div></div>';

  let body;
  if (view === 'ideas') {
    body = '<div class="ideas-head"><div class="sub">' + esc(String(ideas.length)) + ' ideas generated</div>' +
      '<button class="btn btn-primary" id="content-more">' + icon('spark', 16) + 'More ideas</button></div>' +
      (ideas.length ? '<div class="card idea-list-card">' + ideas.map(contentIdeaRow).join('') + '</div>' : '<div class="insight-empty">No ideas yet.</div>');
  } else {
    contentLoadChats();
    const pains = contentRank(c.pains, 'theme', range);
    const goals = contentRank(c.outcomes, 'outcome', range);
    const chats = state.ciChatsRange === range ? state.ciChats : null;
    const qual = chats ? chats.qualified.length : 0;
    const topP = pains.rows[0], topG = goals.rows[0];
    body =
      '<div class="ci-kpis">' +
        contentKpi('#1 Pain Point', topP && topP.count ? topP.label : '—', topP && topP.count ? topP.pct + '% of specific DMs' : 'Nothing in this range', contentSpark(topP ? topP.dates : [], range, 'var(--c-danger)')) +
        contentKpi('#1 Goal', topG && topG.count ? topG.label : '—', topG && topG.count ? topG.pct + '% of specific DMs' : 'Nothing in this range', contentSpark(topG ? topG.dates : [], range, 'var(--c-success)')) +
        contentKpi('Qualified Leads', chats ? String(qual) : '…', chats ? (chats.analyzed ? Math.round((qual / chats.analyzed) * 100) + '% of ' + chats.analyzed + ' analyzed' : 'No chats analyzed yet') : '', contentSpark(chats ? chats.qualified : [], range, 'var(--c-accent)')) +
      '</div>' +
      '<div class="ci-split">' +
        contentRankCard('pain', 'Pain Points', 'What they&#39;re struggling with. Tap one to see it in their words.', pains, 'No pain points in this range. Try a wider one.') +
        contentRankCard('goal', 'Goals', 'What they want to achieve. Tap one to see it in their words.', goals, 'No goals in this range. Try a wider one.') +
      '</div>' +
      contentChatsCard(chats) +
      '<div class="card ci-gen"><div class="ci-gen-ic">' + icon('spark', 18) + '</div><div class="ci-gen-t"><div class="ci-gen-h">Generate Content</div>' +
        '<div class="ci-gen-s">Turn your top pains and goals into ready-to-film reel, caption and story ideas, in your prospects&#39; own words.</div></div>' +
        '<button class="btn btn-primary" id="ci-generate">' + icon('spark', 16) + (ideas.length ? 'See ' + ideas.length + (ideas.length === 1 ? ' idea' : ' ideas') : 'Generate ideas') + '</button></div>' +
      '<div class="content-raw-grid ci-more">' +
        '<div class="card insight-list-card"><div class="insight-card-head"><div><h2>Questions they ask</h2></div></div>' + contentQaBlocks(questions, 'No questions captured yet.', 'question') + '</div>' +
        '<div class="card insight-list-card"><div class="insight-card-head"><div><h2>Objections</h2></div></div>' + contentQaBlocks(objections, 'No objections captured yet.', 'objection') + '</div>' +
      '</div>';
  }

  // Keep the search box focused across the re-render it triggers.
  const searching = document.activeElement && document.activeElement.id === 'ci-search';
  const caret = searching ? document.activeElement.selectionStart : null;
  page.innerHTML = header + body;
  if (searching) { const inp = $('#ci-search'); if (inp) { inp.focus(); inp.setSelectionRange(caret, caret); } }

  $('#content-refresh').addEventListener('click', (e) => contentRunAnalyze('/api/content/analyze', e.currentTarget, 'Mining your DMs… this takes ~30s'));
  if (view === 'ideas') {
    $('#ci-back').addEventListener('click', () => { state.contentView = 'insights'; renderContent(); });
    page.querySelectorAll('.idea-copy').forEach((btn) => btn.addEventListener('click', () => {
      const id = btn.closest('.idea-row').dataset.ideaId;
      const idea = ideas.find((i) => String(i.id) === String(id)) || {};
      const done = () => toast('Copied');
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(idea.title || '').then(done).catch(done);
      else done();
    }));
    $('#content-more').addEventListener('click', (e) => contentRunAnalyze('/api/content/more', e.currentTarget, 'Finding more…'));
    return;
  }
  page.querySelectorAll('.content-view-toggle [data-range]').forEach((btn) => btn.addEventListener('click', () => {
    state.contentRange = btn.dataset.range; state.ciPage = 1; renderContent();
  }));
  $('#ci-export').addEventListener('click', contentExportCsv);
  $('#ci-generate').addEventListener('click', (e) => {
    state.contentView = 'ideas';
    if (ideas.length) renderContent(); else contentRunAnalyze('/api/content/more', e.currentTarget, 'Generating…');
  });
  page.querySelectorAll('.ci-item').forEach((el) => {
    const toggle = () => { const k = 'ci_' + el.dataset.ci + '_open'; state[k] = state[k] === Number(el.dataset.i) ? -1 : Number(el.dataset.i); renderContent(); };
    el.addEventListener('click', toggle);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  });
  page.querySelectorAll('[data-seeall]').forEach((b) => b.addEventListener('click', () => { const k = 'ci_' + b.dataset.seeall + '_all'; state[k] = !state[k]; renderContent(); }));
  page.querySelectorAll('[data-cifilter]').forEach((b) => b.addEventListener('click', () => { state.ciFilter = b.dataset.cifilter; state.ciPage = 1; renderContent(); }));
  page.querySelectorAll('[data-cipage]').forEach((b) => b.addEventListener('click', () => { state.ciPage = Number(b.dataset.cipage); renderContent(); }));
  const search = $('#ci-search');
  if (search) search.addEventListener('input', () => { state.ciQuery = search.value; state.ciPage = 1; renderContent(); });
  page.querySelectorAll('[data-openchat]').forEach((tr) => {
    const open = () => { state.activeId = tr.dataset.openchat; go('messages'); };
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  });
}

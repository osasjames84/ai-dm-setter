'use strict';
/* ============================== messages ============================== */
function messagesScaffold() {
  $('#view-messages').innerHTML =
    '<div class="pane-list">' +
    '<div class="pane-list-head">' +
    '<div class="searchbox">' + icon('search', 15) + '<input id="conv-search" placeholder="Search conversations..." value="' + esc(state.search) + '"></div>' +
    '<div class="chips" id="chips"></div>' +
    '<div class="list-meta" id="list-meta"></div>' +
    '</div>' +
    '<div class="conv-scroll" id="conv-list"></div>' +
    '</div>' +
    '<div class="pane-thread" id="pane-thread"></div>' +
    '<div class="pane-info" id="pane-info"><div class="info-empty">No prospect selected</div></div>';
  let searchTimer = null;
  $('#conv-search').addEventListener('input', (e) => {
    state.search = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadConvs, 250); // debounce: one request per pause, not per keystroke
  });
  renderChips();
}
function renderChips() {
  const box = $('#chips');
  if (!box) return;
  const filterStages = ['lead', 'engaged', 'qualifying', 'qualified', 'booking_sent', 'call_booked', 'routed', 'sale'];
  const chips = [{ id: '', l: 'All' }].concat(filterStages.map((s) => ({
    id: s,
    l: s === 'routed' ? 'Nurturing' : STAGE_ONE[s],
  })));
  box.innerHTML = chips.map((c) =>
    '<button class="chip' + (!state.filterFlagged && !state.filterMode && state.filterStage === c.id ? ' on' : '') + '" data-chip="' + c.id + '">' + c.l + '</button>'
  ).join('') +
  '<button class="chip' + (state.filterFlagged ? ' on' : '') + '" data-chip="__flag">Flagged</button>' +
  '<button class="chip' + (state.filterMode === 'on' ? ' on' : '') + '" data-chip="__ai_on">AI On</button>' +
  '<button class="chip' + (state.filterMode === 'off' ? ' on' : '') + '" data-chip="__ai_off">AI Off</button>' +
  '<button class="chip' + (state.sortAttention ? ' on' : '') + '" data-chip="__priority">Priority</button>'+
  '<button class="chip'+(state.sortWaiting?' on':'')+'" data-chip="__waiting">Waiting longest</button>';
  box.querySelectorAll('[data-chip]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.chip === '__waiting') { state.sortWaiting=!state.sortWaiting; state.sortAttention=false;
    } else if (b.dataset.chip === '__priority') {
      state.sortWaiting=false; state.sortAttention = !state.sortAttention; if (state.sortAttention) state.filterFlagged = false;
    } else if (b.dataset.chip === '__flag') {
      state.filterFlagged = !state.filterFlagged; state.filterMode = ''; if (state.filterFlagged) state.sortAttention = false;
    } else if (b.dataset.chip === '__ai_on' || b.dataset.chip === '__ai_off') {
      state.filterMode = b.dataset.chip === '__ai_on' ? 'on' : 'off';
      state.filterStage = ''; state.filterFlagged = false;
    } else {
      state.filterStage = b.dataset.chip; state.filterFlagged = false; state.filterMode = '';
    }
    renderChips(); loadConvs();
  }));
}
async function toggleSpawnPop() {
  const holder = $('#spawn-pop-holder');
  if (holder.innerHTML) { holder.innerHTML = ''; return; }
  if (!state.personas.length) {
    try { state.personas = await api('/api/personas'); } catch (e) { toast(e.message, 'err'); return; }
  }
  holder.innerHTML = '<div class="spawn-pop"><div class="sp-title">Spawn a simulated lead</div>' +
    state.personas.map((p) => '<button data-persona="' + esc(p.id) + '"><div>' + esc(p.name) + '</div><div class="sp-handle">@' + esc(p.handle) + '</div></button>').join('') +
    '<button data-persona=""><div>Blank test lead</div><div class="sp-handle">@test_lead &mdash; you type the lead side</div></button></div>';
  holder.querySelectorAll('[data-persona]').forEach((b) => b.addEventListener('click', async () => {
    holder.innerHTML = '';
    try {
      const conv = await api('/api/sim/spawn', { method: 'POST', body: b.dataset.persona ? { personaId: b.dataset.persona } : {} });
      toast('Test lead spawned');
      state.activeId = conv.id;
      await loadConvs(); await loadThread(conv.id);
    } catch (e) { toast(e.message, 'err'); }
  }));
}
let _convSeq = 0;
async function loadConvs() {
  const params = new URLSearchParams();
  if (state.filterStage) params.set('stage', state.filterStage);
  if (state.search) params.set('q', state.search);
  let rows;
  const seq = ++_convSeq;
  try { rows = await api('/api/conversations' + (params.toString() ? '?' + params : '')); } catch (e) { return; }
  if (seq !== _convSeq) return; // a newer request is in flight — drop this stale response
  if (state.filterFlagged) rows = rows.filter((r) => r.needs_human);
  if (state.filterMode === 'on') rows = rows.filter((r) => r.mode === 'autopilot');
  if (state.filterMode === 'off') rows = rows.filter((r) => r.mode !== 'autopilot');
  if(state.sortWaiting) rows=rows.slice().sort((a,b)=>(Date.parse(a.waiting_since)||Infinity)-(Date.parse(b.waiting_since)||Infinity));
  if (state.sortAttention) rows = rows.slice().sort((a, b) => (b.attention || 0) - (a.attention || 0));
  state.convs = rows;
  renderConvList();
}
/** The list header: conversation count + Select button, or the multi-select action bar. */
function renderListMeta() {
  const meta = $('#list-meta');
  if (!meta) return;
  if (!state.selected) state.selected = new Set();
  if (state.selectMode) {
    const n = state.selected.size;
    const all = state.convs.length > 0 && n === state.convs.length;
    meta.innerHTML =
      '<span class="count">' + n + ' selected</span>' +
      '<div class="bulk-actions">' +
      '<button class="bulk-btn" id="bulk-all">' + (all ? 'Clear' : 'Select all') + '</button>' +
      '<button class="bulk-btn on" id="bulk-on">' + icon('bot', 13) + 'AI on</button>' +
      '<button class="bulk-btn off" id="bulk-off">AI off</button>' +
      '<button class="bulk-btn cancel" id="bulk-cancel">Cancel</button>' +
      '</div>';
    $('#bulk-all').addEventListener('click', () => {
      state.selected = new Set(all ? [] : state.convs.map((c) => c.id));
      renderConvList();
    });
    $('#bulk-on').addEventListener('click', () => applyBulkMode('autopilot'));
    $('#bulk-off').addEventListener('click', () => applyBulkMode('copilot'));
    $('#bulk-cancel').addEventListener('click', () => { state.selectMode = false; state.selected = new Set(); renderConvList(); });
  } else {
    const flaggedView = state.filterFlagged && state.convs.length > 0;
    meta.innerHTML =
      '<span class="count">' + state.convs.length + ' conversation' + (state.convs.length === 1 ? '' : 's') + '</span>' +
      '<div class="bulk-actions">' +
      (flaggedView ? '<button class="bulk-btn on" id="handled-all">Mark all handled</button>' : '') +
      '<button class="list-select" id="list-select"><span class="select-ring"></span>Select</button></div>';
    $('#list-select').addEventListener('click', () => { state.selectMode = true; state.selected = new Set(); renderConvList(); });
    if (flaggedView) $('#handled-all').addEventListener('click', async () => {
      if (!confirm('Clear the flag on all ' + state.convs.length + ' flagged conversations?')) return;
      try {
        const out = await api('/api/conversations/handled-all', { method: 'POST', body: {} });
        toast('Marked ' + out.cleared + ' handled');
        loadConvs(); if (state.activeId) loadThread(state.activeId);
      } catch (e) { toast(e.message, 'err'); }
    });
  }
}

/** Bulk-set AI mode on the selected conversations (autopilot = on, copilot = off/drafts). */
async function applyBulkMode(mode) {
  const ids = [...(state.selected || [])];
  if (!ids.length) { toast('Select some chats first', 'err'); return; }
  try {
    await api('/api/conversations/bulk-mode', { method: 'POST', body: { ids, mode } });
    toast('AI turned ' + (mode === 'autopilot' ? 'on' : 'off') + ' for ' + ids.length + ' chat' + (ids.length === 1 ? '' : 's'));
    state.selectMode = false; state.selected = new Set();
    loadConvs();
  } catch (e) { toast(e.message, 'err'); }
}

function renderConvList() {
  const list = $('#conv-list');
  if (!list) return;
  if (!state.selected) state.selected = new Set();
  renderListMeta();
  const scroll = list.scrollTop;
  if (!state.convs.length) {
    list.innerHTML = '<div class="pane-empty"><div class="icon-chip">' + icon('chat', 22) + '</div>' +
      'No conversations here yet.<br>Spawn a test lead to try the funnel.' +
      '</div>';
    return;
  }
  const sel = state.selectMode;
  list.innerHTML = state.convs.map((c, i) => {
    const unread=Math.max(0,Number(c.unread)||0);
    const flag = c.needs_human ? '<span class="flag-dot"></span>' : '';
    const auto = c.mode === 'autopilot';
    const picked = sel && state.selected.has(c.id);
    const priorityCue = state.sortAttention && i < 3 ? '<span class="priority-cue" title="High priority">' + icon('bolt', 12) + '</span>' : '';
    return '<div class="conv-row' + (!sel && c.id === state.activeId ? ' sel' : '') + (picked ? ' picked' : '') + (unread?' unread':'') + '" data-conv="' + c.id + '">' +
      (sel ? '<span class="conv-check' + (picked ? ' on' : '') + '">' + (picked ? icon('check', 13) : '') + '</span>' : '') +
      avatarHtml(c.handle, c.display_name, 40, flag) +
      '<div class="conv-mid"><div class="conv-name-row"><span class="conv-name">' + priorityCue + esc(c.display_name || c.handle) + '</span>' +
      '<span class="conv-time">' + (c.pending_draft ? '<span class="draft-dot" title="AI draft waiting"></span>' : '') + timeAgo(c.last_message_at || c.created_at) + '</span></div>' +
      '<div class="conv-stage-line">' + stageBadge(c.stage) +
      (c.call_time && new Date(c.call_time).getTime() > Date.now() ? '<span title="Call: ' + esc(callTimeFmt(c.call_time)) + '" style="display:inline-flex;color:var(--muted);margin-left:6px;vertical-align:middle">' + icon('calendar', 13) + '</span>' : '') +
      '</div>' +
      '<div class="conv-preview">' + esc(c.last_text || 'No messages yet') + '</div></div>' +
      '<div class="conv-right">' + (unread?'<span class="unread-count" aria-label="'+unread+' unread messages">'+unread+'</span>':'') +
      (sel ? '' : ('<span class="mini-switch-wrap" data-togglewrap>' + switchHtml(auto, '', 'data-modetoggle="' + c.id + '"') +
        '<span class="mini-label' + (auto ? ' ai' : '') + '">' + (auto ? 'AI' : 'Off') + '</span></span>')) +
      '</div></div>';
  }).join('');
  list.querySelectorAll('[data-conv]').forEach((row) => row.addEventListener('click', (e) => {
    if (state.selectMode) {
      const id = row.dataset.conv;
      if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
      renderConvList();
      return;
    }
    if (e.target.closest('[data-togglewrap]')) return;
    state.infoOpen=false;
    state.activeId = row.dataset.conv;
    $('#view-messages').classList.add('thread-open');
    renderConvList();
    loadThread(state.activeId);
  }));
  list.querySelectorAll('[data-modetoggle] input').forEach((inp) => inp.addEventListener('change', async (e) => {
    const id = e.target.closest('[data-modetoggle]').dataset.modetoggle;
    try {
      await api('/api/conversations/' + id, { method: 'PATCH', body: { mode: e.target.checked ? 'autopilot' : 'copilot' } });
      loadConvs(); if (id === state.activeId) loadThread(id);
    } catch (err) { toast(err.message, 'err'); loadConvs(); }
  }));
  const unreadTotal=state.convs.reduce((n,c)=>n+(Number(c.unread)||0),0);
  document.title=(unreadTotal?'('+unreadTotal+') ':'')+'dmSetter';
  list.scrollTop = scroll;
}
async function loadThread(id) {
  let data;
  try { data = await api('/api/conversations/' + id); } catch (e) { return; }
  if (state.activeId !== id) return;
  state.thread = data;
  renderThread();
  renderProspect();
  const unread=state.convs.find(c=>String(c.id)===String(id))?.unread;
  const receipt=id+':'+String(data.messages?.at(-1)?.id||'');
  if(unread>0 && state.route==='messages' && !document.hidden && !state.readReceipts.has(receipt)) {
    state.readReceipts.add(receipt);
    try {await api('/api/conversations/'+encodeURIComponent(id)+'/seen',{method:'POST'});await loadConvs();}
    catch(err){state.readReceipts.delete(receipt);if(err.status!==404)toast(err.message,'err');}
  }
}
function renderThread() {
  const pane = $('#pane-thread');
  if (!pane) return;
  const t = state.thread;
  if (!t || !state.activeId) {
    $('#view-messages').classList.remove('thread-open');
    pane.innerHTML = '<div class="thread-empty">Select a conversation to start chatting</div>';
    pane.dataset.key = '';
    const info = $('#pane-info'); if (info) info.innerHTML = '<div class="info-empty">No prospect selected</div>';
    return;
  }
  const c = t.conversation;
  const isSim = c.channel === 'sim';
  const key = c.id + ':' + (t.pending_draft ? t.pending_draft.id : 'none') + ':' + c.needs_human + ':' + (c.needs_human_reason || '');
  const structureStale = pane.dataset.key !== key;

  if (structureStale) {
    // Preserve what the owner is typing: the pane is rebuilt when a draft lands
    // or a flag changes, which used to wipe the composer mid-sentence.
    const keepComposer = (pane.querySelector('#composer-input') || {}).value || '';
    const sameDraft = t.pending_draft && pane.dataset.draftId === String(t.pending_draft.id);
    const keepDraft = sameDraft ? [...pane.querySelectorAll('#draft-zone textarea')].map((x) => x.value) : null;
    pane.dataset.key = key;
    pane.dataset.draftId = t.pending_draft ? String(t.pending_draft.id) : '';
    pane.innerHTML =
      '<div class="thread-head"><button class="mobile-back" id="mobile-back" aria-label="Back to conversations">&larr;</button>' + avatarHtml(c.handle, c.display_name, 36) +
      '<div class="thread-title">' + esc(c.display_name || c.handle) + '</div>' +
      stageBadge(c.stage) + '<button class="btn btn-ghost info-toggle" id="info-toggle" aria-controls="pane-info">Details</button></div>' +
      (c.needs_human ? '<div class="flag-banner">' + icon('flag', 15) + '<span class="fb-txt">Flagged for review' + (c.needs_human_reason ? ' &mdash; ' + esc(c.needs_human_reason) : '') + '</span>' +
        '<button class="btn btn-ghost btn-sm" id="handled-btn">Mark handled</button></div>' : '') +
      '<div class="msgs-scroll" id="msgs-scroll"></div>' +
      '<div class="draft-zone" id="draft-zone"></div>' +
      '<div class="thread-footer"><div class="ai-response-row"><button class="ai-response-btn" id="ai-response-btn">' + icon('bot', 16) + 'AI Response</button></div>' +
      '<div class="composer-wrap">' +
      '<div class="composer">' +
      '<div class="composer-media"><button class="icon-btn" id="voice-btn" title="Voice notes (Instagram only)">' + icon('wave', 18) + '</button>' +
      '<button class="icon-btn" id="insert-btn" title="Quick inserts">' + icon('plus', 18) + '</button></div>' +
      '<span class="composer-divider"></span>' +
      '<span id="insert-pop-holder"></span>' +
      '<textarea id="composer-input" rows="1" placeholder="Type a message..."></textarea>' +
      '<button class="icon-btn cal-btn" id="slots-btn" title="Insert call slots">' + icon('calendar', 17) + '</button>' +
      '<button class="send-btn" id="send-btn">' + icon('send', 16) + '</button>' +
      '</div></div></div>';
    wireThread();
    renderDraftZone();
    if (keepComposer) { const ci = $('#composer-input'); if (ci) ci.value = keepComposer; }
    if (keepDraft) pane.querySelectorAll('#draft-zone textarea').forEach((x, i) => { if (keepDraft[i] != null) x.value = keepDraft[i]; });
  } else {
    const badge = pane.querySelector('.thread-head .stage-badge');
    if (badge) badge.outerHTML = stageBadge(c.stage);
  }
  renderMsgs();
}
function dayLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso), now = new Date();
  const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((midnight(now) - midnight(d)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
/** Inner HTML of a message bubble — media (image/video/voice/file) or escaped text. */
function msgBubbleInner(m) {
  if (m.att_type && m.att_id) {
    const src = '/api/attachments/' + encodeURIComponent(m.att_id);
    if (m.att_type === 'image') return '<a href="' + src + '" target="_blank" rel="noopener"><img class="msg-media" src="' + src + '" alt="image"></a>';
    if (m.att_type === 'video') return '<video class="msg-media" controls preload="metadata" src="' + src + '"></video>';
    if (m.att_type === 'audio') {
      const hasTr = m.text && m.text !== '[voice note]';
      const tr = hasTr
        ? '<div class="msg-transcript">' + icon('mic', 13) + '<span>' + esc(m.text) + '</span></div>'
        : '<div class="msg-voice-label">Voice note</div>';
      return '<audio class="msg-audio" controls preload="none" src="' + src + '"></audio>' + tr;
    }
    return '<a class="msg-file-link" href="' + src + '" target="_blank" rel="noopener">' + icon('filetext', 14) + 'Attachment</a>';
  }
  return esc(m.text);
}
function renderMsgs() {
  const box = $('#msgs-scroll');
  if (!box || !state.thread) return;
  const msgs = state.thread.messages;
  const nearBottom = !box.dataset.count || box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const count = msgs.length + ':' + (state.thread.stage_events || []).length + ':' + state.thread.conversation.id;
  if (box.dataset.count === count) return;
  box.dataset.count = count;
  const c = state.thread.conversation;
  const name = c.display_name || c.handle;
  const leadInitial = esc((name.trim().charAt(0) || '?').toUpperCase());
  const coach = (state.settings && state.settings.settings && state.settings.settings.coach_name || '').trim();
  const youInitial = esc((coach.charAt(0) || 'Y').toUpperCase());

  // Collapse stage events to one "Chat moved to: X" marker per instant (the
  // furthest stage reached then), dropping the initial 'lead' event.
  const byTime = {};
  (state.thread.stage_events || []).forEach((e) => {
    if (!byTime[e.at] || STAGES.indexOf(e.stage) > STAGES.indexOf(byTime[e.at])) byTime[e.at] = e.stage;
  });
  const markers = Object.keys(byTime).filter((at) => byTime[at] !== 'lead')
    .map((at) => ({ at, kind: 'stage', stage: byTime[at] }));

  // Merge messages + markers on one timeline (a message precedes a same-instant marker).
  const items = msgs.map((m) => ({ at: m.created_at, kind: 'msg', m })).concat(markers)
    .sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : (a.kind === 'msg' ? -1 : 1));

  let html = '', lastDay = '';
  items.forEach((it, i) => {
    const day = dayLabel(it.at);
    if (day && day !== lastDay) { html += '<div class="msg-day">' + day + '</div>'; lastDay = day; }
    if (it.kind === 'stage') {
      html += '<div class="msg-day msg-stage">Chat moved to: ' + STAGE_ONE[it.stage] + '</div>';
      return;
    }
    const m = it.m;
    const isMedia = (m.att_type === 'image' || m.att_type === 'video');
    if (m.role === 'lead') {
      html += '<div class="msg-row lead"><div class="msg-av">' + leadInitial + '</div>' +
        '<div class="msg"><div class="msg-meta"><span>' + esc(name) + '</span><span>' + timeFmt(m.created_at) + '</span></div>' +
        '<div class="msg-bubble' + (isMedia ? ' media' : '') + '">' + msgBubbleInner(m) + '</div></div></div>';
    } else {
      const isAi = m.source === 'ai';
      // Delivery timestamps are not read receipts; do not claim the lead has seen a message.
      html += '<div class="msg-row setter"><div class="msg-av you">' + youInitial + '</div>' +
        '<div class="msg"><div class="msg-meta">' + (isAi ? '<span class="ai-tag">AI</span>' : '') +
        '<span>' + timeFmt(m.created_at) + '</span><span>You</span></div>' +
        '<div class="msg-bubble' + (isAi ? ' ai-sent' : '') + (isMedia ? ' media' : '') + '">' + msgBubbleInner(m) + '</div>' + '</div></div>';
    }
  });
  box.innerHTML = html || '<div class="thread-empty" style="flex:none;padding:40px 20px"><div class="icon-chip">' + icon('send', 20) + '</div>No messages yet &mdash; open the conversation with a first DM.</div>';
  if (nearBottom) box.scrollTop = box.scrollHeight;
}
function renderDraftZone() {
  const zone = $('#draft-zone');
  if (!zone || !state.thread) return;
  const d = state.thread.pending_draft;
  if (!d) { zone.innerHTML = ''; return; }
  zone.innerHTML = '<div class="draft-card">' +
    '<div class="draft-card-head">' + icon('bot', 16) + '<span class="dc-title">AI draft</span>' +
    (d.stage_suggestion ? '<span class="tag indigo">&rarr; ' + STAGE_ONE[d.stage_suggestion] + '</span>' : '') + '</div>' +
    (d.needs_human ? '<div class="draft-reason">' + icon('alert', 13) + esc(d.reason || 'Needs your review') + '</div>' : '') +
    d.messages.map((m, i) => '<textarea data-dmsg="' + i + '">' + esc(m) + '</textarea>').join('') +
    '<div class="draft-actions"><button class="btn btn-primary btn-sm" id="approve-btn">' + icon('check', 14) + 'Approve &amp; send</button>' +
    '<button class="btn btn-ghost btn-sm" id="discard-btn">Discard</button></div></div>';
  $('#approve-btn').addEventListener('click', async () => {
    const msgs = Array.from(zone.querySelectorAll('[data-dmsg]')).map((t) => t.value.trim()).filter(Boolean);
    try {
      await api('/api/drafts/' + d.id + '/approve', { method: 'POST', body: { messages: msgs } });
      toast('Sent to the lead');
      await loadThread(state.activeId); loadConvs(); refreshBadge();
    } catch (e) {
      toast(e.status === 422 ? 'Blocked by the outbound filter — flagged for review' : e.message, 'err');
      await loadThread(state.activeId);
    }
  });
  $('#discard-btn').addEventListener('click', async () => {
    if (!confirm('Discard this draft? It will be removed without sending.')) return;
    try { await api('/api/drafts/' + d.id + '/discard', { method: 'POST' }); await loadThread(state.activeId); loadConvs(); refreshBadge(); }
    catch (e) { toast(e.message, 'err'); }
  });
}
function wireThread() {
  const c = state.thread.conversation;
  const isSim = c.channel === 'sim';
  const details=$('#info-toggle'); if(details)details.onclick=()=>{state.infoOpen=true;renderProspect();$('#pane-info').classList.add('info-open');$('#info-close')?.focus();};
  const mobileBack = $('#mobile-back');
  if (mobileBack) mobileBack.addEventListener('click', () => {
    state.activeId = null; state.thread = null;
    $('#view-messages').classList.remove('thread-open');
    renderConvList(); renderThread();
  });
  const handled = $('#handled-btn');
  if (handled) handled.addEventListener('click', async () => {
    try { await api('/api/conversations/' + c.id, { method: 'PATCH', body: { needs_human: false } }); toast('Marked handled'); await loadThread(c.id); loadConvs(); }
    catch (e) { toast(e.message, 'err'); }
  });
  if (isSim) $('#pane-thread').querySelectorAll('[data-as]').forEach((b) => b.addEventListener('click', () => {
    state.composeAs = b.dataset.as;
    $('#pane-thread').querySelectorAll('[data-as]').forEach((x) => x.classList.toggle('on', x.dataset.as === state.composeAs));
    $('#composer-input').placeholder = state.composeAs === 'lead' ? 'Type what the lead says…' : 'Message @' + c.handle;
  }));
  $('#ai-response-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.innerHTML = icon('spark', 15) + 'Thinking…';
    try {
      await api('/api/conversations/' + c.id + '/request-draft', { method: 'POST' });
      await loadThread(c.id); refreshBadge();
    } catch (err) {
      toast(err.status === 409 ? 'The kill switch is on — AI drafting is paused' : err.message, 'err');
      const b2 = $('#ai-response-btn');
      if (b2) { b2.disabled = false; b2.innerHTML = icon('bot', 16) + 'AI Response'; }
    }
  });
  async function sendComposer() {
    const inp = $('#composer-input');
    const text = inp.value.trim();
    if (!text) return;
    inp.value = '';
    try {
      if (isSim && state.composeAs === 'lead') {
        await api('/api/conversations/' + c.id + '/lead-message', { method: 'POST', body: { text } });
      } else {
        await api('/api/conversations/' + c.id + '/send', { method: 'POST', body: { text } });
      }
      await loadThread(c.id); loadConvs();
    } catch (e) {
      if (e.status !== 422) inp.value = text;
      toast(e.status === 422 ? 'Blocked by the outbound filter — flagged for review' : e.message, 'err');
      if (e.status === 422) loadThread(c.id);
    }
  }
  $('#send-btn').addEventListener('click', sendComposer);
  $('#composer-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendComposer(); } });
  $('#slots-btn').addEventListener('click', () => {
    const slots = ((state.settings && state.settings.settings && state.settings.settings.call_slots) || '').trim();
    if (!slots) return toast('No call slots configured — add them on the Prompt page', 'err');
    const inp = $('#composer-input');
    inp.value = (inp.value + ' ' + slots).trim();
    inp.focus();
  });
  const voiceBtn = $('#voice-btn');
  if (voiceBtn) voiceBtn.addEventListener('click', () => toast('Voice notes send from a connected Instagram account', 'err'));
  $('#insert-btn').addEventListener('click', () => {
    const holder = $('#insert-pop-holder');
    if (holder.innerHTML) { holder.innerHTML = ''; return; }
    const s = (state.settings && state.settings.settings) || {};
    const items = [
      { l: 'Guide link', v: (s.guide_link || '').trim() },
      { l: 'Community link', v: (s.community_link || '').trim() },
      { l: 'Call slots', v: (s.call_slots || '').trim() },
    ];
    holder.innerHTML = '<div class="insert-pop">' + items.map((it, i) =>
      '<button data-ins="' + i + '"' + (it.v ? '' : ' disabled') + '>' + it.l + (it.v ? '' : ' — not set') + '</button>'
    ).join('') + '</div>';
    holder.querySelectorAll('[data-ins]').forEach((b) => b.addEventListener('click', () => {
      const inp = $('#composer-input');
      inp.value = (inp.value + ' ' + items[Number(b.dataset.ins)].v).trim();
      holder.innerHTML = ''; inp.focus();
    }));
  });
}
function renderProspect() {
  const pane = $('#pane-info');
  if (!pane || !state.thread || !state.activeId) return;
  if (pane.contains(document.activeElement) && ['INPUT', 'SELECT'].includes(document.activeElement.tagName)) return;
  const c = state.thread.conversation;
  const auto = c.mode === 'autopilot';
  const noteText = c.needs_human
    ? 'Flagged for review: ' + (c.needs_human_reason || 'manual attention required')
    : STAGE_ONE[c.stage] + ' conversation · ' + (auto ? 'AI is handling replies' : 'manual or copilot handling');
  pane.innerHTML =
    '<div class="prospect-top">' +
    '<div class="prospect-av-wrap">' + avatarHtml(c.handle, c.display_name, 64) + '</div>' +
    '<div class="p-name">' + esc(c.display_name || c.handle) + '</div>' +
    '<div class="p-handle">@' + esc(c.handle) + '</div>' +
    '<div class="follow-lines">' + (c.channel === 'sim' ? 'Simulator conversation' : 'Instagram DM') +
    (c.needs_human ? '<br><b style="color:var(--red)">Flagged for review</b>' : '') + '</div>' +
    '<div class="prospect-stage-row">' + stageBadge(c.stage) +
    '<select id="stage-sel">' + STAGES.map((s) => '<option value="' + s + '"' + (c.stage === s ? ' selected' : '') + '>' + STAGE_ONE[s] + '</option>').join('') + '</select>' +
    '</div>' +
    (c.call_time ? '<div class="follow-lines" style="margin-top:6px;display:flex;align-items:center;justify-content:center;gap:5px">' + icon('calendar', 13) + '<span>Call: ' + esc(callTimeFmt(c.call_time)) + '</span></div>' : '') +
    '</div>' +

    '<div class="autopilot-row"><span class="ar-label">Autopilot</span>' + switchHtml(auto, '', 'id="auto-switch"') + '</div>' +
    '<div class="info-divider"></div>' +

    '<div class="info-section-title">Prospect Info</div>' +
    '<div class="info-card">' +
    '<div class="info-hint" style="margin:0 0 6px">First name — used for {{FIRST_NAME}} in outgoing messages</div>' +
    '<div class="name-row"><input id="fname-input" placeholder="First name" value="' + esc(c.display_name || '') + '"></div>' +
    '<div class="draft-actions" style="margin-top:8px"><button class="btn btn-primary btn-sm" id="fname-save">Save</button></div></div>' +

    '<div class="info-section-title">Conversation status</div>' +
    '<div class="info-card"><div class="info-hint">' + esc(noteText) + '</div></div>' +

    '<div class="info-card"><div class="ic-title">AI mode</div>' +
    '<select id="mode-sel">' +
    ['copilot|Copilot — AI drafts, you approve', 'autopilot|Autopilot — AI sends automatically', 'off|Off — full manual takeover'].map((o) => {
      const p = o.split('|');
      return '<option value="' + p[0] + '"' + (c.mode === p[0] ? ' selected' : '') + '>' + p[1] + '</option>';
    }).join('') + '</select>' +
    (c.stage === 'dead' ? '<button class="btn btn-ghost btn-sm" id="revive-btn" style="width:100%;margin-top:10px">' + icon('refresh', 14) + 'Revive conversation</button>' : '') +
    (c.stage === 'call_booked' ? '<label class="fp-row"><input type="checkbox" id="fp-check"' + (c.false_positive ? ' checked' : '') + '>Mark as false positive</label>' : '') +
    '<div class="info-hint">Call Booked and Sale are yours to confirm — the AI can only suggest them.</div></div>' +

    '<div class="info-card"><div class="ic-title">Follow-ups</div>' +
    '<div class="info-row"><span class="ir-label">' + c.followup_count + ' sent</span>' +
    (c.next_followup_at ? '<span class="tag amber">' + timeFmt(c.next_followup_at) + '</span>' : '<span class="tag">none queued</span>') + '</div>' +
    '<div class="info-hint">Follow-ups use your configured timings and sequences. Check your script and settings to adjust them.</div></div>';

  $('#stage-sel').addEventListener('change', async (e) => {
    const stage = e.target.value;
    if ((stage === 'call_booked' || stage === 'sale') &&
        !confirm('Confirm ' + STAGE_ONE[stage] + '? This is the human confirmation the AI is never allowed to make.')) {
      e.target.value = c.stage; return;
    }
    try { await api('/api/conversations/' + c.id, { method: 'PATCH', body: { stage } }); toast('Stage updated'); await loadThread(c.id); loadConvs(); }
    catch (err) { toast(err.message, 'err'); e.target.value = c.stage; }
  });
  const revive = $('#revive-btn');
  if (revive) revive.addEventListener('click', async () => {
    try { await api('/api/conversations/' + c.id, { method: 'PATCH', body: { revive: true } }); toast('Revived to Qualifying'); await loadThread(c.id); loadConvs(); }
    catch (e) { toast(e.message, 'err'); }
  });
  const fp = $('#fp-check');
  if (fp) fp.addEventListener('change', async (e) => {
    try { await api('/api/conversations/' + c.id, { method: 'PATCH', body: { false_positive: e.target.checked } }); toast('Updated'); }
    catch (err) { toast(err.message, 'err'); e.target.checked = !e.target.checked; }
  });
  $('#auto-switch').querySelector('input').addEventListener('change', async (e) => {
    try { await api('/api/conversations/' + c.id, { method: 'PATCH', body: { mode: e.target.checked ? 'autopilot' : 'copilot' } }); await loadThread(c.id); loadConvs(); }
    catch (err) { toast(err.message, 'err'); }
  });
  $('#mode-sel').addEventListener('change', async (e) => {
    try { await api('/api/conversations/' + c.id, { method: 'PATCH', body: { mode: e.target.value } }); await loadThread(c.id); loadConvs(); }
    catch (err) { toast(err.message, 'err'); }
  });
  $('#fname-save').addEventListener('click', async () => {
    try { await api('/api/conversations/' + c.id, { method: 'PATCH', body: { display_name: $('#fname-input').value } }); toast('Saved'); await loadThread(c.id); loadConvs(); }
    catch (e) { toast(e.message, 'err'); }
  });
}

const renderProspectBase=renderProspect;
renderProspect=function(){
  renderProspectBase();const pane=$('#pane-info');if(!pane || !state.activeId)return;
  pane.classList.toggle('info-open',state.infoOpen);
  if(pane.querySelector('#info-close'))return;
  const close=document.createElement('button');close.id='info-close';close.className='btn btn-ghost info-close';close.textContent='Close details';
  close.onclick=()=>{state.infoOpen=false;pane.classList.remove('info-open');$('#info-toggle')?.focus();};pane.prepend(close);
};
document.addEventListener('keydown',e=>{if(e.key==='Escape' && state.infoOpen){state.infoOpen=false;$('#pane-info')?.classList.remove('info-open');$('#info-toggle')?.focus();}});

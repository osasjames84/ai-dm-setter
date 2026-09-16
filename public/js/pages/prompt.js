'use strict';
/* ============================== prompt (AI Script) ============================== */
/* Safe JSON parse with a typed default (never throws). */
function safeParse(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  try { const v = JSON.parse(raw); return v == null ? fallback : v; } catch (e) { return fallback; }
}
/* A muted toast for the display-only affordances (uploads / voice notes). */
function notEnabledToast(what) { toast(what + ' isn’t enabled on this server yet.', 'err'); }

/* Build state.script from the (all-string) settings blob. */
function initScriptState(s) {
  const kt = safeParse(s.keyword_trigger, {});
  state.script = {
    coach_name: s.coach_name || '',
    prompt_persona: s.prompt_persona || '',
    about_you: s.about_you || '',
    prompt_offer: s.prompt_offer || '',
    client_results: s.client_results || '',
    prompt_voice: s.prompt_voice || s.style || '',
    prompt_qualification: s.prompt_qualification || '',
    prompt_booking: s.prompt_booking || '',
    prompt_routing: s.prompt_routing || '',
    call_slots: s.call_slots || '',
    guide_link: s.guide_link || '',
    community_link: s.community_link || '',
    prompt_objections: s.prompt_objections || '',
    prompt_followup: s.prompt_followup || '',
    prompt_hard_rules: s.prompt_hard_rules || '',
    prompt_custom: s.prompt_custom || '',
    call_booked_vsl: s.call_booked_vsl || '',
    reactions_enabled: s.reactions_enabled === '1',
    objection_handlers: (safeParse(s.objection_handlers, []) || []).map((o) => ({ trigger: o.trigger || '', reply: o.reply || '' })),
    reaction_rules: (safeParse(s.reaction_rules, []) || []).map((r) => String(r)),
    audio_arsenal: (safeParse(s.audio_arsenal, []) || []).map((a) => ({ phrase: a.phrase || '', audio_id: a.audio_id || '' })),
    manual_voice: (safeParse(s.manual_voice, []) || []).map((m) => ({ label: m.label || '' })),
    ai_on_phrases: (safeParse(s.ai_on_phrases, []) || []).map((p) => String(p)),
    seq_lead: normFups(safeParse(s.seq_lead, [])),
    seq_qualification: normFups(safeParse(s.seq_qualification, [])),
    seq_booking: normFups(safeParse(s.seq_booking, [])),
    keyword_trigger: {
      mode: kt.mode === 'audio' ? 'audio' : 'text',
      keywords: kt.keywords || '',
      initial_message: kt.initial_message || '',
      delay_min: kt.delay_min || '',
      delay_max: kt.delay_max || '',
      follow_ups: normFups(kt.follow_ups),
    },
  };
  // Match SetDM's default UI: one blank objection row + one blank arsenal/voice entry.
  if (!state.script.objection_handlers.length) state.script.objection_handlers.push({ trigger: '', reply: '' });
  if (!state.script.audio_arsenal.length) state.script.audio_arsenal.push({ phrase: '' });
  if (!state.script.manual_voice.length) state.script.manual_voice.push({ label: '' });
}
function normFups(arr) {
  return (Array.isArray(arr) ? arr : []).map((f) => {
    f = f || {};
    const kind = f.kind === 'audio' ? 'audio' : 'text';
    const message = f.message != null ? String(f.message) : (Array.isArray(f.variants) && f.variants[0] != null ? String(f.variants[0]) : '');
    const unit = ['minutes', 'hours', 'days'].includes(f.unit) ? f.unit : 'hours';
    const dmin = (f.delay_min != null && f.delay_min !== '') ? String(f.delay_min) : (f.delay_hours != null ? String(f.delay_hours) : '');
    const dmax = (f.delay_max != null && f.delay_max !== '') ? String(f.delay_max) : dmin;
    return { kind, message, variation: !!f.variation, audio_id: f.audio_id || '', delay_min: dmin, delay_max: dmax, unit };
  });
}

/* Section card shell (accented, collapsible). */
function scriptCard(id, title, sub, ic, acc, bodyHtml, extraTitle) {
  const open = state.promptOpen[id];
  const dot = extraTitle && extraTitle.dot ? '<span class="dot-title" style="background:' + acc.fg + '"></span>' : '';
  return '<div class="script-card accent' + (open ? ' open' : '') + '" data-sec="' + id + '" ' +
    'style="--acc-border:' + acc.border + ';--acc-bg:' + acc.bg + ';--acc-fg:' + acc.fg + '">' +
    '<div class="script-card-head">' +
    (ic ? '<div class="icon-chip" style="width:20px;height:20px;background:transparent">' + icon(ic, 18) + '</div>' : dot) +
    '<div class="sc-titles"><div class="sc-title">' + title + '</div><div class="sc-sub">' + sub + '</div></div>' +
    '<span class="chev">' + icon('chevdown', 17) + '</span></div>' +
    '<div class="script-card-body">' + bodyHtml + '</div></div>';
}
/* Accent presets keyed by colour name. */
const ACC = {
  blue:   { border: 'rgba(96,165,250,.28)',  bg: 'rgba(96,165,250,.05)',  fg: 'var(--blue)' },
  purple: { border: 'rgba(167,139,250,.28)', bg: 'rgba(167,139,250,.05)', fg: 'var(--purple)' },
  pink:   { border: 'rgba(244,114,182,.28)', bg: 'rgba(244,114,182,.05)', fg: 'var(--pink)' },
  red:    { border: 'rgba(248,113,113,.28)', bg: 'rgba(248,113,113,.05)', fg: 'var(--red)' },
  green:  { border: 'rgba(52,211,153,.28)',  bg: 'rgba(52,211,153,.05)',  fg: 'var(--green)' },
  orange: { border: 'rgba(245,158,11,.32)',  bg: 'rgba(245,158,11,.05)',  fg: 'var(--orange)' },
  indigo: { border: 'rgba(109,109,240,.32)', bg: 'rgba(90,103,242,.05)',  fg: '#8b8bf5' },
};
const audioBtns = '<span class="set-help">Audio replies are not available here.</span>';

/* Custom voice-note player: play/pause + a scrubber that fills and a countdown of
   time remaining, so you can see (and scrub) a recorded clip. Init'd by initVnPlayers. */
function vnPlayer(src) {
  return '<span class="vn" data-vn="' + esc(src) + '">' +
    '<button type="button" class="vn-btn" data-vn-play aria-label="Play voice note">' +
      '<svg class="i-play" width="10" height="11" viewBox="0 0 10 11" fill="currentColor"><path d="M0 0l10 5.5L0 11z"/></svg>' +
      '<svg class="i-pause" width="9" height="11" viewBox="0 0 9 11" fill="currentColor"><rect width="3" height="11" rx="1"/><rect x="6" width="3" height="11" rx="1"/></svg>' +
    '</button>' +
    '<span class="vn-track" data-vn-track><span class="vn-fill"></span></span>' +
    '<span class="vn-time" data-vn-time>0:00</span>' +
  '</span>';
}
let _vnCur = null; // the single voice-note currently playing (only one at a time)
function initVnPlayers(root) {
  (root || document).querySelectorAll('.vn:not([data-vn-init])').forEach((el) => {
    el.dataset.vnInit = '1';
    const btn = el.querySelector('[data-vn-play]'), track = el.querySelector('[data-vn-track]');
    const fill = el.querySelector('.vn-fill'), timeEl = el.querySelector('[data-vn-time]');
    const audio = new Audio(); audio.preload = 'metadata'; audio.src = el.getAttribute('data-vn');
    const fmt = (s) => { s = Math.max(0, Math.round(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
    const dur = () => (isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0);
    const paint = () => { const d = dur(); fill.style.width = (d ? (audio.currentTime / d * 100) : 0) + '%'; timeEl.textContent = fmt(d ? d - audio.currentTime : 0); };
    audio.addEventListener('loadedmetadata', paint);
    audio.addEventListener('timeupdate', paint);
    audio.addEventListener('ended', () => { btn.classList.remove('playing'); audio.currentTime = 0; paint(); _vnCur = null; });
    btn.addEventListener('click', () => {
      if (audio.paused) {
        if (_vnCur && _vnCur.audio !== audio) { _vnCur.audio.pause(); _vnCur.btn.classList.remove('playing'); }
        audio.play().then(() => { btn.classList.add('playing'); _vnCur = { audio, btn }; }).catch(() => toast('Could not play clip', 'err'));
      } else { audio.pause(); btn.classList.remove('playing'); _vnCur = null; }
    });
    track.addEventListener('click', (e) => {
      const d = dur(); if (!d) return;
      const r = track.getBoundingClientRect();
      audio.currentTime = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * d; paint();
    });
  });
}

/* Audio Arsenal row: record / upload / player / clear, wired to /api/voice. */
function arsenalAudio(a, i) {
  const has = a.audio_id && String(a.audio_id).trim();
  const player = has
    ? vnPlayer('/api/attachments/' + encodeURIComponent(a.audio_id))
    : '<span class="kb-hint">no clip yet</span>';
  return '<div class="audio-reply-row"><span class="audio-lbl">' + icon('volume', 14) + 'Audio reply:</span>' +
    '<button type="button" class="mini-btn" data-arsaudio="record" data-ai="' + i + '">' + icon('mic', 15) + (has ? 'Re-record' : 'Record') + '</button>' +
    '<button type="button" class="mini-btn" data-arsaudio="upload" data-ai="' + i + '">' + icon('upload', 15) + 'Upload</button>' +
    player +
    (has ? '<button type="button" class="mini-btn" data-arsaudio="clear" data-ai="' + i + '" title="Remove clip">' + icon('x', 14) + '</button>' : '') +
    '</div>';
}
let _arsRec = null; // active in-browser recording session
// Audio capture generalized over a target: `apply(id)` writes the stored clip id
// wherever it belongs (an arsenal row or a follow-up step).
function arsenalAudioAction(b) {
  const i = +b.dataset.ai, act = b.dataset.arsaudio;
  audioAction(act, b, (id) => { const r = state.script.audio_arsenal[i]; if (r) r.audio_id = id; });
}
function fupAudioAction(b) {
  const scope = b.dataset.fup, fi = +b.dataset.fi, act = b.dataset.fupaudio;
  audioAction(act, b, (id) => { const arr = fupArrFor(scope); const r = arr && arr[fi]; if (r) r.audio_id = id; });
}
function audioAction(act, btn, apply) {
  if (act === 'clear') { syncScriptFromDom(); apply(''); markScriptDirty(); renderScriptWorkspace(); return; }
  if (act === 'upload') {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'audio/*';
    inp.addEventListener('change', () => { if (inp.files[0]) uploadVoiceBlob(inp.files[0], apply); });
    inp.click();
    return;
  }
  if (act === 'record') toggleRecord(btn, apply);
}
async function toggleRecord(btn, apply) {
  if (_arsRec) { _arsRec.mr.stop(); return; }                       // second click stops
  if (!navigator.mediaDevices || !window.MediaRecorder) { toast('Recording not supported here — use Upload', 'err'); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { toast('Microphone blocked — allow access or use Upload', 'err'); return; }
  const pref = ['audio/mp4', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t));
  const mr = new MediaRecorder(stream, pref ? { mimeType: pref } : undefined);
  const chunks = [];
  mr.addEventListener('dataavailable', (e) => { if (e.data && e.data.size) chunks.push(e.data); });
  mr.addEventListener('stop', () => {
    stream.getTracks().forEach((t) => t.stop());
    _arsRec = null;
    const type = mr.mimeType || 'audio/webm';
    const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
    uploadVoiceBlob(new File(chunks, 'note.' + ext, { type }), apply);
  });
  _arsRec = { mr };
  mr.start();
  btn.innerHTML = icon('mic', 15) + 'Stop ●'; btn.classList.add('recording');
}
async function uploadVoiceBlob(file, apply) {
  const fd = new FormData(); fd.append('file', file);
  try {
    const res = await sessionFetch('/api/voice', { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'upload failed');
    syncScriptFromDom();
    apply(data.id);
    markScriptDirty();
    renderScriptWorkspace();
    toast('Voice note saved — hit Save to keep it');
  } catch (e) { toast(e.message, 'err'); }
}

/* Insert {{FIRST_NAME}} at the cursor of this row's focused variant (else the first). */
function insertFirstName(b) {
  const scope = b.dataset.fupName, fi = +b.dataset.fi, card = b.closest('.fup-card');
  const ta = card ? card.querySelector('.fup-msg-ta') : null;
  if (!ta) return;
  const tag = '{{FIRST_NAME}}';
  const s = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
  const e = ta.selectionEnd != null ? ta.selectionEnd : ta.value.length;
  ta.value = ta.value.slice(0, s) + tag + ta.value.slice(e);
  ta.focus(); ta.selectionStart = ta.selectionEnd = s + tag.length;
  const r = (fupArrFor(scope) || [])[fi];
  if (r) r.message = ta.value;
  markScriptDirty();
}

/* A follow-up editor list (shared by Keyword Trigger + Core Sequences):
   Text/Audio, message variants, {{FIRST_NAME}} insert, min→max delay + unit. */
function fupListHtml(scope) {
  const arr = fupArrFor(scope);
  if (!arr.length) return '<div class="dashed-empty">No follow-ups yet. Click "Add" to create one.</div>';
  return '<div class="fup-list">' + arr.map((f, i) => fupRowHtml(scope, i, f)).join('') + '</div>';
}
function fupRowHtml(scope, i, f) {
  const isAudio = f.kind === 'audio';
  const seg = '<div class="fup-kind">' +
    '<button type="button" class="fseg' + (!isAudio ? ' on' : '') + '" data-fupkind="text" data-fup="' + scope + '" data-fi="' + i + '">' + icon('chats', 13) + 'Text</button>' +
    '<button type="button" class="fseg' + (isAudio ? ' on' : '') + '" data-fupkind="audio" data-fup="' + scope + '" data-fi="' + i + '">' + icon('volume', 13) + 'Audio</button>' +
    '</div>';
  const tools = isAudio ? '' : '<div class="fup-tools">' +
    '<button type="button" class="mini-btn' + (f.variation ? ' on' : '') + '" data-fup-variation="' + scope + '" data-fi="' + i + '" title="AI rewords this each send so it doesn\'t look copy-pasted">' + icon('shuffle', 13) + 'Variation' + (f.variation ? ' · on' : '') + '</button>' +
    '<button type="button" class="mini-btn" data-fup-name="' + scope + '" data-fi="' + i + '">Insert First Name</button>' +
    '</div>';
  const body = isAudio ? fupAudioControls(scope, i, f)
    : '<textarea class="fup-msg-ta" data-fup="' + scope + '" data-fi="' + i + '" data-fk="message" placeholder="Follow-up message…">' + esc(f.message) + '</textarea>' +
      '<div class="fup-hint">Use <code>{{FIRST_NAME}}</code> to insert their first name when we have it from the chat; otherwise the tag is removed.' +
      (f.variation ? ' <b>Variation is on</b> — the AI rewords this each send.' : '') + '</div>';
  const delay = '<div class="fup-delay"><span class="fw-label">Send after:</span>' +
    '<input type="number" min="0" class="fw-num" data-fup="' + scope + '" data-fi="' + i + '" data-fk="delay_min" value="' + esc(f.delay_min) + '">' +
    '<span class="fw-to">to</span>' +
    '<input type="number" min="0" class="fw-num" data-fup="' + scope + '" data-fi="' + i + '" data-fk="delay_max" value="' + esc(f.delay_max) + '">' +
    '<select class="fw-unit-sel" data-fup="' + scope + '" data-fi="' + i + '" data-fk="unit">' +
      ['minutes', 'hours', 'days'].map((u) => '<option value="' + u + '"' + (f.unit === u ? ' selected' : '') + '>' + u + '</option>').join('') +
    '</select></div>';
  return '<div class="fup-card">' +
    '<div class="fup-card-top">' + seg +
      '<div class="fup-top-right">' + tools +
        '<button type="button" class="row-x fup-remove" data-fup-x="' + scope + '" data-fi="' + i + '">' + icon('x', 15) + '</button>' +
      '</div></div>' +
    body + delay + '</div>';
}
function fupAudioControls(scope, i, f) {
  const has = f.audio_id && String(f.audio_id).trim();
  const player = has ? vnPlayer('/api/attachments/' + encodeURIComponent(f.audio_id)) : '<span class="kb-hint">no clip yet</span>';
  return '<div class="audio-reply-row"><span class="audio-lbl">' + icon('volume', 14) + 'Voice note:</span>' +
    '<button type="button" class="mini-btn" data-fupaudio="record" data-fup="' + scope + '" data-fi="' + i + '">' + icon('mic', 15) + (has ? 'Re-record' : 'Record') + '</button>' +
    '<button type="button" class="mini-btn" data-fupaudio="upload" data-fup="' + scope + '" data-fi="' + i + '">' + icon('upload', 15) + 'Upload</button>' +
    player +
    (has ? '<button type="button" class="mini-btn" data-fupaudio="clear" data-fup="' + scope + '" data-fi="' + i + '">' + icon('x', 14) + '</button>' : '') +
    '</div>';
}
function fupArrFor(scope) {
  return scope === 'kw' ? state.script.keyword_trigger.follow_ups : state.script[scope];
}

function renderPrompt() {
  const s = state.settings && state.settings.settings;
  if (!s) return;
  initScriptState(s);
  const page = $('#prompt-page');
  page.innerHTML = '<div class="prompt-grid"><div class="script-workspace">' +
    '<div class="workspace-head"><h1>AI Script</h1><div style="display:flex;gap:8px;align-items:center"><button class="btn btn-primary is-saved" id="script-save">Saved</button></div></div>' +
    '<div class="script-scroll"><div class="script-intro">Everything the AI says comes from what you write here. Review every section before enabling automation.</div>' +
    '<div id="script-tools"></div><div class="script-col" id="script-col"></div></div></div>' +

    '<div class="preview-panel">' +
    '<div class="preview-head"><div class="preview-head-row"><div class="icon-chip" style="width:36px;height:36px;background:var(--indigo);color:#fff">' + icon('spark', 16) + '</div>' +
    '<div class="preview-head-copy"><div class="pv-title">AI Preview</div><div class="pv-sub">Same path as live DMs</div></div>' +
    '<div class="preview-ctl"><select id="pv-stage">' + STAGES.slice(0, 5).map((st) =>
      '<option value="' + st + '"' + (state.preview.stage === st ? ' selected' : '') + '>' + STAGE_ONE[st] + '</option>').join('') + '</select></div></div></div>' +
    '<div class="preview-msgs" id="pv-msgs"></div>' +
    '<div class="preview-composer"><div class="composer">' +
    '<input id="pv-input" placeholder="Type a message…">' +
    '<button class="send-btn" id="pv-send" style="width:34px;height:34px">' + icon('send', 14) + '</button>' +
    '</div></div></div></div>';

  renderScriptWorkspace();

  $('#script-save').addEventListener('click', saveScript);
  state.scriptDirty = false;
  const scriptCol = $('#script-col');
  scriptCol.addEventListener('input', markScriptDirty);
  scriptCol.addEventListener('change', markScriptDirty);
  $('#pv-stage').addEventListener('change', (e) => { state.preview.stage = e.target.value; });
  $('#pv-send').addEventListener('click', sendPreview);
  $('#pv-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendPreview(); });
  renderPreviewMsgs();
  mountScriptTools();
}

/* Pull every live DOM value into state.script (called before any re-render). */
function syncScriptFromDom() {
  const col = $('#script-col');
  if (!col) return;
  col.querySelectorAll('[data-sk]').forEach((el) => { state.script[el.dataset.sk] = el.value; });
  col.querySelectorAll('[data-obj]').forEach((el) => {
    const row = state.script.objection_handlers[+el.dataset.oi];
    if (row) row[el.dataset.obj] = el.value;
  });
  col.querySelectorAll('[data-rule]').forEach((el) => { state.script.reaction_rules[+el.dataset.ri] = el.value; });
  col.querySelectorAll('[data-arsenal]').forEach((el) => {
    const row = state.script.audio_arsenal[+el.dataset.ai];
    if (row) row.phrase = el.value;
  });
  col.querySelectorAll('[data-manual]').forEach((el) => {
    const row = state.script.manual_voice[+el.dataset.mi];
    if (row) row.label = el.value;
  });
  col.querySelectorAll('[data-phrase]').forEach((el) => { state.script.ai_on_phrases[+el.dataset.pi] = el.value; });
  col.querySelectorAll('[data-kt]').forEach((el) => { state.script.keyword_trigger[el.dataset.kt] = el.value; });
  col.querySelectorAll('[data-fup][data-fk]').forEach((el) => {
    const arr = fupArrFor(el.dataset.fup); const row = arr && arr[+el.dataset.fi];
    if (row) row[el.dataset.fk] = el.value;
  });
}

function renderScriptWorkspace() {
  const col = $('#script-col');
  const sc = state.script;

  // 1. Coach Name (always-open, first-child styling removes chevron)
  const coach = '<div class="card script-card open" data-sec="coach">' +
    '<div class="script-card-head"><div class="sc-titles"><div class="sc-title">Sender name</div>' +
    '<div class="sc-sub">The AI texts as this person. Whether it ever mentions being an AI is up to your Hard Rules.</div></div></div>' +
    '<div class="script-card-body"><input data-sk="coach_name" placeholder="Name customers know you by" value="' + esc(sc.coach_name) + '"></div></div>';

  // 2. Knowledge base (display-only)
  const kb = scriptCard('kb', 'Knowledge base',
    'Upload PDF, Word (.docx), or text files. With RAG enabled on the server, the AI can use them in DMs and the prompt test.',
    'filetext', ACC.blue,
    '<div class="kb-uploadrow"><button type="button" class="mini-btn" id="kb-upload">' + icon('upload', 15) + 'Upload documents</button>' +
    '<input type="file" id="kb-file" accept=".pdf,.docx,.txt,.md" style="display:none">' +
    '<span class="kb-hint">PDF, .docx, or .txt — up to 50 files, 25MB each</span></div>' +
    '<div class="kb-list" id="kb-list"><div class="kb-empty">No documents yet.</div></div>');

  // 3. Your prompt — every section is optional and written entirely by the owner.
  const ta = (key, rows, ph) => '<textarea data-sk="' + key + '" rows="' + rows + '" placeholder="' + esc(ph) + '">' + esc(sc[key]) + '</textarea><div data-check-for="' + key + '"></div>';
  const inp = (key, ph) => '<input data-sk="' + key + '" placeholder="' + esc(ph) + '" value="' + esc(sc[key]) + '">';
  const persona = scriptCard('persona', 'Character & Personality', 'Who the AI is when it texts — attitude, personality, how it treats people', 'wand', ACC.purple,
    '<div class="field-label">Personality</div>' +
    ta('prompt_persona', 6, 'Describe the character you want the AI to be. Nothing is built in — write it exactly how you want it to come across.') +
    '<div class="field-label">About You</div>' +
    ta('about_you', 4, 'Background the AI can draw on: who you are, what you do, your experience.'));
  const offer = scriptCard('offer', 'Offer & Social Proof', 'What you sell, who it is for, and the results you want the AI to be able to cite', 'filetext', ACC.blue,
    '<div class="field-label">Offer & Context</div>' +
    ta('prompt_offer', 6, 'Your offer, who it serves, how it is delivered, and any context the AI should know.') +
    '<div class="field-label">Client Results</div>' +
    ta('client_results', 4, 'Real results only, one per line.') +
    '<p class="sc-help">The AI can only cite results listed here. How and when it uses them is up to your prompt.</p>');
  const voice = scriptCard('voice', 'Texting Style', 'Tone, length, punctuation, emoji habits — how your messages should read', 'chats', ACC.green,
    ta('prompt_voice', 6, 'Describe how you text: tone, message length, casing, punctuation, emoji use, anything to avoid.'));
  const qual = scriptCard('qual', 'Qualification Sequence', 'How the AI qualifies a lead — your questions, your order, your criteria', 'target', ACC.orange,
    ta('prompt_qualification', 8, 'Describe how a lead should be qualified: what to ask, in what order, what makes someone qualified or not, and what to do in each case.'));
  const book = scriptCard('book', 'Next-step sequence', 'How the AI guides a qualified customer to the next step', 'calendar', ACC.pink,
    ta('prompt_booking', 8, 'Describe the next step: book, buy, fill out a form, or speak to a person. Explain how to offer and confirm it.'));
  const routing = scriptCard('routing', 'Routing & Resources', 'Who should take the next step, who needs a resource, and which links the AI may send', 'bolt', ACC.indigo,
    '<div class="field-label">Routing Rules</div>' +
    ta('prompt_routing', 5, 'Describe who should take the next step, who needs another resource, and when.') +
    '<div class="field-label">Bookable call slots</div>' + inp('call_slots', 'e.g. Mon–Fri 10am–6pm UK, or leave blank') +
    '<div class="field-label">Free guide link</div>' + inp('guide_link', 'https://…') +
    '<div class="field-label">Community link</div>' + inp('community_link', 'https://…') +
    '<p class="sc-help">The AI only ever has the links and slots listed here. Leave one blank and it does not exist.</p>');
  const objRows = sc.objection_handlers.map((o, i) => {
    const showX = sc.objection_handlers.length > 1;
    return '<div class="obj-row">' +
      '<input class="obj-trigger" data-obj="trigger" data-oi="' + i + '" placeholder="If they say..." value="' + esc(o.trigger) + '">' +
      '<span class="obj-arrow">→</span>' +
      '<input class="obj-reply" data-obj="reply" data-oi="' + i + '" placeholder="Reply with..." value="' + esc(o.reply) + '">' +
      '<div class="obj-audio"><span class="audio-lbl">' + icon('volume', 14) + 'Audio reply:</span>' + audioBtns +
      (showX ? '<button type="button" class="row-x" data-obj-x="' + i + '">' + icon('x', 15) + '</button>' : '') +
      '</div></div>';
  }).join('');
  const objections = scriptCard('objections', 'Objection Handling', 'How the AI answers pushback — in your words, or nothing at all', 'alert', ACC.red,
    '<div class="field-label">Approach</div>' +
    ta('prompt_objections', 5, 'Describe how to handle objections in general (price, time, "let me think about it", etc.).') +
    '<div class="section-toprow" style="margin-top:14px"><div class="field-label">Specific handlers</div>' +
    '<button type="button" class="mini-btn add-btn" data-add="obj">' + icon('plus', 14) + 'Add</button></div>' +
    '<div class="obj-list">' + objRows + '</div>');
  const followup = scriptCard('followup', 'Follow-up Instructions', 'What the AI writes when a lead goes quiet', 'stopwatch', ACC.orange,
    ta('prompt_followup', 5, 'Describe how the AI should follow up with a lead who stopped replying: angle, tone, what never to say.') +
    '<p class="sc-help">Used only when the AI writes a follow-up itself — timings live in <b>Settings › AI Controls</b> and are off until you set them. Core Sequences below send your exact messages instead.</p>');
  const rules = scriptCard('rules', 'Hard Rules', 'Things the AI must never do, no matter what', 'shield', ACC.red,
    ta('prompt_hard_rules', 5, 'One per line. e.g. never quote a price, never mention being an AI, never give medical advice.'));
  const custom = scriptCard('custom', 'Custom Instructions', 'Anything else — extra rules, edge cases, your own full prompt', 'spark', ACC.purple,
    ta('prompt_custom', 6, 'Anything not covered above. You can paste an entire prompt here if you prefer to write it as one piece.'));

  // 4. Reaction Criteria
  const ruleRows = sc.reaction_rules.length
    ? sc.reaction_rules.map((r, i) => '<div class="rule-row"><input data-rule="1" data-ri="' + i + '" placeholder="When they share their goal" value="' + esc(r) + '">' +
        '<button type="button" class="row-x" data-rule-x="' + i + '">' + icon('x', 15) + '</button></div>').join('')
    : '<div class="sc-help italic">No rules yet. Add criteria like "When they share their goal".</div>';
  const reaction = scriptCard('reaction', 'Reaction Criteria',
    'Instagram heart reactions only. AI hearts prospect messages when your criteria match and it sends a reply.',
    'heart', ACC.pink,
    '<div class="reaction-toggle-row"><div class="rt-copy"><div class="rt-label">Enable AI reactions</div>' +
    '<div class="rt-help">When on, autopilot may heart messages that match your rules (only if it also replies with text).</div></div>' +
    switchHtml(sc.reactions_enabled, '', 'id="reactions-switch"') + '</div>' +
    '<div class="divider-faint"></div>' +
    '<div class="section-toprow"><div class="field-label">When to heart...</div>' +
    '<button type="button" class="mini-btn add-btn" data-add="rule">' + icon('plus', 14) + 'Add rule</button></div>' +
    ruleRows);

  // 5. Audio Arsenal
  const arsRows = sc.audio_arsenal.map((a, i) => {
    const showX = sc.audio_arsenal.length > 1;
    return '<div class="arsenal-entry' + (showX ? ' has-x' : '') + '">' +
      '<div class="field-label">When I say...</div>' +
      '<input data-arsenal="1" data-ai="' + i + '" placeholder="When I say..." value="' + esc(a.phrase) + '">' +
      arsenalAudio(a, i) +
      (showX ? '<button type="button" class="row-x entry-x" data-arsenal-x="' + i + '">' + icon('x', 15) + '</button>' : '') +
      '</div>';
  }).join('');
  const audioArsenal = scriptCard('audio', 'Audio Arsenal',
    'When your phrase shows up — in the AI\'s reply <b>or</b> in what the lead sends (e.g. they DM <b>INFO</b>) — the first time it comes up they hear your voice note. After that, just text.',
    'volume', ACC.red,
    '<div class="section-toprow" style="justify-content:flex-end"><button type="button" class="mini-btn add-btn" data-add="arsenal">' + icon('plus', 14) + 'Add</button></div>' +
    '<div class="arsenal-list">' + arsRows + '</div>');

  // 6. Manual voice arsenal
  const manRows = sc.manual_voice.map((m, i) => {
    const showX = sc.manual_voice.length > 1;
    return '<div class="arsenal-entry' + (showX ? ' has-x' : '') + '">' +
      '<div class="field-label">Label</div>' +
      '<input data-manual="1" data-mi="' + i + '" placeholder="e.g. Offer introduction, Pricing" value="' + esc(m.label) + '">' +
      '<div class="audio-reply-row"><span class="audio-lbl">' + icon('mic', 14) + 'Audio:</span>' + audioBtns + '</div>' +
      (showX ? '<button type="button" class="row-x entry-x" data-manual-x="' + i + '">' + icon('x', 15) + '</button>' : '') +
      '</div>';
  }).join('');
  const manualVoice = scriptCard('manual', 'Manual voice arsenal',
    'Upload clips you send yourself from the inbox chat bar (queue or send immediately). Not tied to AI phrase matching.',
    'mic', ACC.green,
    '<div class="section-toprow"><span class="kb-hint" style="flex:1">Give each clip a short label — it appears when the message is queued. Use the same upload flow as automated arsenal.</span>' +
    '<button type="button" class="mini-btn add-btn" data-add="manual">' + icon('plus', 14) + 'Add</button></div>' +
    '<div class="arsenal-list">' + manRows + '</div>');

  // 7. Story/Reel Keyword Trigger
  const kt = sc.keyword_trigger;
  const kwBody =
    '<div class="kw-subhead">Response Mode</div>' +
    '<div class="mode-grid">' +
      '<div class="mode-card' + (kt.mode === 'text' ? ' sel' : '') + '" data-mode="text"><div class="mc-title">Text + Follow-ups</div><div class="mc-sub">Sends Initial Message and keyword follow-ups.</div></div>' +
      '<div class="mode-card' + (kt.mode === 'audio' ? ' sel' : '') + '" data-mode="audio"><div class="mc-title">Audio only</div><div class="mc-sub">Sends audio on keyword match and skips text reply.</div></div>' +
    '</div>' +
    '<div class="kw-callout" style="margin-top:16px"><div class="co-head">Send behavior</div>' +
    '<div class="co-body">Add an Initial Message or Audio DM to define what is sent on keyword match.</div></div>' +
    '<div class="kw-subhead">Trigger Keywords</div>' +
    '<input class="mono" data-kt="keywords" placeholder="E.G., CHANGE, FIT, START, COACH" value="' + esc(kt.keywords) + '">' +
    '<div class="sc-help"><b>' + icon('bolt', 12) + ' Keyword match</b> — Comma-separated. Triggers when the message is only that word, when it is the <b>first word</b>, or when it <b>starts with the keyword</b> (e.g. <span class="mono">COACH I need help</span>) — any case, punctuation ignored. Autopilot turns on for that chat. Works at any point in the thread.</div>' +
    '<div class="kw-subhead">Audio DM (Optional Override)</div>' +
    '<div class="btn-row">' + audioBtns + '</div>' +
    '<div class="sc-help">Uses the same Trigger Keywords above. If audio is uploaded, it overrides text keyword replies for matches.</div>' +
    '<div class="kw-subhead"><span class="sh-ic">' + icon('stopwatch', 14) + '</span>Initial Response Delay (Optional)</div>' +
    '<div class="kw-subbox"><div class="sc-help" style="margin:0">Random wait before the first keyword reply (exact, phrase, or audio). Leave both numbers empty to use <b>Autopilot → Response Time</b>.</div>' +
    '<div class="delay-row"><input type="number" min="0" data-kt="delay_min" placeholder="Min" value="' + esc(kt.delay_min) + '"><span class="to-word">to</span>' +
    '<input type="number" min="0" data-kt="delay_max" placeholder="Max" value="' + esc(kt.delay_max) + '"><select><option>seconds</option></select></div></div>' +
    '<div class="kw-subhead">Initial Message</div>' +
    '<textarea class="mono" data-kt="initial_message" rows="4" placeholder="The exact first message to send when a lead DMs your keyword.">' + esc(kt.initial_message) + '</textarea>' +
    '<div class="sc-help">' + icon('bolt', 12) + ' This exact message is sent when triggered (not AI-generated)</div>' +
    '<div class="section-toprow" style="margin-top:16px"><div class="kw-subhead" style="margin:0"><span class="sh-ic">' + icon('chats', 14) + '</span>Follow-ups</div>' +
    '<button type="button" class="mini-btn add-btn" data-add="fup-kw">' + icon('plus', 14) + 'Add</button></div>' +
    fupListHtml('kw') +
    '<div class="kw-callout flow"><span class="co-ic">' + icon('bolt', 15) + '</span><div class="co-body">After this message, the AI follows <b>your prompt sections above</b> and any Core Sequence follow-ups you set below</div></div>';
  const keyword = '<div class="kw-toplabel"><span class="kw-dot"></span>Story/Reel Keyword Trigger</div>' +
    scriptCard('keyword', 'Keyword Trigger',
      'Triggered when prospect responds with your keyword (e.g., INFO, START) • Mode: Not configured',
      null, ACC.orange, kwBody, { dot: true });

  // 8. Turn On AI When I Send…
  const phraseRows = sc.ai_on_phrases.length
    ? sc.ai_on_phrases.map((p, i) => '<div class="phrase-row"><input class="mono" data-phrase="1" data-pi="' + i + '" placeholder="Exact outbound message…" value="' + esc(p) + '">' +
        '<button type="button" class="row-x" data-phrase-x="' + i + '">' + icon('x', 15) + '</button></div>').join('')
    : '';
  const aiOn = scriptCard('aion', 'Turn On AI When I Send…',
    'AI activates when your outbound message matches any phrase below — from the dashboard or your phone.',
    null, ACC.indigo,
    '<div class="phrase-list">' + phraseRows + '</div>' +
    '<button type="button" class="btn-solid-indigo" data-add="phrase">' + icon('plus', 15) + 'Add phrase</button>' +
    '<div class="sc-help" style="margin-top:12px"><b>Whole-message match</b> — When you send any of these messages (as coach, incl. from the Instagram app on your phone), autopilot turns on for that chat. Case, punctuation and spacing are ignored, but the message must be the whole phrase. One phrase per field.</div>',
    { dot: true });

  // 9. Core Sequences
  const seq = (id, key, title, sub) => {
    const open = state.promptOpen[id];
    return '<div class="seq-card' + (open ? ' open' : '') + '" data-seq="' + id + '">' +
      '<div class="seq-card-head"><div class="sc-titles"><div class="sc-title">' + title + '</div><div class="sc-sub">' + sub + '</div></div>' +
      '<span class="chev">' + icon('chevdown', 16) + '</span></div>' +
      '<div class="seq-card-body">' +
      '<div class="section-toprow"><div class="kw-subhead" style="margin:0"><span class="sh-ic" style="color:var(--muted)">' + icon('chats', 14) + '</span>Follow-ups</div>' +
      '<button type="button" class="mini-btn add-btn" data-add="fup-' + key + '">' + icon('plus', 14) + 'Add</button></div>' +
      fupListHtml(key) + '</div></div>';
  };
  const callBookedOpen = state.promptOpen['callbooked'];
  const vslHasPlaceholder = (sc.call_booked_vsl || '').includes('[VSL LINK]');
  const callBooked = '<div class="seq-card' + (callBookedOpen ? ' open' : '') + '" data-seq="callbooked">' +
    '<div class="seq-card-head"><div class="sc-titles"><div class="sc-title">Call Booked</div><div class="sc-sub">Message sent when prospect confirms booking with a screenshot</div></div>' +
    '<span class="chev">' + icon('chevdown', 16) + '</span></div>' +
    '<div class="seq-card-body"><div class="kw-subhead" style="margin-top:0">VSL Message</div>' +
    '<textarea data-sk="call_booked_vsl" rows="6" placeholder="Enter the message to send when someone confirms their booking with a screenshot (e.g., VSL link, next steps, etc.)">' + esc(sc.call_booked_vsl) + '</textarea>' +
    (vslHasPlaceholder ? '<div class="pv-note" style="padding:6px 0 0">' + icon('alert', 13) + '<span>Replace [VSL LINK] with your real video link — the auto-send skips while the placeholder is present.</span></div>' : '') +
    '</div></div>';
  const coreSeq = '<div class="core-seq-wrap"><div class="core-seq-head">Core Sequences</div>' +
    seq('seqlead', 'seq_lead', 'Lead Sequence', 'Your exact follow-ups for leads who go quiet before qualifying (empty = none)') +
    seq('seqqual', 'seq_qualification', 'Qualification Sequence', 'Your exact follow-ups for leads who go quiet while qualifying (empty = none)') +
    seq('seqbook', 'seq_booking', 'Next-step sequence', 'Your exact follow-ups for leads who go quiet after a booking is proposed (empty = none)') +
    callBooked + '</div>';

  col.innerHTML = coach + persona + offer + voice + qual + book + routing + objections + followup + rules + custom + kb + audioArsenal + keyword + aiOn + coreSeq;
  bindScriptEvents(col);
}

function bindScriptEvents(col) {
  // Collapse/expand for accented section cards
  col.querySelectorAll('.script-card-head').forEach((h) => h.addEventListener('click', (e) => {
    if (e.target.closest('input,textarea,select,button,label,.switch')) return;
    const card = h.closest('.script-card');
    const id = card.dataset.sec;
    if (id === 'coach') return;
    syncScriptFromDom();
    state.promptOpen[id] = !state.promptOpen[id];
    renderScriptWorkspace();
  }));
  // Collapse/expand for Core Sequence sub-cards
  col.querySelectorAll('.seq-card-head').forEach((h) => h.addEventListener('click', (e) => {
    if (e.target.closest('input,textarea,select,button')) return;
    const card = h.closest('.seq-card');
    const id = card.dataset.seq;
    syncScriptFromDom();
    state.promptOpen[id] = !state.promptOpen[id];
    renderScriptWorkspace();
  }));
  // Keep state.script in sync as the user types (guards against re-render loss)
  col.querySelectorAll('[data-sk]').forEach((el) => el.addEventListener('input', () => { state.script[el.dataset.sk] = el.value; }));
  col.querySelectorAll('[data-obj]').forEach((el) => el.addEventListener('input', () => {
    const row = state.script.objection_handlers[+el.dataset.oi]; if (row) row[el.dataset.obj] = el.value;
  }));
  col.querySelectorAll('[data-rule]').forEach((el) => el.addEventListener('input', () => { state.script.reaction_rules[+el.dataset.ri] = el.value; }));
  col.querySelectorAll('[data-arsenal]').forEach((el) => el.addEventListener('input', () => {
    const row = state.script.audio_arsenal[+el.dataset.ai]; if (row) row.phrase = el.value;
  }));
  col.querySelectorAll('[data-manual]').forEach((el) => el.addEventListener('input', () => {
    const row = state.script.manual_voice[+el.dataset.mi]; if (row) row.label = el.value;
  }));
  col.querySelectorAll('[data-phrase]').forEach((el) => el.addEventListener('input', () => { state.script.ai_on_phrases[+el.dataset.pi] = el.value; }));
  col.querySelectorAll('[data-kt]').forEach((el) => el.addEventListener('input', () => { state.script.keyword_trigger[el.dataset.kt] = el.value; }));
  col.querySelectorAll('[data-fup][data-fk]').forEach((el) => el.addEventListener('input', () => {
    const arr = fupArrFor(el.dataset.fup); const row = arr && arr[+el.dataset.fi]; if (row) row[el.dataset.fk] = el.value;
  }));

  // Reaction master toggle
  const rs = col.querySelector('#reactions-switch input');
  if (rs) rs.addEventListener('change', () => { state.script.reactions_enabled = rs.checked; });

  // Response-mode picker
  col.querySelectorAll('[data-mode]').forEach((c) => c.addEventListener('click', () => {
    syncScriptFromDom();
    state.script.keyword_trigger.mode = c.dataset.mode;
    markScriptDirty();
    renderScriptWorkspace();
  }));

  // Add buttons
  col.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => {
    syncScriptFromDom();
    const k = b.dataset.add;
    if (k === 'obj') state.script.objection_handlers.push({ trigger: '', reply: '' });
    else if (k === 'rule') state.script.reaction_rules.push('');
    else if (k === 'arsenal') state.script.audio_arsenal.push({ phrase: '' });
    else if (k === 'manual') state.script.manual_voice.push({ label: '' });
    else if (k === 'phrase') state.script.ai_on_phrases.push('');
    else if (k.startsWith('fup-')) {
      const scope = k.slice(4);
      fupArrFor(scope).push({ kind: 'text', message: '', variation: false, audio_id: '', delay_min: '', delay_max: '', unit: 'hours' });
      // Ensure the section stays open after adding
      if (scope === 'seq_lead') state.promptOpen.seqlead = true;
      if (scope === 'seq_qualification') state.promptOpen.seqqual = true;
      if (scope === 'seq_booking') state.promptOpen.seqbook = true;
    }
    markScriptDirty();
    renderScriptWorkspace();
  }));

  // Remove buttons
  const rm = (sel, fn) => col.querySelectorAll(sel).forEach((b) => b.addEventListener('click', () => {
    syncScriptFromDom(); fn(b); markScriptDirty(); renderScriptWorkspace();
  }));
  rm('[data-obj-x]', (b) => state.script.objection_handlers.splice(+b.dataset.objX, 1));
  rm('[data-rule-x]', (b) => state.script.reaction_rules.splice(+b.dataset.ruleX, 1));
  rm('[data-arsenal-x]', (b) => state.script.audio_arsenal.splice(+b.dataset.arsenalX, 1));
  rm('[data-manual-x]', (b) => state.script.manual_voice.splice(+b.dataset.manualX, 1));
  rm('[data-phrase-x]', (b) => state.script.ai_on_phrases.splice(+b.dataset.phraseX, 1));
  rm('[data-fup-x]', (b) => fupArrFor(b.dataset.fupX).splice(+b.dataset.fi, 1));

  // Knowledge base: real upload + list + delete (RAG is live on the server)
  const kbu = col.querySelector('#kb-upload');
  const kbFile = col.querySelector('#kb-file');
  if (kbu && kbFile) {
    kbu.addEventListener('click', () => kbFile.click());
    kbFile.addEventListener('change', async () => {
      const file = kbFile.files && kbFile.files[0];
      if (!file) return;
      const orig = kbu.innerHTML; kbu.disabled = true; kbu.innerHTML = icon('upload', 15) + 'Uploading…';
      try {
        const fd = new FormData(); fd.append('file', file);
        const res = await sessionFetch('/api/knowledge', { method: 'POST', body: fd });
        const out = await res.json();
        if (!res.ok) throw new Error(out.error || 'Upload failed');
        toast('Added “' + out.document.name + '” to the knowledge base');
        loadKnowledge();
      } catch (err) { toast(err.message, 'err'); }
      finally { kbu.disabled = false; kbu.innerHTML = orig; kbFile.value = ''; }
    });
  }
  loadKnowledge();
  col.querySelectorAll('[data-audio]').forEach((b) => b.addEventListener('click', () => notEnabledToast('Voice notes')));
  col.querySelectorAll('[data-arsaudio]').forEach((b) => b.addEventListener('click', () => arsenalAudioAction(b)));
  col.querySelectorAll('[data-fupaudio]').forEach((b) => b.addEventListener('click', () => fupAudioAction(b)));
  col.querySelectorAll('[data-fupkind]').forEach((b) => b.addEventListener('click', () => {
    syncScriptFromDom();
    const r = fupArrFor(b.dataset.fup)[+b.dataset.fi];
    if (r) r.kind = b.dataset.fupkind === 'audio' ? 'audio' : 'text';
    markScriptDirty();
    renderScriptWorkspace();
  }));
  col.querySelectorAll('[data-fup-variation]').forEach((b) => b.addEventListener('click', () => {
    syncScriptFromDom();
    const r = fupArrFor(b.dataset.fupVariation)[+b.dataset.fi];
    if (r) r.variation = !r.variation;
    markScriptDirty();
    renderScriptWorkspace();
  }));
  col.querySelectorAll('[data-fup-name]').forEach((b) => b.addEventListener('click', () => insertFirstName(b)));
  initVnPlayers(col);
}

/** Load + render the knowledge-base document list into #kb-list. */
async function loadKnowledge() {
  const box = document.querySelector('#kb-list');
  if (!box) return;
  let docs = [];
  try { docs = (await api('/api/knowledge')).documents || []; } catch { return; }
  if (!docs.length) { box.innerHTML = '<div class="kb-empty">No documents yet.</div>'; return; }
  box.innerHTML = docs.map((d) =>
    '<div class="kb-doc"><span class="kb-doc-ic">' + icon('filetext', 15) + '</span>' +
    '<div class="kb-doc-meta"><div class="kb-doc-name">' + esc(d.name) + '</div>' +
    '<div class="kb-doc-sub">' + (Number(d.chars) ? Number(d.chars).toLocaleString() + ' characters' : 'empty') + '</div></div>' +
    '<button class="kb-doc-del" data-del="' + d.id + '" title="Remove">' + icon('x', 15) + '</button></div>'
  ).join('');
  box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    try { await api('/api/knowledge/' + b.dataset.del, { method: 'DELETE' }); toast('Document removed'); loadKnowledge(); }
    catch (e) { toast(e.message, 'err'); }
  }));
}

/* ---- styled dropdowns: replace native <select> popups app-wide ---- */
let _xpop = null, _xsel = null;
function _hideXpop() {
  if (_xpop) _xpop.classList.remove('show');
  _xsel = null;
  document.querySelectorAll('.xsel.open').forEach((x) => x.classList.remove('open'));
}
function _ensureXpop() {
  if (_xpop) return _xpop;
  _xpop = document.createElement('div');
  _xpop.className = 'xsel-menu';
  document.body.appendChild(_xpop);
  document.addEventListener('click', _hideXpop);
  window.addEventListener('scroll', _hideXpop, true);
  window.addEventListener('resize', _hideXpop);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') _hideXpop(); });
  return _xpop;
}
function _openXpop(sel, wrap, btn) {
  const pop = _ensureXpop(); _xsel = sel;
  pop.innerHTML = '';
  Array.from(sel.options).forEach((opt) => {
    const d = document.createElement('div');
    d.className = 'xsel-opt' + (opt.value === sel.value ? ' on' : '');
    d.textContent = opt.text;
    d.addEventListener('click', (e) => {
      e.stopPropagation();
      if (sel.value !== opt.value) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
      _hideXpop();
    });
    pop.appendChild(d);
  });
  const r = btn.getBoundingClientRect();
  pop.style.minWidth = r.width + 'px';
  pop.style.left = '0px';            // reset before measuring so a prior position can't skew offsetWidth
  pop.classList.add('show');        // show first so we can measure the real menu size
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  // Horizontal: align the menu's LEFT edge under the button. If that overflows the
  // right gutter (button near the right edge), RIGHT-align it to the button instead.
  // Clamp to the 8px left gutter as a last resort. (The old code pinned to a
  // hardcoded 260px width, which yanked right-side dropdowns away from their button.)
  let left = r.left;
  if (left + w > window.innerWidth - 8) left = r.right - w;
  pop.style.left = Math.max(8, left) + 'px';
  // Vertical: below the button, or above when there isn't room below.
  const below = window.innerHeight - r.bottom;
  pop.style.top = (below < h + 12 && r.top > below ? r.top - h - 6 : r.bottom + 6) + 'px';
  wrap.classList.add('open');
}
function enhanceSelect(sel) {
  if (sel.dataset.xsel) return;
  sel.dataset.xsel = '1';
  const wrap = document.createElement('span'); wrap.className = 'xsel';
  sel.parentNode.insertBefore(wrap, sel); wrap.appendChild(sel);
  const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'xsel-btn';
  const lab = document.createElement('span'); lab.className = 'xsel-lab';
  const chev = document.createElement('span'); chev.className = 'chev'; chev.innerHTML = icon('chevdown', 15);
  btn.appendChild(lab); btn.appendChild(chev);
  const setLabel = () => { const o = sel.options[sel.selectedIndex]; lab.textContent = o ? o.text : ''; };
  setLabel();
  sel.addEventListener('change', setLabel);
  btn.addEventListener('click', (e) => { e.stopPropagation(); if (_xsel === sel) { _hideXpop(); return; } _openXpop(sel, wrap, btn); });
  wrap.appendChild(btn);
}
function enhanceAllSelects(root) { (root || document).querySelectorAll('select:not([data-xsel])').forEach(enhanceSelect); }
(function () {
  let raf = 0;
  const run = () => { raf = 0; enhanceAllSelects(document); };
  const boot = () => { new MutationObserver(() => { if (!raf) raf = requestAnimationFrame(run); }).observe(document.body, { childList: true, subtree: true }); enhanceAllSelects(document); };
  if (document.body) boot(); else document.addEventListener('DOMContentLoaded', boot);
})();

/* AI Script Save button: reflects unsaved changes ("Save Changes") vs saved ("Saved"). */
function markScriptDirty() {
  if (state.scriptDirty) return;
  state.scriptDirty = true;
  const b = document.getElementById('script-save');
  if (b) { b.textContent = 'Save Changes'; b.classList.remove('is-saved'); }
}
function setScriptSaved() {
  state.scriptDirty = false;
  const b = document.getElementById('script-save');
  if (b) { b.textContent = 'Saved'; b.classList.add('is-saved'); }
}
function markSettingsDirty() {
  if (state.settingsDirty) return;
  state.settingsDirty = true;
  const b = document.getElementById('settings-save');
  if (b) { b.textContent = 'Save Changes'; b.classList.remove('is-saved'); }
}
function setSettingsSaved() {
  state.settingsDirty = false;
  const b = document.getElementById('settings-save');
  if (b) { b.textContent = 'Saved'; b.classList.add('is-saved'); }
}
/* Capture current Settings form values from the DOM into state.settings.settings before a
   forced renderSettings() (kill switch, loadIgStatus), so in-progress edits survive the repaint
   instead of being clobbered by the last-saved values. Mirrors the field list saveSettings() uses. */
function syncSettingsFromDom() {
  const page = document.getElementById('settings-page');
  const s = state.settings && state.settings.settings;
  if (!page || !s) return;
  const val = (id) => { const el = document.getElementById(id); return el ? el.value : undefined; };
  const checked = (id) => { const el = document.getElementById(id); return el && el.querySelector('input') ? el.querySelector('input').checked : undefined; };
  const set = (key, v) => { if (v !== undefined) s[key] = v; };
  set('calendar_link', val('set-calendar'));
  set('notify_emails', val('set-notify'));
  { const tok = (val('set-calendly-token') || '').trim(); if (tok) s.calendly_token = tok; }
  const bookDms = document.getElementById('set-book-dms');
  if (bookDms) s.book_in_dms = bookDms.checked ? '1' : '0';
  set('response_min', val('set-resp-min'));
  set('response_max', val('set-resp-max'));
  const typing = checked('set-typing');
  if (typing !== undefined) s.typing_indicator = typing ? '1' : '0';
  set('languages', val('set-languages'));
  set('min_age', val('set-minage'));
  const flagFinal = checked('set-flag-final');
  if (flagFinal !== undefined) s.flag_send_final = flagFinal ? '1' : '0';
  set('flag_final_message', val('set-flag-msg'));
  const flagOut = {};
  page.querySelectorAll('[data-flag]').forEach((t) => { const v = t.value.trim(); if (v) flagOut[t.dataset.flag] = v; });
  s.flag_messages = JSON.stringify(flagOut);
  const flagEnabledOut = {};
  page.querySelectorAll('[data-flagen]').forEach((el) => { flagEnabledOut[el.dataset.flagen] = !!el.querySelector('input').checked; });
  s.flag_enabled = JSON.stringify(flagEnabledOut);
  const defaultMode = val('default-mode');
  set('default_mode', defaultMode);
  const stripD = checked('set-strip-dashes');
  if (stripD !== undefined) s.strip_dashes = stripD ? '1' : '0';
  set('followup_1_hours', val('fu1'));
  set('followup_2_hours', val('fu2'));
  set('followup_3_hours', val('fu3'));
  set('followup_4_hours', val('fu4'));
  const outboundEl = document.getElementById('set-outbound');
  if (outboundEl) s.outbound_filter_regexes = JSON.stringify(outboundEl.value.split('\n').map((x) => x.trim()).filter(Boolean));
  s.booking_reminders = JSON.stringify(bookingRemindersFromDom());
  set('noshow_message', val('set-noshow-msg'));
}

async function saveScript(e) {
  const btn = e.currentTarget;
  syncScriptFromDom();
  const sc = state.script;
  const cleanFups = (arr) => arr.map((f) => {
    const kind = f.kind === 'audio' ? 'audio' : 'text';
    const dmin = Number(f.delay_min) || 0;
    let dmax = Number(f.delay_max); if (!Number.isFinite(dmax)) dmax = dmin;
    const unit = ['minutes', 'hours', 'days'].includes(f.unit) ? f.unit : 'hours';
    const step = { kind, delay_min: dmin, delay_max: Math.max(dmin, dmax), unit };
    if (kind === 'audio') step.audio_id = f.audio_id || '';
    else { step.message = String(f.message || '').trim(); step.variation = !!f.variation; }
    return step;
  }).filter((f) => f.kind === 'audio' ? !!f.audio_id : !!f.message);
  const body = {
    coach_name: sc.coach_name,
    prompt_persona: sc.prompt_persona,
    about_you: sc.about_you,
    prompt_offer: sc.prompt_offer,
    client_results: sc.client_results,
    prompt_voice: sc.prompt_voice,
    prompt_qualification: sc.prompt_qualification,
    prompt_booking: sc.prompt_booking,
    prompt_routing: sc.prompt_routing,
    call_slots: sc.call_slots,
    guide_link: sc.guide_link,
    community_link: sc.community_link,
    prompt_objections: sc.prompt_objections,
    prompt_followup: sc.prompt_followup,
    prompt_hard_rules: sc.prompt_hard_rules,
    prompt_custom: sc.prompt_custom,
    call_booked_vsl: sc.call_booked_vsl,
    reactions_enabled: sc.reactions_enabled ? '1' : '0',
    objection_handlers: JSON.stringify(sc.objection_handlers.filter((o) => o.trigger.trim() || o.reply.trim())),
    reaction_rules: JSON.stringify(sc.reaction_rules.map((r) => r.trim()).filter(Boolean)),
    audio_arsenal: JSON.stringify(sc.audio_arsenal.filter((a) => a.phrase.trim())),
    manual_voice: JSON.stringify(sc.manual_voice.filter((m) => m.label.trim())),
    ai_on_phrases: JSON.stringify(sc.ai_on_phrases.map((p) => p.trim()).filter(Boolean)),
    seq_lead: JSON.stringify(cleanFups(sc.seq_lead)),
    seq_qualification: JSON.stringify(cleanFups(sc.seq_qualification)),
    seq_booking: JSON.stringify(cleanFups(sc.seq_booking)),
    keyword_trigger: JSON.stringify({
      mode: sc.keyword_trigger.mode,
      keywords: sc.keyword_trigger.keywords,
      initial_message: sc.keyword_trigger.initial_message,
      delay_min: sc.keyword_trigger.delay_min,
      delay_max: sc.keyword_trigger.delay_max,
      follow_ups: cleanFups(sc.keyword_trigger.follow_ups),
    }),
  };
  const prev = btn.textContent;
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const out = await api('/api/settings', { method: 'PUT', body });
    state.settings = Object.assign({}, state.settings, { settings: out.settings });
    setScriptSaved();
    renderAccount();
    loadScriptChecks($('#script-col'),$('#prompt-check-status'));
  } catch (err) { toast(err.message, 'err'); btn.textContent = prev; }
  finally { btn.disabled = false; }
}
function renderPreviewMsgs() {
  const box = $('#pv-msgs');
  if (!box) return;
  const hist = state.preview.history;
  box.innerHTML = (hist.length ? hist.map((m, i) => {
    const note = state.preview.notes[i];
    return '<div class="msg ' + (m.role === 'lead' ? 'lead' : 'setter') + '">' +
      '<div class="msg-meta"><span>' + (m.role === 'lead' ? 'Test lead' : 'AI') + '</span></div>' +
      '<div class="msg-bubble">' + esc(m.text) + (m.blocked ? '<div class="pv-blocked">Blocked by outbound filter</div>' : '') + '</div>' +
      (note ? '<div class="pv-note" style="margin-top:5px">' + icon('flag', 12) + '<span>' + esc(note) + '</span></div>' : '') +
      '</div>';
  }).join('') : '<div class="preview-empty">Start by sending a test message to see how your AI responds.</div>') +
  (state.preview.busy ? '<div class="pv-typing"><span></span><span></span><span></span></div>' : '');
  box.scrollTop = box.scrollHeight;
}
async function sendPreview() {
  const inp = $('#pv-input');
  const text = inp.value.trim();
  if (!text || state.preview.busy) return;
  inp.value = '';
  state.preview.history.push({ role: 'lead', text });
  state.preview.busy = true;
  renderPreviewMsgs();
  try {
    const out = await api('/api/preview', {
      method: 'POST',
      body: { history: state.preview.history.map((m) => ({ role: m.role === 'lead' ? 'lead' : 'setter', text: m.text })), stage: state.preview.stage },
    });
    out.messages.forEach((m) => state.preview.history.push({ role: 'setter', text: m.text, blocked: m.blocked }));
    if (out.needs_human) state.preview.notes[state.preview.history.length - 1] = 'Would flag for review — ' + (out.reason || 'needs human');
    if (STAGES.slice(0, 5).includes(out.stage)) {
      state.preview.stage = out.stage;
      const sel = $('#pv-stage'); if (sel) sel.value = out.stage;
    }
  } catch (e) {
    toast(e.status === 409 ? 'The kill switch is on — AI is paused' : e.message, 'err');
    state.preview.history.pop();
  }
  state.preview.busy = false;
  renderPreviewMsgs();
}

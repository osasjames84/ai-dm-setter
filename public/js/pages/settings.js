'use strict';
/* ============================== settings ============================== */
/** SetDM-style Instagram connection card + the exact values to paste into Meta. */
function igSectionHtml(st) {
  const IG_GRAD = 'background:linear-gradient(135deg,#f58529,#dd2a7b,#8134af);color:#fff';
  let conn;
  if (!st) {
    conn = '<div class="ig-conn">Checking connection…</div>';
  } else if (st.account) {
    conn = '<div class="ig-conn ok"><div><div class="sr-label">Connected as</div>' +
      '<div class="sr-sub mono">Instagram ID: ' + esc(st.account.id || '') + '</div></div>' +
      '<span class="ig-handle">@' + esc(st.account.username || 'account') + '</span></div>';
  } else if (st.configured) {
    conn = '<div class="ig-conn warn">Credentials are set but the token check failed' +
      (st.error ? ' (' + esc(st.error) + ')' : '') + '. Re-check IG_PAGE_TOKEN and IG_BUSINESS_ID, then Refresh Connection.</div>';
  } else {
    conn = '<div class="ig-conn">Not connected. Set <span class="mono">IG_PAGE_TOKEN</span>, <span class="mono">IG_VERIFY_TOKEN</span> and ' +
      '<span class="mono">IG_BUSINESS_ID</span> in the server environment, then Refresh Connection. The simulator works without this.</div>';
  }
  const url = st && st.webhook_url ? st.webhook_url : '…';
  const perms = st && st.permissions ? st.permissions.join(', ') : 'instagram_business_manage_messages, pages_manage_metadata';
  const authAlert = st && st.auth_error ? '<div class="ig-auth-alert">' + icon('alert', 17) +
    '<span>Instagram disconnected — the access token was rejected (expired or revoked). Reconnect by generating a fresh token in your Meta app and updating IG_PAGE_TOKEN.' +
    (st.auth_error.detail ? '<span class="ig-auth-detail">' + esc(st.auth_error.detail) + '</span>' : '') +
    '</span></div>' : '';
  // Without IG_APP_SECRET the server cannot verify who sent a webhook: it
  // accepts them so DMs keep flowing, but anyone with the URL could forge one.
  const secretAlert = st && st.configured && st.signature_verified === false ? '<div class="ig-auth-alert">' + icon('alert', 17) +
    '<span><b>Instagram webhooks are not being verified.</b> Add <span class="mono">IG_APP_SECRET</span> on Railway (Meta app → Settings → Basic → App Secret, then "+ New Variable") so forged lead messages are rejected. Until then anyone who finds the webhook URL could make the AI reply.</span></div>' : '';
  return '<div class="set-sub">' +
    '<div class="set-sub-head"><span class="icon-chip" style="' + IG_GRAD + '">' + icon('instagram', 15) + '</span>' +
    '<div class="sc-title-sub"><span class="st">Instagram Account</span><span class="sc-s">Connect to enable AI DM automation</span></div></div>' +
    '<div style="height:12px"></div>' +
    secretAlert +
    authAlert +
    conn +
    '<div class="ig-btn-row"><button class="btn btn-ig-grad" id="ig-test">' + icon('refresh', 15) + 'Refresh Connection</button>' +
    '<span class="set-help">Disconnect is managed by the account administrator.</span></div>' +
    '<button class="btn btn-ghost btn-sm" id="ig-sync" style="width:100%;margin-top:8px">' + icon('chats', 14) + 'Sync existing conversations</button>' +
    '<div class="field-label" style="margin-top:16px">Webhook callback URL</div>' +
    '<div class="copy-field" data-copy="' + esc(url) + '"><span class="mono">' + esc(url) + '</span><button class="icon-btn" title="Copy">' + icon('copy', 15) + '</button></div>' +
    '<div class="set-row" style="padding:12px 0 8px"><div><div class="sr-label">Verify token</div><div class="sr-sub">Value of IG_VERIFY_TOKEN — set it identically in the Meta webhook config</div></div>' +
    '<span class="tag ' + (st && st.has_verify_token ? 'green' : '') + '">' + (st && st.has_verify_token ? 'Set' : 'Not set') + '</span></div>' +
    '<div class="set-row" style="padding:8px 0"><div><div class="sr-label">Subscribe to field</div></div><span class="tag indigo">messages</span></div>' +
    '<div class="field-label" style="margin-top:8px">Required permissions</div><div class="sr-sub mono">' + esc(perms) + '</div>' +
    '</div>';
}
let lastIgStatusAt = 0; // throttles the poll-loop refresh; direct calls (boot, Settings, Refresh Connection) stay immediate and reset the timer
async function loadIgStatus() {
  lastIgStatusAt = Date.now();
  try { state.igStatus = await api('/api/instagram/status'); }
  catch (e) { state.igStatus = { configured: false, has_verify_token: false }; }
  renderNav(); // app-wide: surfaces the disconnected-dot on Settings regardless of current route
  if (state.route === 'settings') {
    const wasDirty = state.settingsDirty;
    syncSettingsFromDom(); // preserve any in-progress edits across this forced re-render
    renderSettings();
    if (wasDirty) markSettingsDirty();
  }
}
/* stable reason codes → label + placeholder, in the exact grid order from the spec */
const FLAG_REASONS = [
  ['underage', 'Underage', 'Appreciate it, but I only work with 18+.'],
  ['cant_afford', "Can't Afford", 'All good. Hit me up when timing is better.'],
  ['not_interested', 'Not Interested', 'No worries at all, appreciate the honesty.'],
  ['wrong_fit', 'Wrong Fit', "Got it. Doesn't sound like the right fit for now."],
  ['generic', 'Generic', 'Appreciate the message.'],
  ['manual', 'Manual (dashboard)', 'Optional message when you flag from the inbox.'],
  ['language', 'Language Not Allowed', 'I can only continue this in English right now.'],
  ['unqualified', 'Unqualified', "Appreciate you. You're not the right fit for this right now."],
  ['cursing', 'Cursing', "I'm ending this chat here."],
  ['disrespectful', 'Disrespectful', "I'm going to leave this here."],
  ['medical', 'Serious Health Concern', 'That sounds serious. Please get it checked by a doctor first.'],
];
/* Reads the live #set-rem-hours/#set-rem-msg rows into state.bookingReminders, then
   returns the cleaned array (empty messages dropped, hours coerced to a number) used
   both by the Save PUT body and syncSettingsFromDom(). */
function bookingRemindersFromDom() {
  const page = document.getElementById('settings-page');
  if (page) {
    page.querySelectorAll('[data-reminder-row]').forEach((row) => {
      const i = Number(row.dataset.reminderRow);
      const hoursEl = row.querySelector('[data-rem-hours]');
      const msgEl = row.querySelector('[data-rem-msg]');
      if (state.bookingReminders[i]) {
        if (hoursEl) state.bookingReminders[i].hours_before = hoursEl.value;
        if (msgEl) state.bookingReminders[i].message = msgEl.value;
      }
    });
  }
  return (state.bookingReminders || [])
    .map((r) => ({ hours_before: Number(r.hours_before) || 0, message: String(r.message || '').trim() }))
    .filter((r) => r.message);
}
function chipHtml(name, colorVar, tint, size) {
  return '<span class="icon-chip" style="width:30px;height:30px;background:' + tint + ';color:' + colorVar + '">' + icon(name, size || 15) + '</span>';
}
function cardHeadHtml(chip, title, sub) {
  return '<h3>' + chip + '<span class="sc-title-sub"><span class="sc-t">' + esc(title) + '</span>' +
    (sub ? '<span class="sc-s">' + sub + '</span>' : '') + '</span></h3>';
}
function renderSettings() {
  const s = state.settings && state.settings.settings;
  if (!s) return;
  const ai = state.settings.aiReady;
  if (state.igStatus === null) loadIgStatus();
  const flagMsgs = safeParse(s.flag_messages, {});
  const flagEnabled = safeParse(s.flag_enabled, {});
  if (!state.bookingReminders) {
    state.bookingReminders = (safeParse(s.booking_reminders, []) || []).map((r) => ({ hours_before: r.hours_before, message: r.message || '' }));
  }
  const modeOpts = ['copilot|Copilot', 'autopilot|Autopilot', 'off|Off'].map((o) => {
    const p = o.split('|');
    return '<option value="' + p[0] + '"' + (s.default_mode === p[0] ? ' selected' : '') + '>' + p[1] + '</option>';
  }).join('');
  const outboundText = safeParse(s.outbound_filter_regexes, []).join('\n');

  const flagGrid = FLAG_REASONS.map((r) => {
    const tog = r[0] === 'manual' ? '' : switchHtml(!!flagEnabled[r[0]], '', 'data-flagen="' + r[0] + '"');
    return '<div class="set-field"><div class="field-label" style="display:flex;align-items:center;justify-content:space-between;gap:8px">' +
      '<span>' + esc(r[1]) + '</span>' + tog + '</div>' +
      '<textarea data-flag="' + r[0] + '" placeholder="' + esc(r[2]) + '" style="min-height:74px">' + esc(flagMsgs[r[0]] || '') + '</textarea></div>';
  }).join('');

  const reminderRows = state.bookingReminders.map((r, i) =>
    '<div class="set-two" data-reminder-row="' + i + '" style="align-items:flex-start;gap:8px">' +
    '<div class="set-field" style="max-width:120px"><div class="field-label">Hours before</div>' +
    '<input type="number" min="0" data-rem-hours="' + i + '" value="' + esc(r.hours_before) + '"></div>' +
    '<div class="set-field" style="flex:1"><div class="field-label" style="display:flex;align-items:center;justify-content:space-between;gap:8px">' +
    '<span>Message</span><button type="button" class="row-x" data-rem-x="' + i + '">' + icon('x', 15) + '</button></div>' +
    '<textarea data-rem-msg="' + i + '" placeholder="Hey {{FIRST_NAME}}, reminder — our call is coming up! {{CALENDLY}}" style="min-height:56px">' + esc(r.message) + '</textarea></div></div>'
  ).join('');

  $('#settings-page').innerHTML = '<div class="workspace-head"><h1>Settings</h1><button class="btn btn-primary is-saved" id="settings-save">Saved</button></div>' +
    '<div class="settings-wrap"><div class="settings-intro">Configure your account and automation rules</div><div class="settings-col">' +

    /* 1 — Account */
    '<div class="card settings-card">' + cardHeadHtml(chipHtml('user', '#a5b4fc', 'var(--indigo-soft)'), 'Account', 'Your profile and Instagram') +
    igSectionHtml(state.igStatus) +
    '<div class="set-row" style="margin-top:4px"><div><div class="sr-label">Engine status</div><div class="sr-sub">Anthropic runtime availability</div></div><span class="tag ' + (ai ? 'green' : 'red') + '">' + (ai ? 'API key loaded' : 'No API key') + '</span></div></div>' +

    /* 2 — Calendar Link */
    '<div class="card settings-card"><div class="set-field"><div class="field-label">' + icon('link', 15) + 'Calendar Link</div>' +
    '<input id="set-calendar" type="text" placeholder="https://calendly.com/you" value="' + esc(s.calendar_link) + '"></div></div>' +

    /* 3 — Email notifications */
    '<div class="card settings-card">' + cardHeadHtml(chipHtml('mail', '#a5b4fc', 'var(--indigo-soft)'), 'Email notifications',
      'Alerts for call booked, AI handover, scheduling problems at booking-sent (no times / broken link), warnings (missing calendar / VSL), and when Instagram needs reconnecting.') +
    '<div class="set-field"><div class="field-label">Notification emails</div>' +
    '<input id="set-notify" type="text" placeholder="you@example.com, partner@example.com" value="' + esc(s.notify_emails) + '">' +
    '<p class="set-help">Notifications always go to the dmSetter inbox. Add extra addresses here (comma- or space-separated) to receive copies too.</p></div>' +
    '<div class="set-row" style="padding-top:0"><div><div class="sr-label">Delivery status</div></div>' +
    (state.settings.notifyReady ? '<span class="tag green">Email delivery configured</span>' : '<span class="tag amber">Add RESEND_API_KEY on the server to enable delivery</span>') +
    '</div></div>' +

    /* 4 — Calendly API Token */
    '<div class="card settings-card"><div class="set-field">' +
    '<div class="field-label">' + icon('key', 15) + 'Calendly API Token <span class="info-i">' + icon('info', 14) + '</span></div>' +
    '<p class="set-help top">Optional. When set, the AI can check your Calendly availability when prospects ask about scheduling. Enable <b>Scheduling</b> and <code>users:read</code> under <b>User management</b>. Get your token from <a href="https://calendly.com/integrations/api_webhooks" target="_blank" rel="noopener">Calendly Integrations</a>.</p>' +
    '<input id="set-calendly-token" class="mono-ph" type="password" autocomplete="off" placeholder="' + (s.calendly_token_set ? 'Token saved — paste a new one to replace it' : 'eyJhbGciOiJIUzI1NiJ9...') + '" value="' + esc(s.calendly_token || '') + '">' +
    '<label class="set-check"><input type="checkbox" id="set-book-dms"' + (s.book_in_dms === '1' ? ' checked' : '') + '><span class="cbx">' + icon('check', 12) + '</span>' +
    '<span class="cbx-label">Book calls in DMs (Calendly API) — collect intake and book without sending the link first</span></label>' +
    '</div></div>' +

    /* 4b — Call Booking (webhook sync + reminders + no-show) */
    '<div class="card settings-card">' + cardHeadHtml(chipHtml('calendar', '#a5b4fc', 'var(--indigo-soft)'), 'Call Booking', 'Auto-fire your VSL and reminders the moment a lead books') +
    '<div class="set-row" style="padding-top:0">' +
    (state.settings.calendlyWebhookConfigured
      ? '<div><div class="sr-label">Booking sync</div></div><span class="tag green">Booking sync connected</span>'
      : '<div><div class="sr-label">Booking sync</div><div class="sr-sub">Connect booking sync so dmSetter knows when a lead books (auto-fires your VSL + reminders)</div></div>' +
        '<button class="btn btn-primary btn-sm" id="set-calendly-hook">Connect booking sync</button>')
    + '</div>' +
    '<div class="set-field"><div class="field-label">Booking reminders</div>' +
    '<p class="set-help top">Sent automatically before the call. Use <code>{{FIRST_NAME}}</code> and <code>{{CALENDLY}}</code> in your message.</p>' +
    '<div class="reminders-list" style="display:flex;flex-direction:column;gap:12px">' + reminderRows + '</div>' +
    '<button type="button" class="mini-btn add-btn" id="set-rem-add" style="margin-top:8px">' + icon('plus', 14) + 'Add reminder</button></div>' +
    '<div class="set-field"><div class="field-label">No-show message</div>' +
    '<textarea id="set-noshow-msg" placeholder="Hey {{FIRST_NAME}}, looks like we missed each other on the call — want to grab a new time? {{CALENDLY}}">' + esc(s.noshow_message) + '</textarea></div>' +
    '</div>' +

    /* 5 — Autopilot */
    '<div class="card settings-card">' + cardHeadHtml(chipHtml('robot', '#a5b4fc', 'var(--indigo-soft)'), 'Autopilot', 'Let AI handle conversations automatically') +
    '<div class="set-sub ring"><div class="set-sub-head">' + chipHtml('stopwatch', '#a5b4fc', 'var(--indigo-soft)') +
    '<span class="st">Response Time <span class="tag indigo set-badge">Important</span></span></div>' +
    '<p class="set-help">Total time from the lead’s message to the reply landing (feels more human). The AI’s thinking time counts toward it — if thinking runs past the window, the reply sends as soon as it’s ready.</p>' +
    '<div class="rt-controls"><input id="set-resp-min" type="number" min="0" value="' + esc(s.response_min) + '"><span class="rt-to">to</span>' +
    '<input id="set-resp-max" type="number" min="0" value="' + esc(s.response_max) + '">' +
    '<select id="set-resp-unit"><option value="seconds" selected>seconds</option></select></div></div>' +
    '<div class="set-sub"><div class="set-inline"><div class="set-inline-txt"><div class="st">Instagram typing indicator</div>' +
    '<p class="set-help">Mark as read before each reply when possible, show typing, then send. For queued messages this lines up with the countdown (presence starts early enough to finish at 0; up to 30s lead-in). Delay scales with message length (autopilot only; dashboard manual sends go out immediately).</p></div>' +
    switchHtml(s.typing_indicator === '1', '', 'id="set-typing"') + '</div></div></div>' +

    /* 6 — Qualification Criteria */
    '<div class="card settings-card">' + cardHeadHtml(chipHtml('target', '#a5b4fc', 'var(--indigo-soft)'), 'Qualification Criteria', 'Filter who the AI engages with') +
    '<div class="set-two"><div class="set-field"><div class="field-label">Languages</div>' +
    '<input id="set-languages" type="text" placeholder="English" value="' + esc(s.languages) + '"></div>' +
    '<div class="set-field"><div class="field-label">Minimum Age</div>' +
    '<input id="set-minage" type="text" placeholder="18" value="' + esc(s.min_age) + '"></div></div></div>' +

    /* 7 — Flag Handling */
    '<div class="card settings-card">' + cardHeadHtml(chipHtml('alert', 'var(--red)', 'var(--red-soft)'), 'Flag Handling', 'Choose which scenarios pull a human in — the AI handles everything else itself') +
    '<p class="set-help" style="margin:-4px 0 4px">Toggle on only the scenarios that should flag a chat for your review. A normal ending (a "no thanks", a cold lead, someone who can\'t afford it) is never flagged unless you turn its scenario on.</p>' +
    '<div class="set-sub"><div class="set-inline"><div class="set-inline-txt"><div class="st">Send final message before flagging</div>' +
    '<p class="set-help">If enabled, this message is queued and sent before the conversation is flagged.</p></div>' +
    switchHtml(s.flag_send_final === '1', '', 'id="set-flag-final"') + '</div></div>' +
    '<div class="set-field"><div class="field-label">Final message</div>' +
    '<textarea id="set-flag-msg" placeholder="No worries, appreciate the reply.">' + esc(s.flag_final_message) + '</textarea>' +
    '<p class="set-help">Fallback message used when no reason-specific message is set.</p></div>' +
    '<div class="set-two">' + flagGrid + '</div></div>' +

    /* 8 — Danger Zone */
    '<div class="card settings-card danger">' + cardHeadHtml(chipHtml('shield', 'var(--red)', 'var(--red-soft)'), 'Danger Zone', 'Irreversible account actions') +
    '<div class="danger-inset" style="margin-bottom:12px"><div class="di-txt"><div class="st">Download Backup</div>' +
    '<p class="set-help">Download a full .sqlite snapshot of your conversations, settings, and account data.</p></div>' +
    '<button class="btn btn-ghost" id="set-backup">' + icon('download', 15) + 'Download backup</button></div>' +
    '<div class="danger-inset"><div class="di-txt"><div class="st">Request Data Deletion</div>' +
    '<p class="set-help">Request deletion of all your data including conversations, settings, and account information.</p></div>' +
    '<a class="btn btn-red-solid" href="mailto:aisetdm@gmail.com?subject=Data%20deletion%20request">' + icon('trash', 15) + 'Email deletion request</a></div>' +
    '<p class="set-help">You can also request deletion by emailing <a href="mailto:aisetdm@gmail.com">aisetdm@gmail.com</a> or by reviewing our <a href="/data-deletion">Data Deletion Policy</a>.</p></div>' +

    /* EXTRA — AI Controls (dmSetter engine, not in SetDM) */
    '<div class="card settings-card">' + cardHeadHtml(chipHtml('shield', 'var(--red)', 'var(--red-soft)'), 'AI Controls', 'dmSetter engine controls') +
    '<div class="set-row"><div><div class="sr-label">Kill switch</div><div class="sr-sub">' + (s.kill_switch === '1' ? 'ON — the AI is paused everywhere' : 'Off — the AI is live') + '</div></div>' +
    switchHtml(s.kill_switch === '1', 'sw-red', 'id="kill-switch"') + '</div>' +
    '<div class="set-row"><div><div class="sr-label">Default mode for new leads</div><div class="sr-sub">Applied when a conversation is created</div></div>' +
    '<select id="default-mode">' + modeOpts + '</select></div>' +
    '<div class="set-row"><div><div class="sr-label">Strip dashes from outbound messages</div><div class="sr-sub">Off by default. When on, em/en dashes and spaced hyphens in every outbound message become commas.</div></div>' +
    switchHtml(s.strip_dashes === '1', '', 'id="set-strip-dashes"') + '</div>' +
    '<div class="set-row"><div><div class="sr-label">AI follow-up #1 (hours)</div><div class="sr-sub">Hours of silence before the AI writes a follow-up from your Follow-up Instructions (AI Script). Blank/0 = no AI follow-ups.</div></div>' +
    '<input id="fu1" type="number" min="0" value="' + esc(s.followup_1_hours || '') + '"></div>' +
    '<div class="set-row"><div><div class="sr-label">AI follow-up #2 (hours)</div><div class="sr-sub">Hours after the first. Blank/0 to stop after #1.</div></div>' +
    '<input id="fu2" type="number" min="0" value="' + esc(s.followup_2_hours || '') + '"></div>' +
    '<div class="set-row"><div><div class="sr-label">AI follow-up #3 (hours)</div><div class="sr-sub">Hours after the second. Blank/0 to disable.</div></div>' +
    '<input id="fu3" type="number" min="0" value="' + esc(s.followup_3_hours || '') + '"></div>' +
    '<div class="set-row"><div><div class="sr-label">AI follow-up #4 (hours)</div><div class="sr-sub">Hours after the third. Blank/0 to disable.</div></div>' +
    '<input id="fu4" type="number" min="0" value="' + esc(s.followup_4_hours || '') + '"></div>' +
    '<div class="set-field" style="margin-top:16px"><div class="field-label">Outbound filter</div>' +
    '<textarea id="set-outbound" class="mono-ph" placeholder="[£$€]\\s*\\d" style="font-family:\'SF Mono\',ui-monospace,monospace;font-size:12.5px">' + esc(outboundText) + '</textarea>' +
    '<p class="set-help">Regex tripwires — matching messages are blocked and flagged, never sent. One per line.</p></div></div>' +

    '</div></div>';

  /* ---- kill switch: save immediately on toggle (unchanged behavior) ---- */
  $('#kill-switch').querySelector('input').addEventListener('change', async (e) => {
    const wasDirty = state.settingsDirty;
    syncSettingsFromDom(); // capture any in-progress edits before they get overwritten below
    try {
      const out = await api('/api/settings', { method: 'PUT', body: { kill_switch: e.target.checked ? '1' : '0' } });
      state.settings = Object.assign({}, state.settings, { settings: Object.assign({}, out.settings, state.settings.settings, { kill_switch: out.settings.kill_switch }) });
      renderKillDot(); renderSettings();
      if (wasDirty) markSettingsDirty(); else setSettingsSaved();
      toast(out.settings.kill_switch === '1' ? 'Kill switch ON — AI paused everywhere' : 'Kill switch off — AI live');
    } catch (err) { toast(err.message, 'err'); }
  });

  /* ---- Call Booking: connect Calendly webhook sync ---- */
  const hookBtn = $('#set-calendly-hook');
  if (hookBtn) hookBtn.addEventListener('click', async () => {
    if (!($('#set-calendly-token').value || '').trim() && !(state.settings.settings || {}).calendly_token_set) { toast('Add your Calendly API token first', 'err'); return; }
    const prevText = hookBtn.textContent;
    hookBtn.disabled = true; hookBtn.textContent = 'Connecting…';
    try {
      await api('/api/calendly/webhook-setup', { method: 'POST' });
      const wasDirty = state.settingsDirty;
      syncSettingsFromDom(); // preserve any in-progress edits before the settings blob is refreshed below
      const fresh = await api('/api/settings');
      state.settings = Object.assign({}, fresh, { settings: Object.assign({}, fresh.settings, state.settings.settings) });
      renderSettings();
      if (wasDirty) markSettingsDirty(); else setSettingsSaved();
      toast('Booking sync connected');
    } catch (err) {
      toast(err.message, 'err');
      hookBtn.disabled = false; hookBtn.textContent = prevText;
    }
  });

  /* ---- Call Booking: reminders editor (add / remove rows) ---- */
  const remAdd = $('#set-rem-add');
  if (remAdd) remAdd.addEventListener('click', () => {
    syncSettingsFromDom();
    state.bookingReminders.push({ hours_before: 24, message: '' });
    renderSettings();
    markSettingsDirty();
  });
  $('#settings-page').querySelectorAll('[data-rem-x]').forEach((b) => b.addEventListener('click', () => {
    syncSettingsFromDom();
    state.bookingReminders.splice(Number(b.dataset.remX), 1);
    renderSettings();
    markSettingsDirty();
  }));

  /* ---- top-right Save: collect every field and PUT ---- */
  $('#settings-save').addEventListener('click', async () => {
    const flagOut = {};
    $('#settings-page').querySelectorAll('[data-flag]').forEach((t) => {
      const v = t.value.trim();
      if (v) flagOut[t.dataset.flag] = v;
    });
    const flagEnabledOut = {};
    $('#settings-page').querySelectorAll('[data-flagen]').forEach((el) => { flagEnabledOut[el.dataset.flagen] = !!el.querySelector('input').checked; });
    const outbound = $('#set-outbound').value.split('\n').map((x) => x.trim()).filter(Boolean);
    const sbtn = $('#settings-save'); const sprev = sbtn.textContent; sbtn.disabled = true; sbtn.textContent = 'Saving…';
    try {
      const out = await api('/api/settings', { method: 'PUT', body: {
        calendar_link: $('#set-calendar').value,
        notify_emails: $('#set-notify').value,
        ...(($('#set-calendly-token').value || '').trim() ? { calendly_token: $('#set-calendly-token').value.trim() } : {}),
        book_in_dms: $('#set-book-dms').checked ? '1' : '0',
        response_min: $('#set-resp-min').value,
        response_max: $('#set-resp-max').value,
        typing_indicator: $('#set-typing').querySelector('input').checked ? '1' : '0',
        languages: $('#set-languages').value,
        min_age: $('#set-minage').value,
        flag_send_final: $('#set-flag-final').querySelector('input').checked ? '1' : '0',
        flag_final_message: $('#set-flag-msg').value,
        flag_messages: JSON.stringify(flagOut),
        flag_enabled: JSON.stringify(flagEnabledOut),
        kill_switch: $('#kill-switch').querySelector('input').checked ? '1' : '0',
        default_mode: $('#default-mode').value,
        strip_dashes: $('#set-strip-dashes').querySelector('input').checked ? '1' : '0',
        followup_1_hours: $('#fu1').value,
        followup_2_hours: $('#fu2').value,
        followup_3_hours: $('#fu3').value,
        followup_4_hours: $('#fu4').value,
        outbound_filter_regexes: JSON.stringify(outbound),
        booking_reminders: JSON.stringify(bookingRemindersFromDom()),
        noshow_message: $('#set-noshow-msg').value,
      } });
      state.settings = Object.assign({}, state.settings, { settings: out.settings });
      renderKillDot(); renderAccount();
      setSettingsSaved();
      toast('Settings saved');
    } catch (e) { toast(e.message, 'err'); sbtn.textContent = sprev; }
    finally { sbtn.disabled = false; }
  });
  state.settingsDirty = false;
  $('#settings-page').addEventListener('input', markSettingsDirty);
  $('#settings-page').addEventListener('change', markSettingsDirty);

  /* ---- Instagram: Refresh Connection reuses loadIgStatus() ---- */
  const igTest = $('#ig-test');
  if (igTest) igTest.addEventListener('click', async () => {
    igTest.disabled = true; igTest.innerHTML = icon('refresh', 15) + 'Refreshing…';
    await loadIgStatus();
    toast(state.igStatus && state.igStatus.account ? 'Connected as @' + state.igStatus.account.username
      : state.igStatus && state.igStatus.configured ? 'Credentials set but token check failed' : 'Not connected yet');
  });
  const igDisc = $('#ig-disconnect');
  if (igDisc) igDisc.addEventListener('click', () => toast('To disconnect, remove IG_PAGE_TOKEN from the server environment.'));
  const igSync = $('#ig-sync');
  if (igSync) igSync.addEventListener('click', async () => {
    const orig = igSync.innerHTML; igSync.disabled = true; igSync.innerHTML = icon('chats', 14) + 'Syncing your Instagram…';
    try {
      const out = await api('/api/instagram/sync-history', { method: 'POST' });
      toast('Synced ' + out.threads + ' chat' + (out.threads === 1 ? '' : 's') + ' — imported ' + out.messages + ' new message' + (out.messages === 1 ? '' : 's'));
      if (state.route === 'messages') loadConvs();
    } catch (e) { toast(e.message, 'err'); }
    finally { igSync.disabled = false; igSync.innerHTML = orig; }
  });

  /* ---- webhook copy field (unchanged behavior) ---- */
  const copyField = $('#settings-page [data-copy]');
  if (copyField) copyField.addEventListener('click', () => {
    const v = copyField.dataset.copy || '';
    if (!v || v === '…') return;
    if (navigator.clipboard) navigator.clipboard.writeText(v).then(() => toast('Webhook URL copied')).catch(() => toast('Copy failed', 'err'));
  });

  /* ---- backup download ---- */
  const backupBtn = $('#set-backup');
  if (backupBtn) backupBtn.addEventListener('click', async () => {
    backupBtn.disabled = true;
    try {
      const res = await fetch('/api/backup', { headers: { 'x-admin-pin': state.pin } });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || ('HTTP ' + res.status));
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'dmsetter-backup.sqlite';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast('Backup downloaded');
    } catch (err) {
      toast(err.message || 'Backup failed', 'err');
    } finally {
      backupBtn.disabled = false;
    }
  });

  /* ---- toast-only stubs ---- */
  const del = $('#set-delete');
  if (del) del.addEventListener('click', () => toast('Data deletion is handled manually — email aisetdm@gmail.com.'));
  const invite = $('#set-invite');
  if (invite) invite.addEventListener('click', () => toast('Team invites are coming soon.'));
}

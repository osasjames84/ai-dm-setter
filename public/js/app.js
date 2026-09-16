'use strict';
/* ============================== global bits ============================== */
function renderKillDot() {
  // The sidebar "AI active" indicator was removed; the kill switch lives in
  // Settings › AI Controls. Kept null-safe in case other code calls this.
  const dot = $('#kill-dot'), txt = $('#kill-text');
  if (!dot && !txt) return;
  const on = state.settings && state.settings.settings && state.settings.settings.kill_switch === '1';
  if (dot) dot.classList.toggle('off', !!on);
  if (txt) txt.textContent = on ? 'AI paused' : 'AI active';
}
function renderAccount() {
  const coach = ((state.settings && state.settings.settings && state.settings.settings.coach_name) || '').trim();
  $('#acc-name').textContent = coach || 'My account';
  $('#acc-avatar').textContent = (coach || 'M').charAt(0).toUpperCase();
  $('#acc-sub').textContent = state.settings && state.settings.igConfigured ? 'Instagram connected' : 'Simulator mode';
}
async function loadSettings() {
  try { state.settings = await api('/api/settings'); renderKillDot(); renderAccount(); } catch (e) { /* ignore */ }
}

window.addEventListener('beforeunload', (e) => {
  if (state.scriptDirty || state.settingsDirty) { e.preventDefault(); e.returnValue = ''; }
});

/* ============================== poll loop ============================== */
setInterval(() => {
  if (!state.pin || document.hidden || $('#app').classList.contains('hidden')) return;
  // Never overwrite the settings baseline while the owner is mid-edit on a page
  // that renders from it — a save from another tab would silently replace his work.
  const editing = (state.route === 'prompt' && state.scriptDirty) || (state.route === 'settings' && state.settingsDirty);
  if (!editing) loadSettings();
  refreshBadge();
  if (Date.now() - lastIgStatusAt > 10 * 60 * 1000) loadIgStatus(); // IG Graph call is expensive — refresh the auth-error dot at most every 10 min
  if (state.route === 'dashboard') loadDashboard();
  if (state.route === 'messages') { loadConvs(); if (state.activeId) loadThread(state.activeId); }
  if (state.route === 'drafts') loadDrafts();
}, 5000);

/* ============================== boot ============================== */
async function boot() {
  await loadSettings();
  await refreshBadge();
  loadIgStatus(); // fire-and-forget: populates state.igStatus so the sidebar dot can show app-wide
  messagesScaffold();
  renderNav();
  go('dashboard');
}
/* ============================== theme (light/dark) ============================== */
function renderThemeToggle() {
  const light = document.documentElement.getAttribute('data-theme') === 'light';
  const ico = $('#theme-ico'), label = $('#theme-label');
  if (ico) ico.innerHTML = icon(light ? 'moon' : 'sun', 17);
  if (label) label.textContent = light ? 'Dark Mode' : 'Light Mode';
}
function setupTheme() {
  document.documentElement.setAttribute('data-theme', localStorage.getItem('dmsetter-theme') || 'dark');
  renderThemeToggle();
  const btn = $('#theme-toggle');
  if (btn) btn.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('dmsetter-theme', next);
    renderThemeToggle();
    if (state.route === 'dashboard') loadDashboard(); // re-render funnel svg with theme colors
  });
}

setupTheme();
hydrateIcons(document);
if (state.pin) {
  api('/api/auth', { method: 'POST' })
    .then(() => { $('#login').classList.add('hidden'); $('#app').classList.remove('hidden'); boot(); })
    .catch(() => { /* stays on login */ });
} else {
  $('#pin-input').focus();
}

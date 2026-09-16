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
  const me = state.me;
  if (!me) return;
  const name = me.account.name || me.user.email || 'My account';
  const access = me.account.access_status;
  $('#acc-name').textContent = name;
  $('#acc-avatar').textContent = name.charAt(0).toUpperCase();
  const ig = me.instagram || {};
  $('#acc-sub').textContent = access === 'pending' ? 'Awaiting approval' : access === 'paused' ? 'Access paused' : ig.needs_reconnect ? 'Reconnect Instagram' : ig.connected ? 'Instagram connected' : 'Instagram not connected';
  $('#acc-sub').classList.toggle('connection-warning', !!ig.needs_reconnect);
  const banner = $('#account-access-banner');
  banner.textContent = access === 'pending' ? 'Your account is awaiting approval. You can prepare your setup while you wait.' : access === 'paused' ? 'Account access is paused. You can still read your inbox. Contact JD to reactivate.' : '';
  banner.classList.toggle('hidden', !banner.textContent);
  document.documentElement.classList.toggle('has-access-banner', !!banner.textContent);
}
async function loadSettings() {
  try { state.settings = await api('/api/settings'); renderKillDot(); renderAccount(); } catch (e) { /* ignore */ }
}

window.addEventListener('beforeunload', (e) => {
  if (state.scriptDirty || state.settingsDirty || state.onboardingDirty) { e.preventDefault(); e.returnValue = ''; }
});

/* ============================== poll loop ============================== */
setInterval(() => {
  if (!state.authenticated || document.hidden || $('#app').classList.contains('hidden')) return;
  // Never overwrite the settings baseline while the owner is mid-edit on a page
  // that renders from it — a save from another tab would silently replace his work.
  const editing = state.route === 'onboarding' || (state.route === 'prompt' && state.scriptDirty) || (state.route === 'settings' && state.settingsDirty);
  if (!editing) loadSettings();
  loadIdentity().catch((err) => { if (err.status === 401 && state.authenticated) showLogin('Your session expired. Request a new sign-in link.'); });
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
  go(state.me?.onboarding_complete ? 'dashboard' : 'onboarding');
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
restoreSession();

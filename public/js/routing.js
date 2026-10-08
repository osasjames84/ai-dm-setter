'use strict';
/* ============================== nav / routing ============================== */
const NAV = [
  { id: 'onboarding', label: 'Setup', icon: 'check', setupOnly: true },
  { id: 'dashboard', label: 'Dashboard', icon: 'grid' },
  { id: 'messages', label: 'Messages', icon: 'chat' },
  { id: 'drafts', label: 'Drafts', icon: 'inbox', badge: true },
  { id: 'prompt', label: 'Prompt', icon: 'filetext' },
  { id: 'content', label: 'Content', icon: 'bulb', pill: 'NEW' },
  { id: 'settings', label: 'Settings', icon: 'gear' },
];
// Everything administrative lives under Settings as tabs, not in the sidebar.
const SETTINGS_TABS = [
  { id: 'settings', label: 'General' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'versions', label: 'Script versions' },
  { id: 'team', label: 'Team' },
  { id: 'operator', label: 'Accounts', adminOnly: true },
  { id: 'onboarding', label: 'Setup', jump: true },
];
const isSettingsRoute = (r) => SETTINGS_TABS.some((t) => t.id === r && !t.jump);
function renderSettingsTabs() {
  const host = $('#settings-tabs');
  if (!host) return;
  const admin = !!state.me?.user?.is_platform_admin;
  host.innerHTML = SETTINGS_TABS.filter((t) => !t.adminOnly || admin).map((t) =>
    '<button class="chip' + (state.route === t.id ? ' on' : '') + '" data-tab="' + t.id + '">' + esc(t.label) + '</button>').join('');
  host.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => go(b.dataset.tab)));
  SETTINGS_TABS.filter((t) => !t.jump).forEach((t) => { const pane = $('#' + (t.id === 'settings' ? 'settings' : t.id) + '-page'); if (pane) pane.classList.toggle('hidden', t.id !== state.route); });
}
function renderNav() {
  $('#nav').innerHTML = NAV.filter((n) => !n.setupOnly || !state.me?.onboarding_complete).map((n) => {
    const badge = n.badge && state.drafts.length ? '<span class="nav-badge">' + state.drafts.length + '</span>' : '';
    const pill = n.pill ? '<span class="nav-pill">' + n.pill + '</span>' : '';
    const dot = n.id === 'settings' && state.igStatus && state.igStatus.auth_error ? '<span class="nav-dot" title="Instagram disconnected"></span>' : '';
    const active = state.route === n.id || (n.id === 'settings' && isSettingsRoute(state.route));
    return '<button class="nav-item' + (active ? ' active' : '') + '" aria-label="' + esc(n.label) + '" title="' + esc(n.label) + '" data-route="' + n.id + '">' +
      icon(n.icon, 18) + dot + '<span class="nav-label">' + n.label + '</span>' + pill + badge + '</button>';
  }).join('');
  $('#nav').querySelectorAll('[data-route]').forEach((b) => b.addEventListener('click', () => go(b.dataset.route)));
  // Phone layout: the nav is a scrollable bottom bar, so keep the active tab in view.
  const active = $('#nav').querySelector('.nav-item.active');
  if (active && window.matchMedia && window.matchMedia('(max-width: 680px)').matches) active.scrollIntoView({ block: 'nearest', inline: 'center' });
}
function go(route) {
  if(state.versionSaving){toast('Please wait for the version save to finish.');return;}
  if(state.versionNoteDirty){if(!confirm('Discard your unsaved version note?'))return;state.versionNoteDirty=false;}
  if(state.onboardingSaving){toast('Please wait for your setup changes to finish saving.');return;}
  if (route === state.route && (state.scriptDirty || state.settingsDirty || state.onboardingDirty)) return;
  if (route !== state.route) {
    if (state.onboardingDirty && !confirm('Leave without saving your setup script?')) return;
    state.onboardingDirty = false;
    if (state.route === 'prompt' && state.scriptDirty && !confirm('You have unsaved changes to your AI Script. Leave without saving?')) return;
    if (state.route === 'settings' && state.settingsDirty && !confirm('You have unsaved Settings changes. Leave without saving?')) return;
    state.scriptDirty = false; state.settingsDirty = false;
  }
  state.route = route;
  const viewId = isSettingsRoute(route) ? 'settings' : route;
  ['onboarding', 'dashboard', 'messages', 'drafts', 'prompt', 'content', 'settings'].forEach((r) => {
    $('#view-' + r).classList.toggle('hidden', r !== viewId);
  });
  if (isSettingsRoute(route)) renderSettingsTabs();
  // one-shot fadeUp on the view that just became visible (re-add to retrigger)
  const view = $('#view-' + viewId);
  if (view) { view.classList.remove('view-enter'); void view.offsetWidth; view.classList.add('view-enter'); }
  renderNav();
  if (route === 'onboarding') renderOnboarding();
  if (route === 'dashboard') loadDashboard();
  if (route === 'messages') { loadConvs(); if (state.activeId) loadThread(state.activeId); else renderThread(); }
  if (route === 'drafts') loadDrafts();
  if (route === 'prompt') renderPrompt();
  if (route === 'content') renderContent();
  if (route === 'settings') renderSettings();
  if (route === 'team') renderTeam();
  if (route === 'operator') renderOperator();
  if (route === 'versions') renderVersions();
  if (route === 'analytics') renderAnalytics();
}

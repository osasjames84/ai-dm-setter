'use strict';
/* ============================== nav / routing ============================== */
const NAV = [
  { id: 'onboarding', label: 'Setup', icon: 'check' },
  { id: 'dashboard', label: 'Dashboard', icon: 'grid' },
  { id: 'messages', label: 'Messages', icon: 'chat' },
  { id: 'drafts', label: 'Drafts', icon: 'inbox', badge: true },
  { id: 'prompt', label: 'Prompt', icon: 'filetext' },
  { id: 'content', label: 'Content', icon: 'bulb', pill: 'NEW' },
  { id: 'settings', label: 'Settings', icon: 'gear' },
];
function renderNav() {
  $('#nav').innerHTML = NAV.map((n) => {
    const badge = n.badge && state.drafts.length ? '<span class="nav-badge">' + state.drafts.length + '</span>' : '';
    const pill = n.pill ? '<span class="nav-pill">' + n.pill + '</span>' : '';
    const dot = n.id === 'settings' && state.igStatus && state.igStatus.auth_error ? '<span class="nav-dot" title="Instagram disconnected"></span>' : '';
    return '<button class="nav-item' + (state.route === n.id ? ' active' : '') + '" aria-label="' + esc(n.label) + '" title="' + esc(n.label) + '" data-route="' + n.id + '">' +
      icon(n.icon, 18) + dot + '<span class="nav-label">' + n.label + '</span>' + pill + badge + '</button>';
  }).join('');
  $('#nav').querySelectorAll('[data-route]').forEach((b) => b.addEventListener('click', () => go(b.dataset.route)));
}
function go(route) {
  if (route === state.route && (state.scriptDirty || state.settingsDirty || state.onboardingDirty)) return;
  if (route !== state.route) {
    if (state.onboardingDirty && !confirm('Leave without saving your setup script?')) return;
    state.onboardingDirty = false;
    if (state.route === 'prompt' && state.scriptDirty && !confirm('You have unsaved changes to your AI Script. Leave without saving?')) return;
    if (state.route === 'settings' && state.settingsDirty && !confirm('You have unsaved Settings changes. Leave without saving?')) return;
    state.scriptDirty = false; state.settingsDirty = false;
  }
  state.route = route;
  ['onboarding', 'dashboard', 'messages', 'drafts', 'prompt', 'content', 'settings'].forEach((r) => {
    $('#view-' + r).classList.toggle('hidden', r !== route);
  });
  // one-shot fadeUp on the view that just became visible (re-add to retrigger)
  const view = $('#view-' + route);
  if (view) { view.classList.remove('view-enter'); void view.offsetWidth; view.classList.add('view-enter'); }
  renderNav();
  if (route === 'onboarding') renderOnboarding();
  if (route === 'dashboard') loadDashboard();
  if (route === 'messages') { loadConvs(); if (state.activeId) loadThread(state.activeId); else renderThread(); }
  if (route === 'drafts') loadDrafts();
  if (route === 'prompt') renderPrompt();
  if (route === 'content') renderContent();
  if (route === 'settings') renderSettings();
}

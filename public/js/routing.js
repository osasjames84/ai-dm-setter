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
  }).join('') + '<button class="nav-item nav-more" id="nav-more" aria-haspopup="dialog" aria-expanded="false" aria-controls="more-sheet" aria-label="More">' + icon('plus', 18) + '<span class="nav-label">More</span></button>';
  $('#nav').querySelectorAll('[data-route]').forEach((b) => b.addEventListener('click', () => go(b.dataset.route)));
  const moreBtn = $('#nav-more');
  if (moreBtn) {
    const inMore = ['onboarding', 'content', 'settings'].includes(state.route) || isSettingsRoute(state.route);
    moreBtn.classList.toggle('active', inMore);
    moreBtn.addEventListener('click', openMoreSheet);
  }
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

/* Phone layout: the bottom bar holds the four main routes plus More; the rest
   (Setup, Content, Settings, theme, log out) live in this sheet. */
function openMoreSheet() {
  closeMoreSheet();
  const btn = $('#nav-more');
  const items = NAV.filter((n) => ['onboarding', 'content', 'settings'].includes(n.id) && (!n.setupOnly || !state.me?.onboarding_complete));
  const sheet = document.createElement('div');
  sheet.id = 'more-sheet';
  sheet.className = 'more-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', 'More');
  const themeLabel = ($('#theme-label') && $('#theme-label').textContent) || 'Switch theme';
  sheet.innerHTML = '<div class="more-backdrop" data-close></div><div class="more-panel">' +
    items.map((n) => '<button class="more-item" data-route="' + n.id + '">' + icon(n.icon, 18) + '<span>' + esc(n.label) + '</span></button>').join('') +
    '<button class="more-item" data-act="theme">' + icon('bulb', 18) + '<span>' + esc(themeLabel) + '</span></button>' +
    '<button class="more-item" data-act="logout">' + icon('logout', 18) + '<span>Log out</span></button>' +
    '<button class="more-item more-close" data-close>Close</button></div>';
  document.body.appendChild(sheet);
  if (btn) btn.setAttribute('aria-expanded', 'true');
  sheet.querySelectorAll('[data-route]').forEach((b) => b.addEventListener('click', () => { closeMoreSheet(); go(b.dataset.route); }));
  sheet.querySelector('[data-act="theme"]').addEventListener('click', () => { closeMoreSheet(); $('#theme-toggle') && $('#theme-toggle').click(); });
  sheet.querySelector('[data-act="logout"]').addEventListener('click', () => { closeMoreSheet(); $('#logout-btn') && $('#logout-btn').click(); });
  sheet.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeMoreSheet(true)));
  const focusables = () => [...sheet.querySelectorAll('button')];
  sheet.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeMoreSheet(true); return; }
    if (e.key === 'Tab') {
      const f = focusables(), first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  focusables()[0] && focusables()[0].focus();
}
function closeMoreSheet(returnFocus) {
  const sheet = $('#more-sheet');
  if (!sheet) return;
  sheet.remove();
  const btn = $('#nav-more');
  if (btn) { btn.setAttribute('aria-expanded', 'false'); if (returnFocus) btn.focus(); }
}

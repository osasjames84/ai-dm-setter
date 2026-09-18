'use strict';
const signedOutState = structuredClone(state);
sessionStorage.removeItem('pin');
function showLogin(message = '') {
  stopLiveEvents();
  const epoch = state.sessionEpoch + 1;
  Object.assign(state, structuredClone(signedOutState), { sessionEpoch: epoch });
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  $('#login-form').classList.remove('hidden');
  $('#login-sent').classList.add('hidden');
  $('#login-err').textContent = message;
  $('#login-retry').classList.add('hidden');
  for (const id of ['analytics-page','versions-page','team-page','operator-page','onboarding-page','dash-page','view-messages','drafts-page','prompt-page','content-page','settings-page']) {
    const el = document.getElementById(id); if (el) el.replaceChildren();
  }
  document.title='dmSetter';
  $('#toasts').replaceChildren();
  if (typeof _hideXpop === 'function') _hideXpop();
  $('#login-email').focus();
}
async function logout() {
  if ((state.versionNoteDirty || state.scriptDirty || state.settingsDirty || state.onboardingDirty || messageDraftsPending()) && !confirm('Log out and leave unsaved changes?')) return;
  const button = $('#logout-btn'); button.disabled = true;
  try {
    await api('/api/logout', { method: 'POST' });
    showLogin();
    $('#login-email').value = '';
  } catch (err) { toast('Could not log out. ' + err.message, 'err'); }
  finally { button.disabled = false; }
}
async function requestSignIn(event) {
  event.preventDefault();
  const form = $('#login-form');
  if (!form.reportValidity()) return;
  const email = $('#login-email').value.trim();
  const button = $('#login-send'); if (button.disabled) return;
  button.disabled = true; button.textContent = 'Sending…'; $('#login-err').textContent = '';
  try {
    const r = await api('/api/auth/magic-link', { method:'POST', body:{email}, allowUnauthenticated:true });
    if (r && r.signed_in) { location.replace('/'); return; }
    $('#login-address').textContent = email;
    form.classList.add('hidden'); $('#login-sent').classList.remove('hidden');
    $('#login-change').focus();
  } catch (err) {
    $('#login-err').textContent = err.status === 429 ? 'Too many requests. Please wait a moment and try again.' : err.message;
  } finally { button.disabled = false; button.textContent = 'Send sign-in link'; }
}
async function loadIdentity() {
  const me = await api('/api/me', { allowUnauthenticated:true });
  if (!me.user?.id || !me.account?.id) throw new Error('Unable to load your account. Please retry.');
  state.me = me;
  renderAccount();
  return me;
}
async function restoreSession() {
  const retry = $('#login-retry'); retry.disabled = true;
  $('#login-send').disabled = true;
  try {
    await loadIdentity();
    state.authenticated = true;
    $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
    await boot();
  } catch (err) {
    showLogin(err.status === 401 ? '' : 'Could not connect to your account. Please retry.');
    if (err.status !== 401) retry.classList.remove('hidden');
  } finally { retry.disabled = false; $('#login-send').disabled = false; }
}
$('#login-form').addEventListener('submit', requestSignIn);
$('#login-change').addEventListener('click', () => {
  $('#login-form').classList.remove('hidden'); $('#login-sent').classList.add('hidden');
  $('#login-err').textContent = ''; $('#login-email').focus();
});
$('#login-retry').addEventListener('click', restoreSession);
$('#logout-btn').addEventListener('click', logout);

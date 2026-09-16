'use strict';
/* ============================== auth ============================== */
function logout() {
  state.pin = '';
  sessionStorage.removeItem('pin');
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  $('#pin-input').value = '';
  $('#pin-input').focus();
}
async function tryLogin() {
  const pin = $('#pin-input').value.trim();
  if (!pin) return;
  state.pin = pin;
  try {
    await api('/api/auth', { method: 'POST' });
    sessionStorage.setItem('pin', pin);
    $('#login-err').textContent = '';
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    boot();
  } catch (e) {
    state.pin = '';
    $('#login-err').textContent = 'Wrong PIN — try again';
  }
}
$('#pin-go').addEventListener('click', tryLogin);
$('#pin-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryLogin(); });
$('#logout-btn').addEventListener('click', logout);

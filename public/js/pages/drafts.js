'use strict';
/* ============================== drafts page ============================== */
async function loadDrafts() {
  try { state.drafts = await api('/api/drafts'); } catch (e) { return; }
  renderNav();
  const page = $('#drafts-page');
  if (!page) return;
  const sendable = state.drafts.filter((d) => !d.needs_human).length;
  page.innerHTML = '<div class="page-head"><div><h1>Drafts</h1>' +
    '<div class="sub">Copilot replies waiting for your approval before anything reaches a lead.</div></div>' +
    (sendable ? '<button class="btn btn-primary" id="drafts-send-all">' + icon('send', 15) + 'Send all (' + sendable + ')</button>' : '') +
    '</div>' +
    (!state.drafts.length
      ? '<div class="card coming-card"><div class="icon-chip" style="background:var(--indigo-soft);color:var(--accent-text)">' + icon('inbox', 24) + '</div>' +
        '<h2>No drafts waiting</h2><p>When the AI writes a reply in Copilot mode it lands here (and in the thread) for your sign-off.</p></div>'
      : '<div class="drafts-list">' + state.drafts.map((d) => {
        return '<div class="card draft-item">' +
          '<div class="draft-item-head">' + avatarHtml(d.handle, d.display_name, 36) +
          '<div><div class="dh-name">' + esc(d.display_name || d.handle) + '</div>' +
          '<div class="dh-sub">@' + esc(d.handle) + ' &middot; ' + STAGE_ONE[d.conv_stage] + (d.stage_suggestion ? ' &rarr; ' + STAGE_ONE[d.stage_suggestion] : '') + '</div></div>' +
          '<div class="spacer"></div>' +
          (d.needs_human ? '<span class="tag amber">' + esc(draftReasonText(d.reason)) + '</span>' : '') +
          '<span class="tag">' + (timeAgo(d.created_at) === 'now' ? 'just now' : timeAgo(d.created_at) + ' ago') + '</span></div>' +
          d.messages.filter((m) => String(m || '').trim()).map((m) => '<div class="draft-msg">' + esc(m) + '</div>').join('') +
          '<div class="draft-actions">' +
          '<button class="btn btn-primary btn-sm" data-approve="' + d.id + '">' + icon('check', 14) + 'Approve &amp; send</button>' +
          '<button class="btn btn-ghost btn-sm" data-open="' + d.conversation_id + '">Open conversation</button>' +
          '<button class="btn btn-ghost btn-sm" data-discard="' + d.id + '">Discard</button></div>' +
          '</div>';
      }).join('') + '</div>');
  page.querySelectorAll('[data-approve]').forEach((b) => b.addEventListener('click', () => approveDraft(Number(b.dataset.approve))));
  page.querySelectorAll('[data-discard]').forEach((b) => b.addEventListener('click', () => discardDraft(Number(b.dataset.discard))));
  page.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => {
    state.activeId = b.dataset.open; go('messages');
  }));
  const sendAllBtn = page.querySelector('#drafts-send-all');
  if (sendAllBtn) sendAllBtn.addEventListener('click', () => sendAllDrafts(sendAllBtn));
}
/** Fire every sendable pending draft in one click; flagged and outside-window
 *  drafts are skipped server-side and reported in the summary toast. */
async function sendAllDrafts(btn) {
  const n = state.drafts.filter((d) => !d.needs_human).length;
  if (!confirm('Send ' + n + ' draft' + (n === 1 ? '' : 's') + ' to their leads now?')) return;
  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    const r = await api('/api/drafts/send-all', { method: 'POST' });
    const parts = [r.sent + ' sent'];
    if (r.window) parts.push(r.window + ' outside the 24h window, reply from the Instagram app');
    if (r.parked) parts.push(r.parked + ' held for review (send limits or Instagram connection)');
    if (r.flagged) parts.push(r.flagged + ' flagged, left for review');
    if (r.blocked) parts.push(r.blocked + ' blocked by the outbound filter');
    if (r.failed) parts.push(r.failed + ' failed');
    toast(parts.join(' · '), r.blocked || r.failed ? 'err' : undefined);
  } catch (e) { toast(e.message, 'err'); }
  loadDrafts(); refreshBadge();
}
/** Approve a draft as-is (sends the AI's original messages). */
async function approveDraft(id) {
  try { await api('/api/drafts/' + id + '/approve', { method: 'POST' }); toast('Sent to the lead'); loadDrafts(); }
  catch (e) { toast(e.status === 422 ? 'Blocked by the outbound filter and flagged for review' : e.message, 'err'); loadDrafts(); }
}
async function discardDraft(id) {
  if (!confirm('Discard this draft? It will be removed without sending.')) return;
  try { await api('/api/drafts/' + id + '/discard', { method: 'POST' }); loadDrafts(); }
  catch (e) { toast(e.message, 'err'); }
}
async function refreshBadge() {
  try { state.drafts = await api('/api/drafts'); renderNav(); } catch (e) { /* ignore */ }
}

/** Human sentences for machine reason codes on drafts; never show raw codes. */
function draftReasonText(r) {
  const known = {
    ai_not_configured: 'AI is not set up on this server yet',
    ai_error: 'The AI could not write a reply',
    needs_human: 'Needs your review',
  };
  const k = String(r || '').trim();
  if (!k) return 'Needs your review';
  if (known[k.toLowerCase()]) return known[k.toLowerCase()];
  return /^[A-Z0-9_]+$/.test(k) || /^[a-z0-9]+(_[a-z0-9]+)+$/.test(k) ? 'Needs your review' : k;
}

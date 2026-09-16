'use strict';
function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = icon(kind === 'err' ? 'alert' : 'check', 16) + '<span>' + esc(msg) + '</span>';
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

/* ============================== helpers ============================== */
const STAGES = ['lead', 'engaged', 'qualifying', 'qualified', 'booking_sent', 'call_booked', 'sale', 'routed', 'dead'];
const FUNNEL = STAGES.slice(0, 7);
// The reference dashboard presents routed/community leads as a nurturing lane
// between booked calls and sales. This is display-only; the persisted stage
// remains `routed`, so no funnel or automation behaviour changes.
const DASH_FUNNEL = ['lead', 'engaged', 'qualifying', 'qualified', 'booking_sent', 'call_booked', 'routed', 'sale'];
// Totals is a TRUE funnel: routed ("Nurturing") is a side exit — someone can be
// nurtured without ever reaching booking, so it breaks the descending order there.
// It stays in the Current pipeline row (status board) and the outcome strip.
const DASH_TOTALS = DASH_FUNNEL.filter((s) => s !== 'routed');
const DASH_STAGE_LABEL = { routed: 'Nurturing' };
const STAGE_LABEL = {
  lead: 'Leads', engaged: 'Engaged', qualifying: 'Qualifying', qualified: 'Qualified',
  booking_sent: 'Booking Sent', call_booked: 'Calls Booked', sale: 'Sales', routed: 'Routed', dead: 'Dead',
};
const STAGE_ONE = {
  lead: 'Lead', engaged: 'Engaged', qualifying: 'Qualifying', qualified: 'Qualified',
  booking_sent: 'Booking Sent', call_booked: 'Call Booked', sale: 'Sale', routed: 'Routed', dead: 'Dead',
};
const STAGE_INFO = {
  lead: 'New conversation, no meaningful exchange yet',
  engaged: 'The lead has meaningfully replied at least once',
  qualifying: 'The AI is learning their goal and situation',
  qualified: 'They fit and are warm — moving toward booking',
  booking_sent: 'Call times proposed, waiting on a pick',
  call_booked: 'A concrete day + time agreed (human-confirmed)',
  sale: 'Completed purchase (human-confirmed)',
  routed: 'Sent to the community or free guide instead',
  dead: 'Gone cold or not a fit — revivable',
};
// SetDM's stage colours (HSL tokens lifted from their stylesheet). Small solid
// pills; text is white on the saturated stages, near-white on the greys.
const STAGE_HSL = {
  lead: '230 15% 62%', engaged: '217 91% 60%', qualifying: '245 75% 60%',
  qualified: '270 70% 60%', booking_sent: '35 95% 58%', call_booked: '25 95% 55%',
  sale: '142 70% 45%', routed: '195 85% 48%', dead: '230 10% 48%',
};
function stageBadge(stage, extraCls) {
  return '<span class="stage-badge ' + (extraCls || '') + '" style="background:hsl(' + (STAGE_HSL[stage] || STAGE_HSL.lead) + ')">' + STAGE_ONE[stage] + '</span>';
}
// SetDM avatars are flat dark circles with the initial (real IG photos would
// replace them). We match: solid --secondary fill, no gradients.
function avatarHtml(handle, name, size, extra) {
  const ch = (name || handle || '?').trim().charAt(0).toUpperCase() || '?';
  return '<div class="avatar" style="width:' + size + 'px;height:' + size + 'px;font-size:' + Math.round(size * 0.4) + 'px">' + esc(ch) + (extra || '') + '</div>';
}
function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}
/* Smart duration formatter for reply-latency stats: seconds → 'Xs', minutes → 'Xm', else 'Xh'. */
function fmtDuration(sec) {
  if (sec == null || isNaN(sec)) return null;
  if (sec < 90) return Math.round(sec) + 's';
  if (sec < 5400) return Math.round(sec / 60) + 'm';
  return Math.round(sec / 3600) + 'h';
}
function timeFmt(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return today ? hm : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + hm;
}
/* Full weekday + date + time for a booked call, e.g. "Tue, 9 Jul, 14:30". */
function callTimeFmt(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function switchHtml(on, cls, attrs) {
  return '<label class="switch ' + (cls || '') + '" ' + (attrs || '') + '><input type="checkbox"' + (on ? ' checked' : '') + '><span class="track"></span><span class="knob"></span></label>';
}

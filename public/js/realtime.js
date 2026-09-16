'use strict';
let liveEvents=null,liveRefreshTimer=null;
function setLiveStatus(connected) {
  state.eventsConnected=connected;
  const status=$('#live-status');if(status)status.textContent=connected?'Live updates connected':'Reconnecting live updates · checking every 5 seconds';
}
function stopLiveEvents() {
  liveEvents?.close();liveEvents=null;clearTimeout(liveRefreshTimer);liveRefreshTimer=null;state.eventsConnected=false;state.pendingSettingsEvent=false;
}
async function refreshVisibleData(type='conversation') {
  if(!state.authenticated || document.hidden)return;
  if(state.route==='messages'){await loadConvs();if(state.activeId)await loadThread(state.activeId);}
  else if(state.route==='drafts')await loadDrafts();
  else if(state.route==='dashboard')await loadDashboard();
  else if(state.route==='analytics')await renderAnalytics();
  if(type==='settings'){
    if(state.scriptDirty || state.settingsDirty || state.onboardingDirty || state.versionNoteDirty || state.onboardingSaving || state.versionSaving){toast('Settings changed. Finish your edits before refreshing.');return;}
    await loadSettings();
    if(state.scriptDirty || state.settingsDirty || state.onboardingDirty || state.versionNoteDirty || state.onboardingSaving || state.versionSaving)return;
    if(state.route==='prompt')renderPrompt();
    if(state.route==='settings')renderSettings();
    if(state.route==='onboarding')await renderOnboarding();
    if(state.route==='versions')await renderVersions();
  }
  await refreshBadge();
}
function startLiveEvents() {
  stopLiveEvents();setLiveStatus(false);
  if(typeof EventSource==='undefined')return;
  const epoch=state.sessionEpoch,source=new EventSource('/api/events',{withCredentials:true});liveEvents=source;
  const valid=()=>liveEvents===source && state.authenticated && epoch===state.sessionEpoch;
  const connected=()=>{if(!valid())return;setLiveStatus(true);refreshVisibleData().catch(()=>{});};
  source.addEventListener('hello',connected);
  source.addEventListener('change',event=>{
    if(!valid())return;
    let data;try{data=JSON.parse(event.data);}catch{return;}
    if(!['message','draft','conversation','settings'].includes(data.type))return;
    state.pendingSettingsEvent=state.pendingSettingsEvent || data.type==='settings';
    clearTimeout(liveRefreshTimer);liveRefreshTimer=setTimeout(()=>{if(!valid())return;const type=state.pendingSettingsEvent?'settings':data.type;state.pendingSettingsEvent=false;refreshVisibleData(type).catch(()=>{});},200);
  });
  source.onerror=()=>{if(!valid())return;setLiveStatus(false);loadIdentity().catch(err=>{if(err.status===401 && valid())showLogin('Your session expired. Request a new sign-in link.');});};
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden && state.authenticated)refreshVisibleData().catch(()=>{});});
function enforceAccessControls() {
  if(!state.me)return;
  const blocked=state.me.account.access_status!=='active';
  document.querySelectorAll('#pv-send,#approve-btn,[data-approve],#ai-response-btn,#send-btn').forEach(button=>{
    if(blocked){if(!button.dataset.accessBlocked)button.dataset.beforeAccessDisabled=String(button.disabled);button.dataset.accessBlocked='1';button.disabled=true;button.title='Active account access is required.';}
    else if(button.dataset.accessBlocked){button.disabled=button.dataset.beforeAccessDisabled==='true';delete button.dataset.accessBlocked;delete button.dataset.beforeAccessDisabled;button.removeAttribute('title');}
  });
}
new MutationObserver(enforceAccessControls).observe(document.getElementById('app'),{childList:true,subtree:true});

'use strict';
function instagramCard(st) {
  const ig=st || state.me?.instagram || {};
  const connected=ig.connected ?? !!ig.account;
  const reconnect=ig.needs_reconnect || !!ig.auth_error;
  const owner=state.me?.user?.role==='owner';
  return '<div class="set-sub"><h2>Instagram</h2><p>'+esc(reconnect?'Instagram needs reconnecting.':connected?'Connected'+(ig.username || ig.account?.username ? ' as @'+(ig.username || ig.account.username):''):'Connect your business Instagram account to receive messages.')+'</p>'+
    (owner && ig.oauth_available!==false?'<a class="btn btn-primary" href="/auth/instagram/start">'+(reconnect?'Reconnect Instagram':'Connect Instagram')+'</a>':'<p>'+(owner?'Instagram login is not configured on this server yet.':'Ask your account owner to manage this connection.')+'</p>')+
    '<button class="btn btn-ghost" id="ig-test">Refresh connection</button>'+
    (connected && owner?'<button class="btn btn-ghost" id="ig-disconnect">Disconnect</button>':'')+'<p role="status" id="ig-action-status"></p></div>';
}
function bindInstagram(host,refresh) {
  host.querySelector('#ig-test')?.addEventListener('click',async e=>{
    const button=e.currentTarget;button.disabled=true;
    try{await refresh();}catch(err){if(host.isConnected)host.querySelector('#ig-action-status').textContent=setupError(err);}
    finally{button.disabled=false;}
  });
  host.querySelector('#ig-disconnect')?.addEventListener('click',async e=>{
    if(!confirm('Disconnect Instagram? Incoming messages and automation will stop until you reconnect.'))return;
    e.target.disabled=true;
    try {await api('/api/instagram/disconnect',{method:'POST'}); await loadIdentity(); await refresh();}
    catch(err){host.querySelector('#ig-action-status').textContent=setupError(err);e.target.disabled=false;}
  });
}
function renderNextStep(body) {
  const s=state.settings.settings;
  body.innerHTML='<h2>Choose the next step</h2><form id="goal-form"><label for="goal-type">What should a qualified customer do?</label><select id="goal-type"><option value="call">Book a call</option><option value="checkout">Visit your checkout</option><option value="form">Complete a form</option><option value="human">Talk to a person</option></select><label for="goal-link">Destination link</label><input id="goal-link" type="url" placeholder="https://…"><p class="set-help">Use your own booking, checkout or form link. Human handoffs use your script instructions.</p><button class="btn btn-primary">Save next step</button><p role="status" id="goal-status"></p></form>';
  const form=body.querySelector('form'),type=body.querySelector('select'),link=body.querySelector('input'),status=body.querySelector('[role=status]');
  type.value=s.next_step_type || 'call';
  const drafts={call:s.calendar_link||'',checkout:s.next_step_link||'',form:s.next_step_link||'',human:''};
  let previous=type.value;
  const update=()=>{drafts[previous]=link.value;previous=type.value;link.disabled=type.value==='human';link.required=!link.disabled;link.value=drafts[type.value]||'';};
  link.value=drafts[type.value]||'';update();
  type.addEventListener('change',update);form.addEventListener('input',()=>state.onboardingDirty=true);
  form.addEventListener('submit',async e=>{
    e.preventDefault();if(!form.reportValidity())return;
    if(type.value!=='human' && !/^https?:\/\//i.test(link.value)){status.textContent='Use an http or https link.';return;}
    const values={next_step_type:type.value}; if(type.value!=='human')values[type.value==='call'?'calendar_link':'next_step_link']=link.value.trim();
    const controls=[...form.elements];controls.forEach(el=>el.disabled=true);state.onboardingSaving=true;
    try{await api('/api/settings',{method:'PUT',body:values});state.settings=await api('/api/settings');state.onboardingDirty=false;state.onboarding=await api('/api/onboarding');updateSetupProgress();status.textContent='Next step saved.';}
    catch(err){status.textContent=setupError(err);}finally{state.onboardingSaving=false;controls.forEach(el=>el.disabled=false);link.disabled=type.value==='human';}
  });
}
function normalizeTestDrive(raw) {
  if(!raw || !Array.isArray(raw.runs)) throw new Error('Could not read test-drive results.');
  const status=({done:'complete',error:'failed'})[raw.status] || raw.status;
  if(!['queued','running','complete','failed'].includes(status)) throw new Error('Unrecognized test-drive response.');
  return {...raw,id:raw.job_id || raw.id,status,total:raw.total ?? raw.runs.length,
    completed:raw.completed ?? raw.runs.filter(r=>['done','error','complete','failed'].includes(r.status)).length};
}
function testDrivePassed(job) {
  return !!job && job.status==='complete' && job.passed===true && job.runs.length>=5 &&
    job.runs.every(r=>!['error','failed'].includes(r.status) && r.verdict!=='fail');
}
function canGoLive(me,progress,job) {
  return me?.user?.role==='owner' && me?.account?.access_status==='active' &&
    me?.instagram?.connected===true && !me.instagram.needs_reconnect &&
    SETUP_STEPS.every(([key])=>progress?.steps?.[key]===true) && testDrivePassed(job);
}
function renderTestDrive(body) {
  body.innerHTML='<h2>Test your script</h2><p>Run five simulated conversations before enabling automation.</p><button class="btn btn-primary" id="test-start">Run test drive</button><button class="btn btn-ghost" id="test-resume">Refresh results</button><p role="status" id="test-status"></p><div class="test-runs" id="test-runs"></div><button class="btn btn-primary" id="setup-live" disabled>Go live</button><p class="set-help">Requires owner access, an active account, connected Instagram and a passed test of your current script. This enables autopilot for new conversations.</p>';
  const start=body.querySelector('#test-start'),resume=body.querySelector('#test-resume'),status=body.querySelector('#test-status'),live=body.querySelector('#setup-live');
  const epoch=state.sessionEpoch,accountId=state.me.account.id,key='dmsetter-test:'+accountId;
  let busy=false,latest=null,blockedResult=false;
  const current=()=>body.isConnected && state.route==='onboarding' && state.onboardingStep===4 && epoch===state.sessionEpoch && state.me?.account?.id===accountId;
  const stored=()=>{try{return sessionStorage.getItem(key);}catch{return null;}};
  const remember=id=>{try{if(id)sessionStorage.setItem(key,id);else sessionStorage.removeItem(key);}catch{/* Results can still be recovered from the server. */}};
  const controls=()=>{
    if(!current())return;
    start.disabled=busy || ['queued','running'].includes(latest?.status) || state.me.account.access_status!=='active';resume.disabled=busy;
    live.disabled=busy || blockedResult || !canGoLive(state.me,state.onboarding,latest) || !!state.onboarding?.steps.live;
    live.textContent=state.onboarding?.steps.live?'Automation enabled':'Go live';
  };
  const draw=job=>{
    latest=job;
    status.textContent=job.status+': '+job.completed+' / '+job.total+' conversations'+(job.status==='complete'?' · '+(testDrivePassed(job)?'Passed':'Needs review'):'');
    body.querySelector('#test-runs').innerHTML=job.runs.map(run=>'<article class="card test-run"><h3>'+esc(run.persona?.name||'Simulated customer')+'</h3><p>Assessment: '+esc(run.verdict||'Not reported')+' · Final stage: '+esc(run.final_stage||'Not reported')+'</p>'+(run.transcript||[]).map(m=>'<p class="'+(['assistant','setter'].includes(m.role)?'test-ai':'')+'"><strong>'+esc(m.role)+': </strong>'+esc(m.text)+'</p>').join('')+'<p>'+esc(Array.isArray(run.notes)?run.notes.join(' · '):run.notes||'No assessment reported.')+'</p></article>').join('');
  };
  const poll=async id=>{
    remember(id);
    for(let attempt=0;attempt<100;attempt++){
      if(!current())return;
      const raw=await api('/api/onboarding/test-drive/'+encodeURIComponent(id));if(!current())return;
      const job=normalizeTestDrive(raw);draw(job);
      if(job.status==='failed'){blockedResult=true;throw new Error(job.error||'Test drive failed. Review the results before trying again.');}
      if(job.status==='complete'){
        blockedResult=!testDrivePassed(job);
        const progress=await api('/api/onboarding');if(!current())return;
        state.onboarding=progress;updateSetupProgress();return;
      }
      await new Promise(resolve=>setTimeout(resolve,2000));
    }
    status.textContent='Still running. Refresh results to continue checking this run.';
  };
  const perform=async action=>{
    if(busy || !current())return;busy=true;controls();
    try{await action();}catch(err){if(current())status.textContent=err.status===404?'This test run is no longer available. Start a new test drive.':setupError(err);}
    finally{busy=false;controls();}
  };
  const recover=async()=>{
    status.textContent='Loading your latest test drive…';
    let id=stored();
    try{
      const history=await api('/api/onboarding/test-drive');if(!current())return;
      if(!Array.isArray(history))throw new Error('Could not read test-drive history.');
      const jobs=history.slice().sort((a,b)=>(Date.parse(b.started_at)||0)-(Date.parse(a.started_at)||0));
      id=jobs[0]?.job_id || jobs[0]?.id || null;remember(id);
    }catch(err){if(![404,501].includes(err.status) || !id)throw err;}
    if(id)await poll(id);
    else status.textContent=state.me.account.access_status==='active'?'No test drives yet. Run your script against five simulated customers.':'Your account must be activated before test drives are available.';
  };
  start.addEventListener('click',()=>perform(async()=>{
    blockedResult=true;latest=null;controls();body.querySelector('#test-runs').replaceChildren();status.textContent='Starting a test drive…';
    const result=await api('/api/onboarding/test-drive',{method:'POST',body:{persona_ids:['price_hunter','warm_keyword','think_about_it','skeptic','dream_buyer']}});
    const id=result.job_id || result.id;if(!id)throw new Error('Could not confirm the test started. Refresh results before trying again.');
    if(!current()){if(epoch===state.sessionEpoch)remember(id);return;}
    await poll(id);
  }));
  resume.addEventListener('click',()=>perform(recover));
  live.addEventListener('click',()=>perform(async()=>{
    if(blockedResult || !canGoLive(state.me,state.onboarding,latest))return;
    if(!confirm('Enable live automation for this account? New conversations will use autopilot.'))return;
    await loadIdentity();if(!current())return;
    const progress=await api('/api/onboarding');if(!current())return;state.onboarding=progress;
    if(!canGoLive(state.me,progress,latest))throw new Error('Your account or setup has changed. Review it before going live.');
    await api('/api/onboarding/go-live',{method:'POST'});if(!current())return;
    await loadIdentity();await loadSettings();if(current())await renderOnboarding();
  }));
  controls();perform(recover);
}
async function renderTeam() {
  const host=$('#team-page');host.innerHTML='<h1>Team</h1><p>Members can access this business’s conversations.</p><div id="team-content">Loading…</div>';
  const content=host.querySelector('#team-content');
  try{
    const members=await api('/api/team');if(!Array.isArray(members))throw new Error('Could not read team members.');if(!content.isConnected)return;
    const owner=state.me.user.role==='owner';
    content.innerHTML=members.map(m=>'<div class="card team-row"><div><strong>'+esc(m.email)+'</strong><p>'+esc(m.role)+' · '+(m.accepted?'Joined':'Invited')+'</p></div>'+(owner && m.id!==state.me.user.id?'<button class="btn btn-ghost" data-remove="'+esc(m.id)+'">Remove</button>':'')+'</div>').join('')+(owner?'<form id="invite-form"><label for="invite-email">Invite a setter</label><input id="invite-email" type="email" required placeholder="colleague@business.com"><button class="btn btn-primary">Invite</button><p role="status" id="invite-status"></p></form>':'');
    content.querySelectorAll('[data-remove]').forEach(button=>button.addEventListener('click',async()=>{
      const m=members.find(m=>m.id===button.dataset.remove);if(!confirm('Remove '+m.email+' from this account? Their sessions will end.'))return;button.disabled=true;
      try{await api('/api/team/'+encodeURIComponent(m.id),{method:'DELETE'});if(content.isConnected && state.route==='team')await renderTeam();}catch(err){toast(err.message,'err');button.disabled=false;}
    }));
    content.querySelector('form')?.addEventListener('submit',async e=>{
      e.preventDefault();const button=e.target.querySelector('button');button.disabled=true;
      try{await api('/api/team/invite',{method:'POST',body:{email:content.querySelector('input').value.trim(),role:'setter'}});if(content.isConnected && state.route==='team')await renderTeam();}
      catch(err){content.querySelector('#invite-status').textContent=err.message;button.disabled=false;}
    });
  }catch(err){if(content.isConnected)retryPanel(content,setupError(err),renderTeam);}
}
async function renderOperator() {
  const host=$('#operator-page');host.innerHTML='<h1>Account access</h1>';
  if(!state.me?.user?.is_platform_admin){host.textContent='This page is available only to the platform operator.';return;}
  const content=document.createElement('div');host.append(content);content.textContent='Loading accounts…';
  try{
    const accounts=await api('/api/admin/accounts');if(!Array.isArray(accounts))throw new Error('Could not read accounts.');if(!content.isConnected)return;
    content.innerHTML=accounts.map(a=>'<article class="card operator-account"><h2>'+esc(a.name)+'</h2><p>'+esc(a.owner_email||a.id)+' · '+esc(a.access_status)+'</p><button class="btn btn-ghost" data-access="active" data-account="'+esc(a.id)+'">Activate</button><button class="btn btn-ghost" data-access="paused" data-account="'+esc(a.id)+'">Pause</button><button class="btn btn-ghost" data-usage="'+esc(a.id)+'">View AI usage</button><p role="status" class="operator-status"></p><div class="usage-result"></div></article>').join('');
    content.querySelectorAll('[data-access]').forEach(button=>button.addEventListener('click',async()=>{
      const a=accounts.find(a=>a.id===button.dataset.account);if(!confirm((button.dataset.access==='active'?'Activate ':'Pause ')+a.name+'? Activation does not turn on automation.'))return;
      button.disabled=true;try{await api('/api/admin/accounts/'+encodeURIComponent(a.id)+'/access',{method:'PATCH',body:{status:button.dataset.access}});await loadIdentity();if(content.isConnected && state.route==='operator')await renderOperator();}catch(err){button.closest('article').querySelector('.operator-status').textContent=err.message;button.disabled=false;}
    }));
    content.querySelectorAll('[data-usage]').forEach(button=>button.addEventListener('click',async()=>{
      button.disabled=true;const result=button.closest('article').querySelector('.usage-result');
      try{const data=await api('/api/admin/accounts/'+encodeURIComponent(button.dataset.usage)+'/usage');result.textContent='This month: '+Number(data.month.calls||0)+' AI calls · estimated USD '+Number(data.month.cost_usd||0).toFixed(2)+'. '+(data.note||'');}
      catch(err){result.textContent=err.message;}finally{button.disabled=false;}
    }));
  }catch(err){if(content.isConnected)retryPanel(content,setupError(err),renderOperator);}
}

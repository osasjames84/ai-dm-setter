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
  host.querySelector('#ig-test')?.addEventListener('click',refresh);
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
  const update=()=>{link.disabled=type.value==='human';link.required=!link.disabled;link.value=type.value==='call'?(s.calendar_link||''):(s.next_step_link||'');};update();
  type.addEventListener('change',update);form.addEventListener('input',()=>state.onboardingDirty=true);
  form.addEventListener('submit',async e=>{
    e.preventDefault();if(!form.reportValidity())return;
    if(type.value!=='human' && !/^https?:\/\//i.test(link.value)){status.textContent='Use an http or https link.';return;}
    const values={next_step_type:type.value}; if(type.value!=='human')values[type.value==='call'?'calendar_link':'next_step_link']=link.value.trim();
    const controls=[...form.elements];controls.forEach(el=>el.disabled=true);
    try{await api('/api/settings',{method:'PUT',body:values});state.settings=await api('/api/settings');state.onboardingDirty=false;state.onboarding=await api('/api/onboarding');updateSetupProgress();status.textContent='Next step saved.';}
    catch(err){status.textContent=setupError(err);}finally{controls.forEach(el=>el.disabled=false);link.disabled=type.value==='human';}
  });
}
function renderTestDrive(body) {
  body.innerHTML='<h2>Test your script</h2><p>Run five simulated conversations before enabling automation.</p><button class="btn btn-primary" id="test-start">Run test drive</button><button class="btn btn-ghost" id="test-resume">Check existing run</button><p role="status" id="test-status"></p><div class="test-runs" id="test-runs"></div><button class="btn btn-primary" id="setup-live" disabled>Go live</button><p class="set-help">Requires active access, connected Instagram and every setup step complete. This enables autopilot for new conversations.</p>';
  const start=body.querySelector('#test-start'),resume=body.querySelector('#test-resume'),status=body.querySelector('#test-status'),live=body.querySelector('#setup-live');
  const key='dmsetter-test:'+state.me.account.id;let busy=false;
  const allowed=()=>state.me?.account?.access_status==='active' && !state.me?.instagram?.needs_reconnect && SETUP_STEPS.every(([k])=>state.onboarding?.steps[k]);
  live.disabled=!allowed() || !!state.onboarding?.steps.live;
  if(state.onboarding?.steps.live)live.textContent='Live';
  start.disabled=state.me.account.access_status==='paused';
  resume.hidden=!sessionStorage.getItem(key);
  const poll=async()=>{
    if(busy)return;busy=true;start.disabled=true;resume.disabled=true;
    const epoch=state.sessionEpoch;const id=sessionStorage.getItem(key);
    try{
      for(let attempt=0;attempt<100;attempt++){
        if(!body.isConnected || state.route!=='onboarding' || state.onboardingStep!==4 || epoch!==state.sessionEpoch)return;
        const raw=await api('/api/onboarding/test-drive/'+encodeURIComponent(id));
        const job={...raw,status:({done:'complete',error:'failed'})[raw.status]||raw.status};
        job.total=raw.total ?? raw.runs?.length ?? 5;
        job.completed=raw.completed ?? (raw.runs||[]).filter(r=>['done','error'].includes(r.status)).length;
        if(!['queued','running','complete','failed'].includes(job.status))throw new Error('Unrecognized test-drive response.');
        status.textContent=job.status+': '+(job.completed||0)+' / '+(job.total||5)+' conversations';
        body.querySelector('#test-runs').innerHTML=(job.runs||[]).map(run=>'<article class="card test-run"><h3>'+esc(run.persona?.name||'Simulated customer')+'</h3><p>Assessment: '+esc(run.verdict||'Not reported')+' · Final stage: '+esc(run.final_stage||'Not reported')+'</p>'+ (run.transcript||[]).map(m=>'<p class="'+(['assistant','setter'].includes(m.role)?'test-ai':'')+'"><strong>'+esc(m.role)+': </strong>'+esc(m.text)+'</p>').join('')+'<p>'+esc(Array.isArray(run.notes)?run.notes.join(' · '):run.notes||'No assessment reported.')+'</p></article>').join('');
        if(job.status==='failed')throw new Error(job.error||'Test drive failed. You can try again.');
        if(job.status==='complete'){status.textContent+=' · '+(job.passed===true?'Passed':job.passed===false?'Needs review':'See conversation assessments');state.onboarding=await api('/api/onboarding');updateSetupProgress();live.disabled=!allowed();sessionStorage.removeItem(key);resume.hidden=true;return;}
        await new Promise(resolve=>setTimeout(resolve,2000));
      }
      status.textContent='Still running. Use Check existing run to continue.';
    }catch(err){status.textContent=setupError(err);}finally{busy=false;start.disabled=state.me?.account?.access_status==='paused';resume.disabled=false;}
  };
  start.addEventListener('click',async()=>{
    start.disabled=true;
    try{const result=await api('/api/onboarding/test-drive',{method:'POST',body:{persona_ids:['price_hunter','warm_keyword','think_about_it','skeptic','dream_buyer']}});const jobId=result.job_id || result.id;if(!jobId)throw new Error('No test run was returned.');sessionStorage.setItem(key,jobId);resume.hidden=false;await poll();}
    catch(err){status.textContent=setupError(err);}finally{start.disabled=state.me?.account?.access_status==='paused';}
  });
  resume.addEventListener('click',poll);
  live.addEventListener('click',async()=>{
    if(!confirm('Enable live automation for this account? New conversations will use autopilot.'))return;
    live.disabled=true;
    try{await loadIdentity();state.onboarding=await api('/api/onboarding');if(!allowed())throw new Error('Complete setup and obtain active access before going live.');await api('/api/onboarding/go-live',{method:'POST'});await loadIdentity();await loadSettings();await renderOnboarding();}
    catch(err){status.textContent=setupError(err);live.disabled=!allowed();}
  });
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
      try{await api('/api/team/'+encodeURIComponent(m.id),{method:'DELETE'});await renderTeam();}catch(err){toast(err.message,'err');button.disabled=false;}
    }));
    content.querySelector('form')?.addEventListener('submit',async e=>{
      e.preventDefault();const button=e.target.querySelector('button');button.disabled=true;
      try{await api('/api/team/invite',{method:'POST',body:{email:content.querySelector('input').value.trim(),role:'setter'}});await renderTeam();}
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
      button.disabled=true;try{await api('/api/admin/accounts/'+encodeURIComponent(a.id)+'/access',{method:'PATCH',body:{status:button.dataset.access}});await loadIdentity();await renderOperator();}catch(err){button.closest('article').querySelector('.operator-status').textContent=err.message;button.disabled=false;}
    }));
    content.querySelectorAll('[data-usage]').forEach(button=>button.addEventListener('click',async()=>{
      button.disabled=true;const result=button.closest('article').querySelector('.usage-result');
      try{const data=await api('/api/admin/accounts/'+encodeURIComponent(button.dataset.usage)+'/usage');result.textContent='This month: '+Number(data.month.calls||0)+' AI calls · estimated USD '+Number(data.month.cost_usd||0).toFixed(2)+'. '+(data.note||'');}
      catch(err){result.textContent=err.message;}finally{button.disabled=false;}
    }));
  }catch(err){if(content.isConnected)retryPanel(content,setupError(err),renderOperator);}
}

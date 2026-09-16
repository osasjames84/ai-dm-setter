'use strict';
const SETUP_STEPS = [
  ['instagram','Connect Instagram'], ['template','Choose a template'],
  ['sections','Write your script'], ['next_step','Choose the next step'], ['test_drive','Test your script'],
];
const SETUP_FIELDS = [
  ['prompt_offer','Your offer','What do you sell, who is it for, and what can customers expect?'],
  ['prompt_voice','Your voice','How should messages sound? Include a few examples.'],
  ['prompt_qualification','Qualification','What do you need to know before recommending the next step?'],
  ['prompt_booking','Next-step sequence','When and how should the next step be offered and confirmed?'],
  ['prompt_hard_rules','Hard rules','What must the AI never say or do?'],
];
function setupError(err) {
  return [404,501].includes(err.status) ? 'This feature is not available on this server yet. Your existing settings are unchanged.' : err.message;
}
function retryPanel(host, message, retry) {
  host.replaceChildren();
  const p=document.createElement('p'); p.className='set-help'; p.setAttribute('role','status'); p.textContent=message;
  const b=document.createElement('button'); b.className='btn btn-ghost btn-sm'; b.textContent='Retry'; b.addEventListener('click',retry);
  host.append(p,b);
}
async function renderTemplatePicker(host, afterApply) {
  host.textContent='Loading templates…';
  try {
    const templates=await api('/api/templates');
    if (!host.isConnected) return;
    if (!Array.isArray(templates)) throw new Error('Could not read the template list. Please retry.');
    if (!templates.length) { host.textContent='No templates are available yet.'; return; }
    const label=document.createElement('label'); label.textContent='Script template';
    const select=document.createElement('select'); select.setAttribute('aria-label','Script template');
    for (const t of templates) { const option=document.createElement('option'); option.value=t.id; option.textContent=t.name; select.append(option); }
    const description=document.createElement('p'); description.className='set-help';
    const update=()=> { description.textContent=templates.find(t=>t.id===select.value)?.description || ''; };
    select.addEventListener('change',update); update();
    const button=document.createElement('button'); button.className='btn btn-primary'; button.textContent='Fill empty sections';
    const result=document.createElement('p'); result.className='set-help'; result.setAttribute('role','status');
    button.addEventListener('click',async()=> {
      if (state.scriptDirty || state.onboardingDirty) { result.textContent='Save your edits before applying a template. Your text will be kept.'; return; }
      button.disabled=true; select.disabled=true; result.textContent='Applying template…';
      try {
        const response=await api('/api/settings/apply-template',{method:'POST',body:{id:select.value,only_empty:true}});
        if (!response.ok || !Array.isArray(response.filled)) throw new Error('Could not confirm the template was applied. Reload before trying again.');
        state.settings=await api('/api/settings');
        result.textContent=response.filled.length ? 'Filled '+response.filled.length+' empty sections. Existing writing was kept.' : 'Your sections already contain text. Nothing was overwritten.';
        await afterApply?.();
      } catch(err) { result.textContent=setupError(err); }
      finally { button.disabled=false; select.disabled=false; }
    });
    host.replaceChildren(label,select,description,button,result);
  } catch(err) { if(host.isConnected) retryPanel(host,setupError(err),()=>renderTemplatePicker(host,afterApply)); }
}
function drawChecks(host, checks) {
  host.replaceChildren();
  for (const check of checks) {
    const p=document.createElement('p'); p.className='script-check '+(check.level==='error'?'check-error':'check-warn');
    p.textContent=(check.level==='error'?'Needs attention: ':'Suggestion: ')+String(check.message || ''); host.append(p);
  }
}
async function loadScriptChecks(root, summary) {
  if(summary) summary.textContent='Checking saved script…';
  try {
    const checks=await api('/api/script/checks');
    if(!root.isConnected) return;
    if(!Array.isArray(checks)) throw new Error('Could not read script checks.');
    root.querySelectorAll('[data-check-for]').forEach(el=>drawChecks(el,checks.filter(c=>c.section===el.dataset.checkFor)));
    if(summary) summary.textContent=checks.length ? checks.length+' checks to review. These checks apply to saved text.' : 'No issues reported for the saved script.';
    return checks;
  } catch(err) { if(summary?.isConnected) summary.textContent=setupError(err); }
}
function mountScriptTools() {
  const host=$('#script-tools'); if(!host) return;
  host.innerHTML='<details class="script-tools-box"><summary>Templates and script checks</summary><div class="template-picker" id="prompt-template-picker"></div><p class="set-help" id="prompt-check-status" role="status"></p><button class="btn btn-ghost btn-sm" id="refresh-script-checks">Check saved script</button></details><details class="script-tools-box" id="assembled-details"><summary>What the AI sees</summary><p class="set-help">The assembled prompt from your saved settings. Save edits before refreshing.</p><button class="btn btn-ghost btn-sm" id="refresh-assembled">Refresh saved prompt</button><pre id="assembled-prompt" class="assembled-prompt" tabindex="0">Open this panel to load the saved prompt.</pre></details>';
  renderTemplatePicker($('#prompt-template-picker'),()=> { if(state.scriptDirty || state.route!=='prompt') return; initScriptState(state.settings.settings); renderScriptWorkspace(); loadScriptChecks($('#script-col'),$('#prompt-check-status')); });
  $('#refresh-script-checks').addEventListener('click',()=>loadScriptChecks($('#script-col'),$('#prompt-check-status')));
  loadScriptChecks($('#script-col'),$('#prompt-check-status'));
  let busy=false;
  const load=async()=> {
    if(busy) return; busy=true; const target=$('#assembled-prompt'); const button=$('#refresh-assembled'); button.disabled=true; target.textContent='Loading…';
    try { const data=await api('/api/script/assembled'); if(typeof data.text!=='string') throw new Error('Could not read the assembled prompt.'); target.textContent=data.text; }
    catch(err) { target.textContent=setupError(err); }
    finally { busy=false; button.disabled=false; }
  };
  $('#refresh-assembled').addEventListener('click',load);
  $('#assembled-details').addEventListener('toggle',e=>{if(e.target.open)load();});
}
async function renderOnboarding() {
  const host=$('#onboarding-page');
  host.innerHTML='<h1>Set up your account</h1><p class="sub">Make the script yours before going live.</p><div id="setup-status" role="status">Loading your progress…</div><div id="setup-content"></div>';
  const status=$('#setup-status');
  try {
    const progress=await api('/api/onboarding');
    if(state.route!=='onboarding' || !host.contains(status)) return;
    if(!progress.steps || typeof progress.steps!=='object') throw new Error('Could not read setup progress.');
    state.onboarding=progress;
    if(state.onboardingStep==null) { const first=SETUP_STEPS.findIndex(([key])=>!progress.steps[key]); state.onboardingStep=first<0?4:first; }
    status.textContent=SETUP_STEPS.filter(([key])=>progress.steps[key]).length+' of 5 steps complete'+(progress.steps.live ? '. Your account is live.' : '.');
    drawSetup();
  } catch(err) { if(host.contains(status)) retryPanel(status,setupError(err),renderOnboarding); }
}
function updateSetupProgress() {
  const status=$('#setup-status');
  if(status) status.textContent=SETUP_STEPS.filter(([key])=>state.onboarding.steps[key]).length+' of 5 steps complete'+(state.onboarding.steps.live ? '. Your account is live.' : '.');
  document.querySelectorAll('[data-setup-step]').forEach(button=>{const i=Number(button.dataset.setupStep);const [key,label]=SETUP_STEPS[i];button.textContent=(state.onboarding.steps[key]?'✓ ':String(i+1)+'. ')+label;});
}
function drawSetup() {
  const host=$('#setup-content'); if(!host) return;
  const step=state.onboardingStep;
  host.innerHTML='<nav class="setup-steps" aria-label="Setup steps">'+SETUP_STEPS.map(([key,label],i)=>'<button class="btn '+(i===step?'btn-primary':'btn-ghost')+'" data-setup-step="'+i+'" '+(i===step?'aria-current="step"':'')+'>'+ (state.onboarding.steps[key]?'✓ ':String(i+1)+'. ')+esc(label)+'</button>').join('')+'</nav><div class="card setup-card" id="setup-step-body"></div>';
  host.querySelectorAll('[data-setup-step]').forEach(b=>b.addEventListener('click',()=> {
    if(state.onboardingDirty && !confirm('Leave without saving these script edits?')) return;
    state.onboardingDirty=false; state.onboardingStep=Number(b.dataset.setupStep); drawSetup();
  }));
  const body=$('#setup-step-body');
  if(step===0) {
    const connected=state.me?.instagram?.connected;
    body.innerHTML='<h2>Connect Instagram</h2><p>'+ (connected?'Instagram is connected. Continue to choose a template.':'Your Instagram connection is managed in Settings. Connect your account before going live.')+'</p><button class="btn btn-ghost" id="setup-settings">Open Settings</button><button class="btn btn-primary" id="setup-next">Choose a template</button>';
    $('#setup-settings').addEventListener('click',()=>go('settings')); $('#setup-next').addEventListener('click',()=>{state.onboardingStep=1;drawSetup();});
  } else if(step===1) {
    body.innerHTML='<h2>Choose a starting point</h2><p>Templates only fill empty sections. Anything you have written stays in place.</p><div id="setup-templates" class="template-picker"></div><button class="btn btn-ghost" id="setup-write">Write your script</button>';
    renderTemplatePicker($('#setup-templates'),async()=> { const p=await api('/api/onboarding'); state.onboarding=p; updateSetupProgress(); });
    $('#setup-write').addEventListener('click',()=>{state.onboardingStep=2;drawSetup();});
  } else if(step===2) {
    body.innerHTML='<h2>Five sections that matter</h2><p>Explain your offer, your voice and what a good next step looks like.</p><form id="setup-script">'+SETUP_FIELDS.map(([key,label,hint])=>'<label class="setup-field" for="setup-'+key+'">'+esc(label)+'<span class="set-help">'+esc(hint)+'</span></label><textarea id="setup-'+key+'" data-setup-field="'+key+'" rows="4">'+esc(state.settings?.settings?.[key]||'')+'</textarea><div data-check-for="'+key+'"></div>').join('')+'<p id="setup-check-status" class="set-help" role="status"></p><button class="btn btn-primary" id="setup-save">Save script</button><p id="setup-save-status" class="set-help" role="status"></p></form>';
    $('#setup-script').addEventListener('input',()=>{state.onboardingDirty=true;$('#setup-save-status').textContent='Unsaved changes';});
    $('#setup-script').addEventListener('submit',async e=>{
      e.preventDefault(); const button=$('#setup-save'); const message=$('#setup-save-status'); if(button.disabled)return; button.disabled=true;
      const fields=Array.from(body.querySelectorAll('[data-setup-field]')); const values=Object.fromEntries(fields.map(el=>[el.dataset.setupField,el.value]));
      fields.forEach(el=>el.disabled=true);
      try {
        const response=await api('/api/settings',{method:'PUT',body:values});
        if(!response.ok)throw new Error('Could not confirm the script was saved.');
        state.settings=await api('/api/settings'); state.onboardingDirty=false; message.textContent='Script saved.';
        await loadScriptChecks(body,$('#setup-check-status')); state.onboarding=await api('/api/onboarding'); updateSetupProgress();
      } catch(err) { message.textContent=setupError(err); }
      finally { button.disabled=false;fields.forEach(el=>el.disabled=false); }
    });
    loadScriptChecks(body,$('#setup-check-status'));
  } else if(step===3) {
    body.innerHTML='<h2>Choose the next step</h2><p>Your next step can be a call, purchase, form or handoff to a person. Describe it in your next-step sequence.</p><p class="set-help">Dedicated goal and link settings will be available when the server supports them. Setup is not marked complete here.</p><button class="btn btn-ghost" id="setup-open-script">Open full script</button>';
    $('#setup-open-script').addEventListener('click',()=>go('prompt'));
  } else {
    body.innerHTML='<h2>Test before going live</h2><p>Try individual messages in AI Preview now. The five-lead test drive and go-live controls arrive with the next integration.</p><p class="set-help">A preview does not complete this setup step or turn on automation.</p><button class="btn btn-ghost" id="setup-preview">Open AI Preview</button>';
    $('#setup-preview').addEventListener('click',()=>go('prompt'));
  }
}

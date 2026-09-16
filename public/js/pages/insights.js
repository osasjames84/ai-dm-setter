'use strict';
const metric=(value,suffix='')=>value==null?'—':esc(value)+suffix;
function dataTable(headers,rows) {
  return '<div class="data-scroll"><table class="data-table"><thead><tr>'+headers.map(h=>'<th scope="col">'+esc(h)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(row=>'<tr>'+row.map(v=>'<td>'+esc(v??'—')+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';
}
function versionTable(rows) {
  return dataTable(['Version','Note','Conversations','AI messages','Booked','Booked rate'],rows.map(v=>['v'+v.version,v.note,v.conversations,v.ai_messages,v.booked,v.booked_rate==null?'—':v.booked_rate+'%']));
}
async function renderAnalytics(days=state.analyticsDays||30) {
  state.analyticsDays=days;const host=$('#analytics-page');
  host.innerHTML='<h1>Analytics</h1><label for="analytics-days">Time window</label><select id="analytics-days"><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="365">Last year</option></select><div id="analytics-results" role="status">Loading analytics…</div>';
  host.querySelector('select').value=String(days);host.querySelector('select').onchange=e=>renderAnalytics(Number(e.target.value));
  const result=host.querySelector('#analytics-results');
  try {
    const d=await api('/api/analytics?days='+days);if(!result.isConnected)return;
    result.removeAttribute('role');
    result.innerHTML='<div class="metric-grid">'+[['New leads',d.leads.total],['Booked outcomes',d.outcomes.call_booked],['Sales outcomes',d.outcomes.sale],['Median hours to booking',d.median_hours_to_booking]].map(([name,value])=>'<div class="card metric"><span>'+esc(name)+'</span><strong>'+metric(value)+'</strong></div>').join('')+
      '<h2>Lead sources</h2>'+dataTable(['Total','Instagram','Simulator','Keyword triggered'],[[d.leads.total,d.leads.instagram,d.leads.simulator,d.leads.keyword]])+'<p class="set-help">Keyword-triggered leads overlap channel totals. Outcomes count events in this window and may include older leads.</p><h2>Conversion</h2>'+dataTable(['Conversation group','Conversations','Booked','Rate'],Object.entries(d.conversion).map(([key,v])=>[key==='ai_only'?'No human reply recorded':'Human assisted',v.conversations,v.booked,v.rate==null?'—':v.rate+'%']))+
      '<p class="set-help">Groups reflect recorded replies, not proof that AI caused a booking.</p><h2>Outcomes</h2>'+dataTable(['Booked','Sale','Routed','Dead'],[[d.outcomes.call_booked,d.outcomes.sale,d.outcomes.routed,d.outcomes.dead]])+
      '<h2>Estimated revenue</h2><p>'+metric(d.revenue.estimated)+' '+esc(d.revenue.currency)+' · '+metric(d.revenue.sales)+' sales × '+metric(d.revenue.client_value)+' average client value.</p><p class="set-help">An estimate from your settings, not collected payments.</p><h2>Prompt version performance</h2>'+versionTable(d.by_version||[])+'<p class="set-help">Version statistics are lifetime figures from the server, independent of this date filter.</p><h2>Incoming messages by hour</h2><p class="set-help">Hours use the server timezone.</p>'+dataTable(['Hour','Messages'],(d.lead_messages_by_hour||[]).map((n,h)=>[String(h).padStart(2,'0')+':00',n]));
  }catch(err){if(result.isConnected)retryPanel(result,setupError(err),()=>renderAnalytics(days));}
}
async function renderVersions(selected=null) {
  const host=$('#versions-page');host.innerHTML='<h1>Prompt versions</h1><p>Review previous scripts, add notes, or restore a version as a new save.</p><div id="version-list">Loading versions…</div><div id="version-detail"></div>';
  const list=host.querySelector('#version-list'),detail=host.querySelector('#version-detail');
  try{
    const rows=await api('/api/prompt/versions');if(!list.isConnected)return;if(!Array.isArray(rows))throw new Error('Could not read versions.');
    list.innerHTML=rows.length?'<label for="version-select">Saved version</label><select id="version-select">'+rows.map(v=>'<option value="'+Number(v.version)+'">v'+Number(v.version)+(v.current?' · Current':'')+' · '+esc(v.created_at)+'</option>').join('')+'</select>'+versionTable(rows):'<p>No versions recorded yet. Save your script to create one.</p>';
    const select=list.querySelector('select');if(!select)return;if(selected && rows.some(v=>v.version===selected))select.value=String(selected);
    const load=async()=>{
      if(state.versionNoteDirty && !confirm('Discard your unsaved version note?')){select.value=detail.dataset.version;return;}
      state.versionNoteDirty=false;const version=Number(select.value);detail.dataset.version=String(version);detail.textContent='Loading version…';
      try{
        const v=await api('/api/prompt/versions/'+version);if(!detail.isConnected || detail.dataset.version!==String(version))return;
        detail.innerHTML='<article class="card version-card"><h2>Version '+version+'</h2><label for="version-note">Version note</label><textarea id="version-note" maxlength="200" rows="2">'+esc(v.note||'')+'</textarea><button class="btn btn-ghost" id="note-save">Save note</button><button class="btn btn-primary" id="version-restore">Restore as a new version</button><p role="status" id="version-status"></p>'+Object.entries(v.sections||{}).map(([key,text])=>'<details><summary>'+esc(key.replace(/^prompt_/,'').replaceAll('_',' '))+'</summary><pre class="assembled-prompt">'+esc(text)+'</pre></details>').join('')+'</article>';
        const note=detail.querySelector('textarea'),status=detail.querySelector('[role=status]');note.oninput=()=>state.versionNoteDirty=true;
        const write=async(action)=>{if(state.versionSaving)return;state.versionSaving=true;const controls=[note,...detail.querySelectorAll('button'),select];controls.forEach(el=>el.disabled=true);try{await action();}catch(err){status.textContent=err.message;}finally{state.versionSaving=false;controls.forEach(el=>el.disabled=false);}};
        detail.querySelector('#note-save').onclick=()=>write(async()=>{await api('/api/prompt/versions/'+version,{method:'PUT',body:{note:note.value}});state.versionNoteDirty=false;status.textContent='Note saved.';await renderVersions(version);});
        detail.querySelector('#version-restore').onclick=()=>{
          if(state.versionNoteDirty){status.textContent='Save your note before restoring a version.';return;}
          if(!confirm('Restore version '+version+'? This replaces the saved script and records a new version. Test it again before enabling automation.'))return;
          write(async()=>{const out=await api('/api/prompt/versions/'+version+'/restore',{method:'POST'});state.settings=await api('/api/settings');state.script=null;state.scriptDirty=false;await renderVersions(out.version);toast('Restored as version '+out.version);});
        };
      }catch(err){if(detail.isConnected)retryPanel(detail,setupError(err),load);}
    };
    select.onchange=load;await load();
  }catch(err){if(list.isConnected)retryPanel(list,setupError(err),renderVersions);}
}
function profileHtml(profile) {
  if(!profile)return '<div class="info-card"><div class="ic-title">Lead profile</div><p class="info-hint">No profile has been extracted yet.</p></div>';
  return '<div class="info-card"><div class="ic-title">Lead profile</div><p class="info-hint">AI-extracted notes. Verify against the conversation.</p>'+[['Goal',profile.goal],['Blocker',profile.blocker],['Budget signal',profile.budget_signal],['Next step',profile.next_step_status]].map(([label,value])=>'<p><strong>'+label+'</strong><br>'+esc(value||'Not recorded')+'</p>').join('')+[['Objections',profile.objections],['Facts',profile.facts]].map(([label,items])=>'<p><strong>'+label+'</strong></p><ul>'+(Array.isArray(items)?items:[]).map(v=>'<li>'+esc(v)+'</li>').join('')+'</ul>').join('')+'<p class="info-hint">Updated: '+esc(profile.updated_at||'Not recorded')+'</p></div>';
}
async function showAccountOverview(id,host) {
  host.textContent='Loading account overview…';
  try{
    const d=await api('/api/admin/accounts/'+encodeURIComponent(id)+'/overview');if(!host.isConnected)return;
    host.innerHTML='<h3>Account overview</h3><p>'+esc(d.account.name)+' · '+esc(d.account.access_status)+'</p><h4>Instagram</h4><p>'+esc(d.instagram?[(d.instagram.username||'No username'),d.instagram.status,d.instagram.last_error||''].filter(Boolean).join(' · '):'Not connected')+'</p><h4>Script readiness</h4><p>Version '+metric(d.script.version)+' · '+metric(d.script.sections_filled)+' / '+metric(d.script.sections_total)+' sections</p><ul>'+d.script.checks.map(c=>'<li>'+esc(c.level+': '+c.message)+'</li>').join('')+'</ul>'+dataTable(['Conversations','Needs human','Pending drafts','Booked (30 days)'],[[d.counts.conversations,d.counts.needs_human,d.counts.pending_drafts,d.counts.booked_30d]])+'<h4>Account settings</h4>'+dataTable(['Setting','Value'],Object.entries(d.settings))+'<h4>Team</h4>'+dataTable(['Email','Role','Last login'],d.users.map(u=>[u.email,u.role,u.last_login_at]))+'<h4>Recent conversations</h4>'+dataTable(['Handle','Stage','Mode','Needs review','Messages'],d.recent_conversations.map(c=>[c.handle,c.stage,c.mode,c.needs_human?'Yes':'No',c.message_count]))+'<h4>Recent audit</h4>'+dataTable(['When','Action','Detail'],d.audit.map(a=>[a.at,a.action,a.detail]));mountAdminActions(id,host);
  }catch(err){if(host.isConnected)retryPanel(host,setupError(err),()=>showAccountOverview(id,host));}
}
async function showOperations(host) {
  try{const [d,health]=await Promise.all([api('/api/admin/ops'),api('/health')]);if(!host.isConnected)return;host.innerHTML='<h2>Platform status</h2><p>Server: '+(health.ok?'Healthy':'Needs attention')+' · uptime '+metric(health.uptime_s)+' seconds</p>'+dataTable(['Service','Status'],['sentry','offsite_backups','instagram_oauth','signature_verified','email'].map(k=>[k.replaceAll('_',' '),d[k]?'Configured':'Not configured']))+'<p>Latest backup: '+esc(typeof d.last_backup==='object'?JSON.stringify(d.last_backup):d.last_backup||'Not reported')+'</p>';}
  catch(err){if(host.isConnected)retryPanel(host,setupError(err),()=>showOperations(host));}
}
function insightSettingsHtml(s) {
  return '<div class="card settings-card"><h2>Profiles, images and analytics</h2><label><input id="set-profiles" type="checkbox" '+(s.lead_profiles==='1'?'checked':'')+'> Extract lead profiles</label><p class="set-help">Summarise goals, blockers and facts from conversations.</p><label><input id="set-vision" type="checkbox" '+(s.image_vision==='1'?'checked':'')+'> Describe incoming photos for the AI</label><label for="set-client-value">Average client value ('+esc(s.currency||'GBP')+')</label><input id="set-client-value" type="number" min="0" step="0.01" value="'+esc(s.client_value||'')+'"><p class="set-help">Used only for revenue estimates. Payments stay outside dmSetter.</p><label for="set-groq">Transcription API key</label><input id="set-groq" value="'+esc(state.groqDraft||'')+'" type="password" autocomplete="new-password" placeholder="'+(s.groq_key_set?'Key configured; leave blank to keep it':'No key configured')+'"><label><input id="set-groq-clear" type="checkbox" '+(state.groqClearDraft?'checked':'')+'> Remove the saved transcription key</label></div>';
}
function insightSettingsValues() {
  const values={lead_profiles:$('#set-profiles').checked?'1':'0',image_vision:$('#set-vision').checked?'1':'0',client_value:$('#set-client-value').value};
  if($('#set-groq-clear').checked)values.groq_api_key='';else if($('#set-groq').value.trim())values.groq_api_key=$('#set-groq').value.trim();
  return values;
}
function mountAccountDeletion() {
  const host=$('#settings-page');if(state.me.user.role!=='owner' || state.me.account.id==='acc_1')return;
  const box=document.createElement('details');box.className='card settings-card danger';box.innerHTML='<summary>Delete this account</summary><p>This permanently deletes the account, conversations, settings and team access. Download your export first.</p><form><label for="delete-email">Type your account email to confirm</label><input id="delete-email" type="email" autocomplete="off" required><button class="btn btn-red-solid">Permanently delete account</button><p role="status"></p></form>';host.append(box);
  box.addEventListener('input',e=>e.stopPropagation());
  box.querySelector('form').onsubmit=async e=>{e.preventDefault();const email=box.querySelector('input').value.trim();const status=box.querySelector('[role=status]');if(email.toLowerCase()!==state.me.user.email.toLowerCase()){status.textContent='Enter the email you are signed in with.';return;}if(!confirm('Permanently delete this account and its data? This cannot be undone.'))return;const button=box.querySelector('button');button.disabled=true;try{await api('/api/account',{method:'DELETE',body:{confirm:email}});showLogin('Account deleted.');}catch(err){status.textContent=err.message;button.disabled=false;}};
}
function mountAdminActions(id,host) {
  const audit=document.createElement('button');audit.className='btn btn-ghost';audit.textContent='Full audit history';host.append(audit);
  const log=document.createElement('div');host.append(log);
  audit.onclick=async()=>{audit.disabled=true;try{const rows=await api('/api/admin/accounts/'+encodeURIComponent(id)+'/audit');if(log.isConnected)log.innerHTML=dataTable(['When','Action','Actor','Detail'],rows.map(a=>[a.at,a.action,a.actor_user_id,a.detail]));}catch(err){log.textContent=err.message;}finally{audit.disabled=false;}};
  if(id==='acc_1' || id===state.me.account.id)return;
  const box=document.createElement('details');box.innerHTML='<summary>Delete this account permanently</summary><p>This removes the account and all its data. Type the account ID to confirm: <strong>'+esc(id)+'</strong></p><input aria-label="Account ID to delete" autocomplete="off"><button class="btn btn-red-solid">Delete account</button><p role="status"></p>';host.append(box);
  box.querySelector('button').onclick=async e=>{const status=box.querySelector('[role=status]');if(box.querySelector('input').value.trim()!==id){status.textContent='The account ID does not match.';return;}if(!confirm('Permanently delete account '+id+' and all of its data? This cannot be undone.'))return;e.target.disabled=true;try{await api('/api/admin/accounts/'+encodeURIComponent(id),{method:'DELETE'});await renderOperator();}catch(err){status.textContent=err.message;e.target.disabled=false;}};
}

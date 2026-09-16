// Run: node public/tests/release-regressions.mjs
// No server, credentials, live providers, or third-party test packages required.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source=fs.readFileSync(new URL('../js/pages/beta.js',import.meta.url),'utf8');
const steps=['instagram','template','sections','next_step','test_drive'];
const goodMe=()=>({user:{role:'owner'},account:{id:'a',access_status:'active'},instagram:{connected:true,needs_reconnect:false}});
const goodProgress=()=>({steps:Object.fromEntries(steps.map(k=>[k,true]))});
const goodRaw=()=>({id:'job-1',status:'done',passed:true,runs:Array.from({length:5},()=>({status:'done',verdict:'pass',transcript:[]}))});
let passed=0;
async function check(name,fn){await fn();passed++;console.log('PASS '+name);}
function element(){return {disabled:false,hidden:false,textContent:'',innerHTML:'',value:'',listeners:{},addEventListener(name,fn){this.listeners[name]=fn;},replaceChildren(){this.innerHTML='';}};}
function harness(api){
 const elements=Object.fromEntries(['#test-start','#test-resume','#test-status','#test-runs','#setup-live'].map(k=>[k,element()]));
 const body={isConnected:true,innerHTML:'',querySelector:s=>elements[s]};
 const storage=new Map();
 const context=vm.createContext({state:{sessionEpoch:1,route:'onboarding',onboardingStep:4,me:goodMe(),onboarding:goodProgress()},SETUP_STEPS:steps.map(k=>[k,k]),api,esc:s=>String(s??''),setupError:e=>e.message,sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},setTimeout,updateSetupProgress(){},confirm:()=>false});
 vm.runInContext(source,context);return {context,body,elements};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const h=harness(async()=>{}),c=h.context;
await check('Both API status formats normalize',()=>{
 assert.equal(c.normalizeTestDrive(goodRaw()).status,'complete');assert.equal(c.normalizeTestDrive({...goodRaw(),status:'complete'}).status,'complete');assert.equal(c.normalizeTestDrive({...goodRaw(),status:'error'}).status,'failed');
});
await check('Malformed and partial results cannot pass',()=>{
 assert.throws(()=>c.normalizeTestDrive({status:'done'}));assert.throws(()=>c.normalizeTestDrive({status:'unknown',runs:[]}));
 assert.equal(c.testDrivePassed(c.normalizeTestDrive({...goodRaw(),runs:[]})),false);
 assert.equal(c.testDrivePassed(c.normalizeTestDrive({...goodRaw(),passed:null})),false);
});
await check('Failed individual run overrides top-level pass',()=>{
 const raw=goodRaw();raw.runs[0].verdict='fail';assert.equal(c.testDrivePassed(c.normalizeTestDrive(raw)),false);
});
await check('Go-live requires owner, active access, connection, all steps and passed results',()=>{
 const job=c.normalizeTestDrive(goodRaw());assert.equal(c.canGoLive(goodMe(),goodProgress(),job),true);
 for(const field of ['pending','paused']){const me=goodMe();me.account.access_status=field;assert.equal(c.canGoLive(me,goodProgress(),job),false);}
 const setter=goodMe();setter.user.role='setter';assert.equal(c.canGoLive(setter,goodProgress(),job),false);
 const reconnect=goodMe();reconnect.instagram.needs_reconnect=true;assert.equal(c.canGoLive(reconnect,goodProgress(),job),false);
 const disconnected=goodMe();disconnected.instagram.connected=false;assert.equal(c.canGoLive(disconnected,goodProgress(),job),false);
 for(const key of steps){const p=goodProgress();p.steps[key]=false;assert.equal(c.canGoLive(goodMe(),p,job),false);}
});
await check('Completed results recover from server history on a fresh visit',async()=>{
 const h=harness(async path=>path==='/api/onboarding/test-drive'?[goodRaw()]:path==='/api/onboarding'?goodProgress():goodRaw());h.context.renderTestDrive(h.body);await settle();
 assert.match(h.elements['#test-status'].textContent,/Passed/);assert.equal(h.elements['#setup-live'].disabled,false);
});
await check('Starting a rerun disables go-live; request failure keeps it disabled',async()=>{
 let rejectStart;
 const h=harness(async(path,opts)=>opts?.method==='POST'?new Promise((_,reject)=>rejectStart=reject):path==='/api/onboarding/test-drive'?[goodRaw()]:path==='/api/onboarding'?goodProgress():goodRaw());
 h.context.renderTestDrive(h.body);await settle();
 const running=h.elements['#test-start'].listeners.click();assert.equal(h.elements['#setup-live'].disabled,true);
 rejectStart(new Error('Offline'));await running;assert.equal(h.elements['#setup-live'].disabled,true);assert.match(h.elements['#test-status'].textContent,/Offline/);
});
await check('Navigation discards late test-drive progress',async()=>{
 let resolve;const h=harness(async path=>path==='/api/onboarding/test-drive'?[goodRaw()]:new Promise(r=>resolve=r));h.context.renderTestDrive(h.body);await settle();
 h.body.isConnected=false;resolve(goodRaw());await settle();assert.doesNotMatch(h.elements['#test-status'].textContent,/Passed/);
});
await check('Session change discards late results',async()=>{
 let resolve;const h=harness(async path=>path==='/api/onboarding/test-drive'?[goodRaw()]:new Promise(r=>resolve=r));h.context.renderTestDrive(h.body);await settle();h.context.state.sessionEpoch++;resolve(goodRaw());await settle();assert.doesNotMatch(h.elements['#test-status'].textContent,/Passed/);
});
await check('Pending accounts can read results but cannot start simulations',async()=>{
 const h=harness(async()=>[]);h.context.state.me.account.access_status='pending';h.context.renderTestDrive(h.body);await settle();assert.equal(h.elements['#test-start'].disabled,true);assert.match(h.elements['#test-status'].textContent,/activated/);
});
await check('Goal changes preserve unsaved links for each goal type',()=>{
 const select=element(),input=element(),form=element(),status=element();form.elements=[select,input];
 const body={innerHTML:'',querySelector:s=>s==='form'?form:s==='select'?select:s==='input'?input:status};
 const h=harness(async()=>{});h.context.state.settings={settings:{next_step_type:'call',calendar_link:'https://example.test/call',next_step_link:'https://example.test/buy'}};
 h.context.renderNextStep(body);input.value='https://example.test/new-call';select.value='checkout';select.listeners.change();input.value='https://example.test/new-checkout';select.value='call';select.listeners.change();assert.equal(input.value,'https://example.test/new-call');select.value='checkout';select.listeners.change();assert.equal(input.value,'https://example.test/new-checkout');
});
const messages=fs.readFileSync(new URL('../js/pages/messages.js',import.meta.url),'utf8');
const render=messages.slice(messages.indexOf('function renderThread()'),messages.indexOf('function dayLabel('));
await check('Unsent text stays with its customer and survives switching back',()=>{
 let input={value:''};const pane={dataset:{},querySelector:s=>s==='#composer-input'?input:null,querySelectorAll:()=>[],set innerHTML(v){input={value:''};}};
 const ctx=vm.createContext({state:{composerDrafts:{},activeId:'a',thread:{conversation:{id:'a',handle:'alpha',stage:'lead'}}},$:s=>s==='#pane-thread'?pane:s==='#composer-input'?input:{classList:{remove(){}}},avatarHtml:()=>'',stageBadge:()=>'',esc:String,icon:()=>'',wireThread(){},renderDraftZone(){},renderMsgs(){}});
 vm.runInContext(render,ctx);ctx.renderThread();input.value='Only for alpha';ctx.state.activeId='b';ctx.state.thread={conversation:{id:'b',handle:'bravo',stage:'lead'}};ctx.renderThread();assert.equal(input.value,'');input.value='Only for bravo';ctx.state.activeId='a';ctx.state.thread={conversation:{id:'a',handle:'alpha',stage:'lead'}};ctx.renderThread();assert.equal(input.value,'Only for alpha');
 ctx.state.thread.conversation.needs_human=true;ctx.renderThread();assert.equal(input.value,'Only for alpha');
});
await check('Failed send is restored to its own conversation without replacing newer writing',()=>{
 const input={value:'Newer writing'};const pane={dataset:{conversationId:'b'},querySelector:()=>input};
 const ctx=vm.createContext({state:{composerDrafts:{a:'Later alpha draft'}},$:()=>pane});
 vm.runInContext(messages.slice(messages.indexOf('function restoreFailedMessage(')),ctx);
 ctx.restoreFailedMessage('a','Failed alpha message');assert.equal(input.value,'Newer writing');assert.equal(ctx.state.composerDrafts.a,'Failed alpha message\nLater alpha draft');
 ctx.restoreFailedMessage('b','Failed bravo message');assert.equal(input.value,'Failed bravo message\nNewer writing');
});

console.log(`${passed} regression checks passed.`);

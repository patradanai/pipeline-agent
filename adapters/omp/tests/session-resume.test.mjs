import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import forgeExtension from '../forge/index.ts';
import { FORGE_STATE_ENTRY, readLatestForgeState, discoverForgeSessions, forgeSessionLabel, resolvePickerSessions, sameResumeCheckpoint } from '../forge/session-resume.mjs';

const fakeZ = new Proxy({}, { get:()=> (..._args)=>({ optional(){return this;} }) });
const tmp = mkdtempSync(join(tmpdir(), 'forge-session-picker-'));
const agentDir = join(tmp, 'agents'); mkdirSync(agentDir, {recursive:true});
process.env.PI_CODING_AGENT_DIR = tmp;
for (const name of ['forge-requirement-gate','forge-plan-gate','forge-execute-gate','forge-qa-gate']) {
  const dir = join(tmp, 'skills', name);
  mkdirSync(dir, {recursive:true});
  copyFileSync(new URL(`../skills/${name}/SKILL.md`, import.meta.url), join(dir, 'SKILL.md'));
}
process.env.FORGE_CONFIG_PATH = join(tmp,'config.json');
process.env.FORGE_REPORT_DIR = join(tmp,'reports');
writeFileSync(process.env.FORGE_CONFIG_PATH, JSON.stringify({ autoStart:false }));
process.on('exit',()=>rmSync(tmp,{recursive:true,force:true}));

function session(name, states) {
  const path = join(tmp,`${name}.jsonl`);
  writeFileSync(path,[
    JSON.stringify({type:'session',id:name,cwd:tmp}),
    ...states.map(data => JSON.stringify({type:'custom',customType:FORGE_STATE_ENTRY,data})),
  ].join('\n')+'\n');
  return path;
}

const active = {active:true,phase:'PLAN',slug:'booking',planWritten:false,approved:false};
const blocked = {active:false,phase:'PLAN_MODE_BLOCKED',blockedFrom:'PROPOSAL',slug:'billing',planWritten:true,planValid:false,approved:false};
const finished = {active:false,phase:'DELIVERY',slug:'old'};

test('reads the latest state, not a stale earlier active checkpoint',async()=>{
  const path=session('completed',[active, finished]);
  assert.deepEqual(await readLatestForgeState(path),finished);
  assert.equal((await discoverForgeSessions([{path}],{})).length,0);
});
test('lists active and explicitly blocked Forge sessions, never cancelled ones',async()=>{
  const a=session('open',[active]);
  const b=session('paused',[blocked]);
  const c=session('cancelled',[active,{active:false,version:8}]);
  const entries=await discoverForgeSessions([{path:a,title:'Booking'},{path:b,title:'Billing'},{path:c,title:'Cancelled'}]);
  assert.equal(entries.length,2);
  assert.match(forgeSessionLabel(entries[0],0),/PLAN.*Booking/);
  assert.match(forgeSessionLabel(entries[1],1),/PLAN.*Billing/);
});

test('OMP v19 PickerListing resolves the complete scan rather than its indexed preview',async()=>{
  const expected=[{path:'/saved/forge.jsonl',title:'Saved Forge run'}];
  const listing={sessions:[],complete:Promise.resolve(expected)};
  assert.deepEqual(await resolvePickerSessions(listing),expected);
  assert.deepEqual(await resolvePickerSessions(expected),expected); // older array API
  assert.deepEqual(await resolvePickerSessions(null),[]);
  assert.deepEqual(await resolvePickerSessions({sessions:'wrong shape'}),[]);
});

test('OMP picker listing falls back safely to preview when full scan fails',async()=>{
  const preview=[{path:'/saved/older.jsonl'}];
  assert.deepEqual(await resolvePickerSessions({sessions:preview,complete:Promise.reject(new Error('scan failed'))}),preview);
  assert.deepEqual(await resolvePickerSessions({sessions:preview,complete:Promise.resolve(null)}),preview);
});

test('/forge resume offers past Forge session, switches natively and continues without gate bypass',async()=>{
  const savedPath=session('saved-active',[active]);
  let branch=[];let currentFile=join(tmp,'current.jsonl');
  const calls=[]; const notifications=[]; let plan='inactive';
  class Manager {
    static async listForPicker(){ return { sessions:[], complete:Promise.resolve([{path:savedPath,title:'Saved booking',cwd:tmp,modified:new Date()}]) }; }
    static async listAllForPicker(){ return [{path:savedPath,title:'Saved booking',cwd:tmp}]; }
    getBranch(){return branch;}
    getSessionFile(){return currentFile;}
    getSessionId(){return 'saved-session';}
    getSessionDir(){return tmp;}
  }
  const handlers=new Map();const commands=new Map();
  const pi={ zod:fakeZ,setLabel(){}, on(name,handler){handlers.set(name,handler)},registerCommand(name,cmd){commands.set(name,cmd)},registerTool(){}, appendEntry(type,data){branch.push({type:'custom',customType:type,data})},sendUserMessage(msg){calls.push(['message',msg])} };
  forgeExtension(pi);
  const ctx={ agent:{kind:'main'},mode:'tui',cwd:tmp,sessionManager:new Manager(),hasPendingMessages(){return false},isIdle(){return true},
    sessionModes:{getState(){return {plan:{status:plan}}}, async set(){plan='active';return {ok:true}}},
    ui:{notify(m){notifications.push(m)},async select(title,options){calls.push(['select',title,options]);return options[0]},setWidget(){}},
    async switchSession(path){calls.push(['switch',path]);currentFile=path;branch=[{type:'custom',customType:FORGE_STATE_ENTRY,data:active}];await handlers.get('session_switch')({},ctx);return {cancelled:false}},
  };
  await handlers.get('session_start')({},ctx);
  await commands.get('forge').handler('resume',ctx);
  assert.equal(calls[0][0],'select');
  assert.equal(calls[1][0],'switch');
  assert.equal(calls[1][1],savedPath);
  assert.equal(calls[2][0],'message');
  assert.match(calls[2][1],/PLANNING/);
  assert.equal(branch.at(-1).data.phase,'PLAN');
  assert.equal(branch.at(-1).data.approved,false);
});

test('/forge resume respects cancel, no session switch or agent turn',async()=>{
  const savedPath=session('saved-cancel',[active]);
  class Manager {static async listForPicker(){return [{path:savedPath,title:'Saved',cwd:tmp}]};getSessionFile(){return '/current'};getBranch(){return []};getSessionDir(){return tmp}}
  const commands=new Map(); const sent=[];const pi={zod:fakeZ,setLabel(){},on(){},registerCommand(n,c){commands.set(n,c)},registerTool(){},appendEntry(){},sendUserMessage(x){sent.push(x)}};
  forgeExtension(pi);
  let switched=false;
  const ctx={mode:'tui',cwd:tmp,sessionManager:new Manager(),ui:{select:async()=>undefined,notify(){},setWidget(){}},switchSession:async()=>{switched=true;return {cancelled:false}}};
  await commands.get('forge').handler('resume',ctx);
  assert.equal(switched,false);assert.equal(sent.length,0);
});

test('/forge resume offers all-projects search and restores blocked plan without auto approval',async()=>{
  const other=session('other-project',[blocked]);
  let branch=[];let plan='inactive';let currentFile='/current.jsonl';const calls=[];const commands=new Map();const events=new Map();
  class Manager {
    static async listForPicker(){return {sessions:[], complete:Promise.resolve([])};}
    static async listAllForPicker(){return {sessions:[], complete:Promise.resolve([{path:other,title:'Old plan',cwd:'/repo-other'}])}}
    getBranch(){return branch;}
    getSessionFile(){return currentFile}
    getSessionDir(){return tmp}
    getSessionId(){return 'other-id'}
  }
  const zod=new Proxy({}, {get:()=>()=>({optional(){return this}})});
  const pi={zod, setLabel(){},on(n,f){events.set(n,f)},registerCommand(n,c){commands.set(n,c)},registerTool(){},appendEntry(n,d){branch.push({type:'custom',customType:n,data:d})},sendUserMessage(...args){calls.push(['message',...args])}};
  forgeExtension(pi);
  const ctx={agent:{kind:'main'},mode:'tui',cwd:tmp,sessionManager:new Manager(),isIdle(){return true},hasPendingMessages(){return false},
    sessionModes:{getState(){return {plan:{status:plan}}},async set(){plan='active';return {ok:true}}},
    ui:{notify(m){calls.push(['notify',m])},setWidget(){},async select(_title,options){calls.push(['picker',options]);return options[0]}},
    async switchSession(path){calls.push(['switch',path]);currentFile=path;branch=[{type:'custom',customType:FORGE_STATE_ENTRY,data:blocked}];await events.get('session_switch')({},ctx);return {cancelled:false}},
  };
  await events.get('session_start')({},ctx);
  await commands.get('forge').handler('resume',ctx);
  assert.equal(calls.filter(c=>c[0]==='picker').length,2);
  assert.deepEqual(calls.find(c=>c[0]==='switch').slice(1),[other]);
  const messages=calls.filter(c=>c[0]==='message');
  assert.equal(messages.length,1);
  assert.match(messages[0][1],/forge_plan_propose/);
  assert.equal(branch.at(-1).data.approved,false);
});


test('checkpoint matcher rejects a stale EXECUTING preview if OMP selected branch restored REQUIREMENT auto',()=>{
  const executing={active:true,phase:'EXECUTING',requirement:'Add cart validation',slug:'forge-work',approved:true,approvedPlanHash:'sha1'};
  const wrong={active:true,phase:'REQUIREMENT',requirement:'auto',slug:'forge-other',approved:false};
  assert.equal(sameResumeCheckpoint(executing,wrong),false);
  assert.equal(sameResumeCheckpoint(executing,{...executing}),true);
  assert.equal(sameResumeCheckpoint(executing,{...executing,approvedPlanHash:'sha2'}),false);
});

test('/forge resume recovers selected EXECUTING workflow while another REQUIREMENT auto is active',async()=>{
  const executing={active:true,phase:'EXECUTE',requirement:'Add cart validation',slug:'forge-cart',approved:true,planValid:true,approvedPlanHash:'approved-hash',executionObserved:false};
  const wrong={active:true,phase:'REQUIREMENT',requirement:'auto',slug:'forge-auto',approved:false};
  const file=session('execution-saved',[executing]);
  const calls=[]; const notifications=[]; const commands=new Map(); const events=new Map();
  let currentFile='/current.jsonl';let branch=[{type:'custom',customType:FORGE_STATE_ENTRY,data:wrong}];
  class Manager {
    static async listForPicker(){return [{path:file,title:'Old cart run'}]}
    static async listAllForPicker(){return []}
    getBranch(){return branch}
    getSessionFile(){return currentFile}
    getSessionDir(){return tmp}
  }
  const pi={zod:fakeZ,setLabel(){},on(n,fn){events.set(n,fn)},registerCommand(n,c){commands.set(n,c)},registerTool(){},appendEntry(n,d){branch.push({type:'custom',customType:n,data:d})},sendUserMessage(text){calls.push(['send',text])}};
  forgeExtension(pi);
  const ctx={agent:{kind:'main'},mode:'tui',cwd:tmp,sessionManager:new Manager(),
    ui:{setWidget(){},notify(message){notifications.push(message)},async select(_title,options){calls.push(['select',options]);return options.find(x=>x.includes('EXECUTE'))}},
    sessionModes:{getState(){return {plan:{status:'inactive'}}}},
    async switchSession(path){calls.push(['switch',path]);currentFile=path;branch=[{type:'custom',customType:FORGE_STATE_ENTRY,data:executing}];await events.get('session_switch')({},ctx);return {cancelled:false}}};
  await events.get('session_start')({},ctx);
  await commands.get('forge').handler('resume',ctx);
  assert.ok(calls.some(x=>x[0]==='switch'&&x[1]===file));
  assert.ok(notifications.some(x=>x.includes('Restored EXECUTE')));
  assert.equal(branch.at(-1).data.phase,'EXECUTE');
  assert.equal(branch.at(-1).data.approved,true);
  assert.equal(calls.some(x=>x[0]==='send'),false,'must not silently rerun executor');
  await commands.get('forge').handler('status',ctx);
  assert.ok(notifications.at(-1).includes('Forge: EXECUTE'));
  assert.ok(notifications.at(-1).includes('approved: yes'));
});

test('/forge resume refuses mismatch between picked file and OMP selected branch, with no execution',async()=>{
  const executing={active:true,phase:'EXECUTING',requirement:'Build billing',slug:'forge-billing',approved:true};
  const wrong={active:true,phase:'REQUIREMENT',requirement:'auto',slug:'forge-auto',approved:false};
  const file=session('branch-drift',[executing]);
  const notifications=[]; const commands=new Map(); const events=new Map(); const sent=[];
  let branch=[];let currentFile='/current.jsonl';
  class Manager { static async listForPicker(){return [{path:file}]};getBranch(){return branch};getSessionFile(){return currentFile};getSessionDir(){return tmp} }
  const pi={zod:fakeZ,setLabel(){},on(n,fn){events.set(n,fn)},registerCommand(n,c){commands.set(n,c)},registerTool(){},appendEntry(){},sendUserMessage(x){sent.push(x)}};
  forgeExtension(pi);
  const ctx={agent:{kind:'main'},mode:'tui',cwd:tmp,sessionManager:new Manager(),ui:{setWidget(){},notify(x){notifications.push(x)},async select(_title,options){return options[0]}},async switchSession(path){currentFile=path;branch=[{type:'custom',customType:FORGE_STATE_ENTRY,data:wrong}];await events.get('session_switch')({},ctx);return {cancelled:false}}};
  await events.get('session_start')({},ctx);
  await commands.get('forge').handler('resume',ctx);
  assert.ok(notifications.some(x=>x.includes('checkpoint mismatch')));
  assert.equal(sent.length,0);
});

test('bare /forge auto is help, never starts REQUIREMENT auto',async()=>{
  const commands=new Map();const sent=[];const notifications=[];
  const pi={zod:fakeZ,setLabel(){},on(){},registerCommand(n,c){commands.set(n,c)},registerTool(){},appendEntry(){},sendUserMessage(x){sent.push(x)}};
  forgeExtension(pi);
  const ctx={agent:{kind:'main'},mode:'tui',ui:{notify(x){notifications.push(x)}}};
  await commands.get('forge').handler('auto',ctx);
  assert.ok(notifications.some(x=>x.includes('Usage: /forge auto on')));
  assert.equal(sent.length,0);
});


test('resume picker lets user choose current rather than silently using current requirement',async()=>{
  const activeCurrent={active:true,phase:'REQUIREMENT',requirement:'auto',slug:'forge-auto'};
  const commands=new Map();const events=new Map();const notices=[];let switches=0;
  class Manager {static async listForPicker(){return []};getBranch(){return [{type:'custom',customType:FORGE_STATE_ENTRY,data:activeCurrent}]};getSessionFile(){return '/current.jsonl'};getSessionDir(){return tmp}}
  const pi={zod:fakeZ,setLabel(){},on(n,f){events.set(n,f)},registerCommand(n,c){commands.set(n,c)},registerTool(){},appendEntry(){},sendUserMessage(){}};
  forgeExtension(pi);
  const ctx={agent:{kind:'main'},mode:'tui',cwd:tmp,sessionManager:new Manager(),
    ui:{notify(x){notices.push(x)},setWidget(){},async select(_title,options){assert.ok(options[0].includes('Continue current'));return options[0]}},
    sessionModes:{getState(){return {plan:{status:'active'}}},async set(){return {ok:true}}},
    async switchSession(){switches++;return {cancelled:false}}};
  await events.get('session_start')({},ctx);
  await commands.get('forge').handler('resume',ctx);
  assert.equal(switches,0);
  assert.ok(notices.every(x=>!x.includes('checkpoint mismatch')));
});

test('v5.18: evidence-pending QA session is resumable without losing approved checkpoint', async () => {
  const {isResumableForgeState} = await import('../forge/session-resume.mjs');
  assert.equal(isResumableForgeState({phase:'QA',active:true,approved:true,approvedPlanHash:'approved-hash',qaStatus:'BLOCKED',qaEvidencePending:true}),true);
  assert.equal(isResumableForgeState({phase:'QA',active:false,qaStatus:'BLOCKED'}),false);
});

test('v5.23: session discovery reads in parallel but keeps picker order', async () => {
  const sessions=Array.from({length:20},(_,i)=>({path:`/s/${i}.jsonl`}));
  let inflight=0, peak=0;
  const readState=async p=>{ inflight++; peak=Math.max(peak,inflight); await new Promise(r=>setTimeout(r,(20-Number(p.match(/(\d+)/)[1]))%5)); inflight--;
    return {active:true,phase:'PLANNING',slug:'s'+p.match(/(\d+)/)[1]}; };
  const found=await discoverForgeSessions(sessions,{readState,concurrency:4});
  assert.deepEqual(found.map(f=>f.info.path),sessions.map(s=>s.path));
  assert.ok(peak>1 && peak<=4);
});

test('session discovery normalizes legacy phases without granting approval', async () => {
  const found = await discoverForgeSessions([{path:'/legacy'}], {
    readState: async () => ({active:true,phase:'AWAITING_APPROVAL',slug:'legacy',planWritten:true,planValid:true,approved:false}),
  });
  assert.equal(found[0].state.phase,'PLAN');
  assert.equal(found[0].state.approved,false);
  assert.equal(sameResumeCheckpoint(found[0].state,{...found[0].state,phase:'AWAITING_APPROVAL'}),true);
});

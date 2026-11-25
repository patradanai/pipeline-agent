import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionIdentity, persistForgeCheckpoint, loadForgeCheckpoint, candidateFromSessionEntries, prepareHumanRecovery } from '../forge/checkpoint-recovery.mjs';
import { FORGE_STATE_ENTRY } from '../forge/session-resume.mjs';

const temp = mkdtempSync(join(tmpdir(), 'forge-checkpoints-'));
process.on('exit', () => rmSync(temp, { recursive:true, force:true }));
const sessionFile = join(temp, 'sessions', 'session-one.jsonl');
const context = { getSessionId: () => 'session-one', getSessionFile: () => sessionFile };
const state = { active:true, phase:'EXECUTE', slug:'forge-example', requirement:'Implement test feature', approved:true, planValid:true, planWritten:true, planPath:'local://forge-example-plan.md', approvedPlanHash:'approved-hash', qaStatus:'pending' };

test('checkpoint identity is exact to OMP session id and absolute file', () => {
  assert.equal(sessionIdentity(context, temp).sessionFile, sessionFile);
  assert.equal(sessionIdentity({getSessionId:()=> 'same'}, temp), null);
  assert.equal(sessionIdentity({getSessionId:()=> 'same',getSessionFile:()=> 'relative.jsonl'}, temp), null);
});

test('checkpoint mirror survives restart and cannot be loaded under another session', () => {
  const dir = join(temp,'checkpoints');
  const id = sessionIdentity(context,temp);
  assert.equal(persistForgeCheckpoint(dir,id,state),true);
  assert.deepEqual(loadForgeCheckpoint(dir,id),state);
  const other = sessionIdentity({getSessionId:()=> 'session-two', getSessionFile:()=> sessionFile},temp);
  assert.equal(loadForgeCheckpoint(dir,other),null);
  const otherPath = sessionIdentity({getSessionId:()=> 'session-one',getSessionFile:()=> join(temp,'sessions','branch.jsonl')},temp);
  assert.equal(loadForgeCheckpoint(dir,otherPath),null);
});

test('completed or cancelled state cannot be revived', () => {
  const dir = join(temp,'completed');
  const id = sessionIdentity(context,temp);
  persistForgeCheckpoint(dir,id,{...state,phase:'QA',qaStatus:'PASS',active:false});
  assert.equal(loadForgeCheckpoint(dir,id),null);
  persistForgeCheckpoint(dir,id,{...state,active:false,phase:'EXECUTE'});
  assert.equal(loadForgeCheckpoint(dir,id),null);
});

test('symlink checkpoint is not followed', () => {
  const dir=join(temp,'links');mkdirSync(dir,{recursive:true});
  const id=sessionIdentity(context,temp);
  symlinkSync(join(temp,'somewhere.json'),join(dir,`${id.fingerprint}.json`));
  assert.equal(loadForgeCheckpoint(dir,id),null);
});

test('full session history candidate is only selected when unambiguous', () => {
  const entry = data => ({type:'custom',customType:FORGE_STATE_ENTRY,data});
  assert.deepEqual(candidateFromSessionEntries([entry(state)]),state);
  assert.deepEqual(candidateFromSessionEntries([entry(state),entry({...state,phase:'QA'})]).phase,'QA');
  assert.equal(candidateFromSessionEntries([entry(state),entry({...state,slug:'forge-other'})]),null);
  assert.equal(candidateFromSessionEntries([entry(state),entry({...state,active:false})]),null);
  assert.equal(candidateFromSessionEntries([entry(state),entry({active:false,version:9})]),null);
});

test('human-approved off-branch checkpoint returns to fresh planning, not execution', () => {
  const recovered = prepareHumanRecovery({...state,autoApprovePlans:true});
  assert.equal(recovered.phase,'PLAN');
  assert.equal(recovered.approved,false);
  assert.equal(recovered.autoApprovePlans,false);
  assert.equal(recovered.approvedPlanHash,null);
  assert.equal(recovered.planWritten,false);
  assert.equal(recovered.planValid,false);
  assert.equal(recovered.planPath,null);
  assert.equal(recovered.qaStatus,'pending');
  assert.equal(recovered.recoveryAudit.at(-1).priorApprovalRevoked,true);
});

test('requirement-only checkpoint recovers as PLAN without fabricating approval', () => {
  const recovered=prepareHumanRecovery({...state,phase:'REQUIREMENT',approved:true});
  assert.equal(recovered.phase,'PLAN');
  assert.equal(recovered.approved,false);
  assert.equal(recovered.approvedPlanHash,null);
});

test('invalid or untrusted recovery candidates cannot be executed', () => {
  assert.throws(()=>prepareHumanRecovery({...state,slug:'../escape'}),/Invalid/);
  assert.throws(()=>prepareHumanRecovery({...state,requirement:''}),/Invalid/);
});

// ---------------------------------------------------------------- v5.23
import { statSync, chmodSync, utimesSync, readdirSync } from 'node:fs';
import { loadForgeCheckpointCandidates, pruneForgeCheckpoints, recoveryIdentity } from '../forge/checkpoint-recovery.mjs';

test('v5.23: mirror keeps different workflows instead of last-writer-wins', () => {
  const dir=join(temp,'multi'); const id=sessionIdentity(context,temp);
  persistForgeCheckpoint(dir,id,{...state,slug:'forge-a',requirement:'A'});
  persistForgeCheckpoint(dir,id,{...state,slug:'forge-b',requirement:'B',phase:'PLAN',approved:false});
  const list=loadForgeCheckpointCandidates(dir,id);
  assert.deepEqual(list.map(c=>c.state.slug),['forge-b','forge-a']);
  assert.ok(list[0].savedAt);
  // updating A moves it to the front without duplicating it
  persistForgeCheckpoint(dir,id,{...state,slug:'forge-a',requirement:'A',phase:'QA'});
  assert.deepEqual(loadForgeCheckpointCandidates(dir,id).map(c=>`${c.state.slug}:${c.state.phase}`),['forge-a:QA','forge-b:PLAN']);
});

test('v5.23: named cancel retires one workflow; anonymous tombstone retires all', () => {
  const dir=join(temp,'cancel'); const id=sessionIdentity(context,temp);
  persistForgeCheckpoint(dir,id,{...state,slug:'forge-a'});
  persistForgeCheckpoint(dir,id,{...state,slug:'forge-b'});
  persistForgeCheckpoint(dir,id,{active:false,version:9,cancelledSlug:'forge-b'});
  assert.deepEqual(loadForgeCheckpointCandidates(dir,id),[]); // terminal latest: nothing offered
  persistForgeCheckpoint(dir,id,{...state,slug:'forge-c'});
  assert.deepEqual(loadForgeCheckpointCandidates(dir,id).map(c=>c.state.slug),['forge-c','forge-a']);
  persistForgeCheckpoint(dir,id,{active:false,version:9});
  persistForgeCheckpoint(dir,id,{...state,slug:'forge-d'});
  assert.deepEqual(loadForgeCheckpointCandidates(dir,id).map(c=>c.state.slug),['forge-d']);
});

test('legacy blocked workflows migrate to active gates; completed delivery is not restored', () => {
  const dir=join(temp,'blocked'); const id=sessionIdentity(context,temp);
  persistForgeCheckpoint(dir,id,{...state,phase:'EXECUTION_BLOCKED',active:false});
  assert.equal(loadForgeCheckpointCandidates(dir,id)[0].state.phase,'EXECUTE');
  persistForgeCheckpoint(dir,id,{...state,phase:'DELIVERY',active:false});
  assert.deepEqual(loadForgeCheckpointCandidates(dir,id),[]);
});

test('v5.23: schema 1 mirrors from v5.22 are still readable', () => {
  const dir=join(temp,'schema1'); mkdirSync(dir,{recursive:true}); const id=sessionIdentity(context,temp);
  writeFileSync(join(dir,`${id.fingerprint}.json`),JSON.stringify({schema:1,identity:id,savedAt:'2026-11-19T00:00:00.000Z',state:{...state,phase:'EXECUTING'}}));
  const list=loadForgeCheckpointCandidates(dir,id);
  assert.equal(list[0].state.slug,'forge-example');
  assert.equal(list[0].state.phase,'EXECUTE');
  assert.equal(list[0].savedAt,'2026-11-19T00:00:00.000Z');
});

test('v5.23: checkpoint dir is tightened to 0700 and files are 0600', () => {
  const dir=join(temp,'perms'); mkdirSync(dir,{recursive:true,mode:0o755}); chmodSync(dir,0o755);
  const id=sessionIdentity(context,temp);
  persistForgeCheckpoint(dir,id,state);
  assert.equal(statSync(dir).mode & 0o777,0o700);
  assert.equal(statSync(join(dir,`${id.fingerprint}.json`)).mode & 0o777,0o600);
  assert.deepEqual(readdirSync(dir).filter(n=>n.includes('.tmp-')),[]);
});

test('v5.23: prune removes only stale Forge-named files', () => {
  const dir=join(temp,'prune'); const id=sessionIdentity(context,temp);
  persistForgeCheckpoint(dir,id,state);
  const stale='a'.repeat(64)+'.json'; const tmpLeft='b'.repeat(64)+'.json.tmp-1-abc'; const foreign='notes.json';
  for (const n of [stale,tmpLeft,foreign]) writeFileSync(join(dir,n),'{}');
  const old=new Date(Date.now()-40*24*3600*1000);
  for (const n of [stale,tmpLeft,foreign]) utimesSync(join(dir,n),old,old);
  assert.equal(pruneForgeCheckpoints(dir),2);
  assert.deepEqual(readdirSync(dir).sort(),[`${id.fingerprint}.json`,foreign].sort());
});

test('v5.23: file-less sessions get an in-memory key but never a mirror', () => {
  const mem=recoveryIdentity({getSessionId:()=> 'mem-only'},temp);
  assert.match(mem.fingerprint,/^memory-/);
  assert.equal(persistForgeCheckpoint(join(temp,'mem'),mem,state),false);
});

test('v5.23: history fallback honours a named cancel', () => {
  const entry=data=>({type:'custom',customType:FORGE_STATE_ENTRY,data});
  assert.equal(candidateFromSessionEntries([entry(state),entry({active:false,version:9,cancelledSlug:'forge-example'})]),null);
  assert.equal(candidateFromSessionEntries([entry({...state,slug:'forge-x'}),entry(state),entry({active:false,version:9,cancelledSlug:'forge-example'})]).slug,'forge-x');
});

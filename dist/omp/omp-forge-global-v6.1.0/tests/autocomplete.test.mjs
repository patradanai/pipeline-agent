import test from 'node:test';
import assert from 'node:assert/strict';
import { getForgeArgumentCompletions, parseCommand } from '../forge/core.mjs';
import forgeExtension from '../forge/index.ts';

const cfg = {
  agents: ['forge-planner','forge-qa','my-critic','my-planner'],
  skills: ['api-contract','go-testing','security-review'],
  gateSkills: {requirement:['security-review'],planning:[],execution:[],qa:['go-testing'],delivery:[]},
};
const suggest = (s, options=cfg) => getForgeArgumentCompletions(s,options);
const values = (s, options=cfg) => (suggest(s,options) ?? []).map(item=>item.value);

test('root menu lists commands without exposing debug workflow phases', () => {
  assert.ok(values(' ').includes('skill '));
  assert.ok(values('').includes('agents'));
  assert.equal(suggest('agent '),null);
  assert.ok(values(' ').includes('status'));
  assert.ok(values(' ').includes('delivery'));
  assert.ok(!values(' ').some(x=>/cooking|challenge|awaiting/i.test(x)));
  assert.ok(!values(' ').some(x=>/^(quick|thorough|mode|--fast)\b/.test(x)));
  assert.equal(suggest('qui'),null);
  assert.ok(suggest(' ')[0].label.includes('·'));
});

test('root prefix completes only matching commands and inserts full arguments', () => {
  assert.deepEqual(values('sta'), ['status']);
  assert.deepEqual(values('aut'), ['auto ']);
  assert.deepEqual(values('auto '), ['auto on','auto off']);
  assert.deepEqual(values('agents'), ['agents']);
  assert.equal(suggest('agent set '), null);
});

test('skill subcommands are discoverable and nested', () => {
  const all = values('skill ');
  assert.ok(all.includes('skill create '));
  assert.ok(all.includes('skill add '));
  assert.ok(all.includes('skill remove '));
  assert.deepEqual(values('skill cr'), ['skill create ']);
  assert.deepEqual(values('skill add q'), ['skill add qa ']);
  assert.deepEqual(values('skill create '), ['skill create requirement ', 'skill create planning ', 'skill create execution ', 'skill create qa ', 'skill create delivery ']);
});

test('skill names are dynamically completed after the selected gate', () => {
  assert.deepEqual(values('skill add qa go'), ['skill add qa go-testing']);
  assert.deepEqual(values('skill remove qa '), ['skill remove qa go-testing']);
  assert.deepEqual(values('skill remove requirement '), ['skill remove requirement security-review']);
  assert.equal(suggest('skill remove delivery '),null);
  assert.deepEqual(values('skill reset '), ['skill reset requirement','skill reset planning','skill reset execution','skill reset qa','skill reset delivery','skill reset all']);
});

test('only the OMP-native read-only /forge agents command is suggested', () => {
  assert.ok(values('a').includes('agents'));
  assert.equal(suggest('agent '),null);
  assert.equal(suggest('agent set planning '),null);
});

test('completion results are real commands supported by parser', () => {
  assert.deepEqual(parseCommand(values('skill add qa go')[0]), {type:'skillAdd',gate:'qa',name:'go-testing'});
  assert.deepEqual(parseCommand(values('agents')[0]), {type:'agents'});
  assert.deepEqual(parseCommand(values('auto o')[0]), {type:'auto',enabled:true});
});

test('free-form requirements are never hijacked by completion', () => {
  for (const s of ['Build a booking system','need feature','skill add qa go-testing and review it','agent set planning my-planner extra', 'status please']) {
    assert.equal(suggest(s),null, s);
  }
  assert.equal(suggest('A'.repeat(257)),null);
  assert.equal(suggest('anything\nelse'),null);
  assert.equal(suggest('unknown-command '),null);
});

test('registered /forge command exposes native OMP argument completion', () => {
  let cmd;
  forgeExtension({
    setLabel(){},
    on(){},
    registerCommand(name, definition){ if(name==='forge')cmd=definition; },
    registerTool(){},
    zod: new Proxy({}, { get(){ return () => ({optional(){return this;}}); } }),
  });
  assert.equal(typeof cmd?.getArgumentCompletions, 'function');
  assert.ok(cmd.getArgumentCompletions('skill ').some(x=>x.value==='skill create '));
});

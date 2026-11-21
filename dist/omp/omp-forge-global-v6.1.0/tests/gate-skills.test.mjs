import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cloneGateSkills, addGateSkill, removeGateSkill, resetGateSkills,
  currentSkillGate, injectGateSkillsIntoTask, initialState, parseCommand,
  formatGateSkills, validateSkillMarkdown,
} from '../forge/core.mjs';

test('new workflows have five separate empty skill lists, no sixth approval gate', () => {
  const mapping=cloneGateSkills();
  assert.deepEqual(Object.keys(mapping), ['requirement','planning','execution','qa','delivery']);
  assert.deepEqual(mapping.qa,[]);
  assert.equal(currentSkillGate('AWAITING_APPROVAL'),'planning');
  assert.equal(currentSkillGate('REQUIREMENT'),'requirement');
});
test('gate skills can be added, removed and reset without mutating input', () => {
  const empty=cloneGateSkills();
  let next=addGateSkill(empty,'qa','go-testing');
  next=addGateSkill(next,'qa','go-testing');
  next=addGateSkill(next,'requirement','security-review');
  assert.deepEqual(next.qa,['go-testing']);
  assert.deepEqual(empty.qa,[]);
  assert.match(formatGateSkills(next),/go-testing/);
  assert.deepEqual(removeGateSkill(next,'qa','go-testing').qa,[]);
  assert.deepEqual(resetGateSkills(next,'qa').qa,[]);
  assert.deepEqual(resetGateSkills(next,'qa').requirement,['security-review']);
  assert.deepEqual(resetGateSkills(next,'all'),empty);
  assert.throws(()=>removeGateSkill(next,'qa','unknown'),/not attached/);
});
test('invalid skill identifiers, duplicates, unknown gates and excessive packs fail closed', () => {
  assert.throws(()=>addGateSkill(null,'qa','../../bad'),/kebab-case/);
  assert.throws(()=>addGateSkill(null,'approve','a-skill'),/Unknown skill gate/);
  assert.throws(()=>cloneGateSkills({qa:['a','a']}),/Duplicate/);
  assert.throws(()=>cloneGateSkills({qa:['a','b','c','d','e','f','g']}),/at most/);
  assert.throws(()=>cloneGateSkills({approval:[]}),/Unknown skill gate/);
});
test('each run freezes its assigned gate skills independent of future settings',()=>{
  const config=addGateSkill(null,'planning','api-design');
  const state=initialState('Build API','test',null,config,{'api-design':{path:'/tmp/api-design/SKILL.md',sha256:'abc'}});
  assert.deepEqual(state.gateSkills.planning,['api-design']);
  assert.equal(state.skillPins['api-design'].sha256,'abc');
  const later=addGateSkill(config,'planning','security-review');
  assert.deepEqual(state.gateSkills.planning,['api-design']);
  assert.deepEqual(later.planning,['api-design','security-review']);
});
test('inject skill content in individual flat and batched task prompts without dropping metadata',()=>{
  const original={agent:'forge-planner',task:'Write plan',solutionSpace:'fixed',effort:'high'};
  const injected=injectGateSkillsIntoTask(original,'PLANNING','Skill: API contract\nNo hidden assumptions');
  assert.notStrictEqual(injected,original);
  assert.match(injected.task,/VERIFIED SNAPSHOT/);
  assert.match(injected.task,/No hidden assumptions/);
  assert.equal(injected.solutionSpace,'fixed');
  assert.equal(original.task,'Write plan');
  assert.equal(injectGateSkillsIntoTask(injected,'PLANNING','Skill: API contract').task,injected.task);
  const batch={context:'Shared brief', tasks:[{agent:'forge-qa',task:'Check business'},{agent:'forge-code-reviewer',task:'Review diff'}]};
  const result=injectGateSkillsIntoTask(batch,'QA_REVIEW','security baseline');
  assert.equal(result.context,'Shared brief');
  assert.ok(result.tasks.every(t=>t.task.includes('security baseline')));
  assert.equal(injectGateSkillsIntoTask({tasks:[{agent:'qa',steps:['do this']} ]},'QA_REVIEW','skill'),null);
});
test('skill commands are not parsed as user requirements',()=>{
  assert.deepEqual(parseCommand('skills'),{type:'skills'});
  assert.deepEqual(parseCommand('skill'),{type:'skillMenu'});
  assert.deepEqual(parseCommand('skill list'),{type:'skillList'});
  assert.deepEqual(parseCommand('skill add qa go-testing'),{type:'skillAdd',gate:'qa',name:'go-testing'});
  assert.deepEqual(parseCommand('skill remove qa go-testing'),{type:'skillRemove',gate:'qa',name:'go-testing'});
  assert.deepEqual(parseCommand('skill reset all'),{type:'skillReset',gate:'all'});
  assert.equal(parseCommand('skill add qa').type,'skillInvalid');
});

test('pasted SKILL.md parsing requires safe, portable frontmatter and nonempty body', () => {
  const source = `---\nname: security-custom\ndescription: Security review.\n---\n\n# Review\n- Check roles\n`;
  assert.deepEqual(validateSkillMarkdown(source), {
    name:'security-custom', description:'Security review.', content:source, size:Buffer.byteLength(source),
  });
  assert.equal(validateSkillMarkdown(source.replaceAll('\n','\r\n')).name,'security-custom');
  for (const invalid of [
    '# Plain Markdown only',
    '---\nname: ../../escape\ndescription: Bad\n---\nBody',
    '---\nname: Valid_Name\ndescription: Bad\n---\nBody',
    '---\nname: demo\n---\nBody',
    '---\nname: demo\ndescription: test\n---\n',
    '---\nname: demo\nname: demo\ndescription: test\n---\nBody',
    '---\nname: demo\ndescription: |\n  nested\n---\nBody',
    source + '\0',
    source + 'X'.repeat(25*1024),
  ]) assert.throws(() => validateSkillMarkdown(invalid), /(?:SKILL|frontmatter|name|description|bytes|NUL|syntax)/i);
});
test('skill create command supports optional gate and does not become a requirement',()=>{
  assert.deepEqual(parseCommand('skill create'),{type:'skillCreate',gate:null});
  assert.deepEqual(parseCommand('skill create qa'),{type:'skillCreate',gate:'qa'});
  assert.deepEqual(parseCommand('skill create PLANNING'),{type:'skillCreate',gate:'planning'});
  assert.equal(parseCommand('skill create invalid').type,'skillInvalid');
  assert.equal(parseCommand('skill create qa other').type,'skillInvalid');
});

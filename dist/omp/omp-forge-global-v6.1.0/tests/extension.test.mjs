import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync, writeFileSync, copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {createHash} from 'node:crypto';
import forgeExtension from '../forge/index.ts';
import {requiredAgentsFor, initialState, renderForgeWidget} from '../forge/core.mjs';

const tmp = mkdtempSync(join(tmpdir(),'omp-forge-tests-'));
process.env.FORGE_REPORT_DIR = tmp;
process.env.FORGE_CONFIG_PATH = join(tmp, 'test-forge-config.json');
process.env.PI_CODING_AGENT_DIR = join(tmp, 'agent-home');
mkdirSync(join(process.env.PI_CODING_AGENT_DIR, 'agents'), {recursive:true});
for (const name of ['forge-code-reviewer','forge-plan-critic','my-planner']) {
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR,'agents',`${name}.md`),'---\nname: '+name+'\ndescription: Custom specialist\n---\nTest specialist\n');
}
for (const name of ['forge-plan-gate','forge-execute-gate','forge-qa-gate']) {
  const dir = join(process.env.PI_CODING_AGENT_DIR, 'skills', name);
  mkdirSync(dir, {recursive:true});
  copyFileSync(new URL(`../skills/${name}/SKILL.md`, import.meta.url), join(dir, 'SKILL.md'));
}
writeFileSync(process.env.FORGE_CONFIG_PATH, JSON.stringify({autoStart:false})+'\n');
process.on('exit',()=>rmSync(tmp,{recursive:true,force:true}));

const fakeZ = new Proxy({}, {
  get: (_target, prop) => {
    if (prop === 'object' || prop === 'array' || prop === 'enum' || prop === 'string' || prop === 'boolean') {
      return (..._args) => ({ optional() { return this; } });
    }
  },
});

let savedSessionSeq = 0;
function setup({persistentSession=false} = {}) {
  const events = new Map();
  const commands = new Map();
  const tools = new Map();
  const sent = [];
  const shown = [];
  const entries = [];
  const sessionPath = join(tmp,`session-${++savedSessionSeq}.jsonl`);
  let branchEntries = null;
  const notifications = [];
  let plan = 'inactive';
  // Gate-model spies: inert unless a test sets ctx.models.
  const log = [];
  let currentModel = null;
  let thinking = undefined;
  const pi = {
    zod:fakeZ,
    setLabel() {},
    on(event, handler) { events.set(event, handler); },
    registerCommand(name, cmd) { commands.set(name, cmd); },
    registerTool(tool) { tools.set(tool.name, tool); },
    sendUserMessage(content, options) { sent.push({content, options}); log.push(['send', content]); },
    sendMessage(message, options) { shown.push({message, options}); },
    appendEntry(customType, data) { entries.push({type:'custom', customType, data}); },
    async setModel(m) { log.push(['setModel', `${m.provider}/${m.id}`]); currentModel = m; return true; },
    getThinkingLevel() { return thinking; },
    setThinkingLevel(l) { log.push(['thinking', l]); thinking = l; },
  };
  forgeExtension(pi);
  const ctx = {
    agent: {kind:'main'}, mode:'tui',
    sessionModes: {
      getState: () => ({plan:{status:plan}}),
      set: async ({action} = {}) => { plan = action === 'exit' ? 'inactive' : 'active'; return {ok:true,changed:true}; },
    },
    sessionManager: { getBranch: () => branchEntries ?? entries, getEntries: () => entries, getSessionId: () => persistentSession ? `test-session-${savedSessionSeq}` : 'test-session', getSessionFile: () => sessionPath },
    ui: {notify: (message, level) => notifications.push({message, level}), input: async () => 'Create a CRM'},
    hasPendingMessages: () => false,
    isIdle: () => true,
    setTimeout: () => {},
  };
  return {events,commands,tools,sent,shown,entries,notifications,ctx,getPlan:()=>plan,setPlan:v=>{plan=v;},setBranch:v=>{branchEntries=v;},sessionPath,
    log, getModel:()=>currentModel, setModel:v=>{currentModel=v;}, setThinking:v=>{thinking=v;}};
}

const PLAN = `# Plan\n## Context\nUsers create bookings and managers approve them.\n## Approach\n1. Add createBooking and approveBooking (REQ-001, REQ-002).\n- Open decisions: none\n- Migration & rollback: not applicable — no data or API change\n## Verification\n- node test: TC-001 and TC-002 pass\n## Assumptions & contingencies\n- none\n## Business Topics\n- BIZ-001: Booking\n- BIZ-002: Approval\n## Requirement Traceability\n- REQ-001 | BIZ-001 | Create booking | Created\n- REQ-002 | BIZ-002 | Approve booking | Approved\n## Business Test Cases\n- TC-001 | BIZ-001 | REQ-001 | Create booking | Created | node test\n- TC-002 | BIZ-002 | REQ-002 | Approve booking | Approved | node test\n## Code Quality Gates\n- QG-001: Unit tests\n- QG-002: Lint\n`;
const SUBMISSION = {
  topicResults:[
    {topicId:'BIZ-001',tests:[{testId:'TC-001',requirementIds:['REQ-001'],scenario:'Create booking',expected:'Created',actual:'Created',status:'PASS',evidence:'test booking passed',severity:'HIGH'}]},
    {topicId:'BIZ-002',tests:[{testId:'TC-002',requirementIds:['REQ-002'],scenario:'Approve booking',expected:'Approved',actual:'Approved',status:'PASS',evidence:'test approval passed',severity:'HIGH'}]},
  ],
  codeQualityChecks:[{gateId:'QG-001',name:'unit tests',status:'PASS',evidence:'tests exit 0'},{gateId:'QG-002',name:'lint',status:'PASS',evidence:'lint exit 0'}],
  codeReview:{status:'PASS',evidence:'Reviewed service.ts:10-90',findings:[]},
  reviewedChanges:['service.ts'],
};

let agentCallSeq = 0;
async function runCompletedAgent(x, agent) {
  const id = `task-${++agentCallSeq}`;
  await x.events.get('tool_call')({toolName:'task',toolCallId:id,input:{agent,task:'Analyze and report evidence'}},x.ctx);
  const spawned = await x.events.get('before_subagent_spawn')({agent},x.ctx);
  assert.notEqual(spawned?.block,true,`unexpected block for ${agent}`);
  return await x.events.get('tool_result')({toolName:'task',toolCallId:id,isError:false,content:[{type:'text',text:'Completed task and returned evidence'}]},x.ctx);
}

function planFile(x, path) {
  return join(x.sessionPath.replace(/\.jsonl$/,''), 'local', path.replace(/^local:\/\//,''));
}
function putPlanFile(x, path, content = PLAN) {
  const file = planFile(x, path);
  mkdirSync(dirname(file), {recursive:true});
  writeFileSync(file, content);
}
async function writeCanonicalPlan(x, targetPath = null, content = PLAN) {
  const state = x.entries.at(-1).data;
  const path = targetPath ?? `local://${state.slug}-plan.md`;
  const id = `write-${++agentCallSeq}`;
  assert.equal(await x.events.get('tool_call')({toolName:'write',toolCallId:id,input:{path,content}},x.ctx),undefined);
  putPlanFile(x, path, content);
  return path;
}
async function proposePlan(x) {
  return await x.tools.get('forge_plan_propose').execute('propose',{},undefined,undefined,x.ctx);
}
async function approvePlan(x, choice = 'Approve and keep context') {
  const previous = x.ctx.ui.select;
  x.ctx.ui.select = async (_title, options) => { assert.ok(options.includes(choice), `missing choice ${choice}`); return choice; };
  try { await x.commands.get('forge').handler('review', x.ctx); }
  finally { x.ctx.ui.select = previous; }
}
async function reachPlanning(x, requirement = 'Plan a feature') {
  await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler(requirement,x.ctx);
  return x.entries.at(-1).data;
}

async function runQaAgents(x) {
  await runCompletedAgent(x,'forge-code-reviewer');
}

async function advanceToReview(x) {
  await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Create a CRM',x.ctx);
  assert.equal(x.getPlan(),'inactive');
  assert.match(x.sent[0].content,/GATE 1\/3: PLAN — Forge plan mode/);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  await writeCanonicalPlan(x);
  const proposed = await proposePlan(x);
  assert.notEqual(proposed.isError, true, proposed.content[0].text);
  assert.equal(x.entries.at(-1).data.businessTopics.length,2);
  assert.equal(x.entries.at(-1).data.requirements.length,2);
  assert.equal(x.entries.at(-1).data.qualityGates.length,2);
}

async function reachInactiveExecution(x) {
  await advanceToReview(x);
  await approvePlan(x);
  await x.events.get('agent_start')({},x.ctx);
  x.entries.push({type:'custom', customType:'dev.omp-forge.workflow.v1', data:{...x.entries.at(-1).data, active:false}});
  await x.events.get('session_start')({},x.ctx);
  return x.entries.at(-1).data;
}

test('native provider rate limits preserve approved execution until a successful stop', async () => {
  const x=setup(); await advanceToReview(x);
  await approvePlan(x);
  await x.events.get('agent_start')({},x.ctx);
  const before=structuredClone(x.entries.at(-1).data);
  const savedEntries=x.entries.length, sentMessages=x.sent.length;
  const providerFailure={last_assistant_message:{role:'assistant',content:[],stopReason:'error',errorStatus:429}};
  for (let i=0;i<2;i++) {
    assert.equal(await x.events.get('session_stop')(providerFailure,x.ctx),undefined);
    const state=x.entries.at(-1).data;
    assert.equal(state.phase,'EXECUTE');
    assert.equal(state.active,true);
    assert.equal(state.approved,true);
    assert.equal(state.approvedPlanHash,before.approvedPlanHash);
    assert.equal(state.planPath,before.planPath);
    assert.deepEqual(state.agentRetries,before.agentRetries);
    assert.deepEqual(state.agentCompletions,before.agentCompletions);
    assert.equal(x.entries.length,savedEntries);
    assert.equal(x.sent.length,sentMessages);
  }
  const success=await x.events.get('session_stop')({last_assistant_message:{role:'assistant',content:[],stopReason:'stop'}},x.ctx);
  assert.equal(success.continue,true);
  assert.match(success.additionalContext,/POST-EXECUTION QA REVIEW/);
  assert.equal(x.entries.at(-1).data.phase,'QA');
});

test('aborted stops do not spend retries; legacy stops without assistant payload still continue', async () => {
  const x=setup(); await advanceToReview(x);
  await approvePlan(x);
  await x.events.get('agent_start')({},x.ctx);
  const before=structuredClone(x.entries.at(-1).data);
  const savedEntries=x.entries.length;
  const aborted={last_assistant_message:{role:'assistant',content:[],stopReason:'aborted'}};
  for (let i=0;i<2;i++) {
    assert.equal(await x.events.get('session_stop')(aborted,x.ctx),undefined);
    assert.deepEqual(x.entries.at(-1).data,before);
    assert.equal(x.entries.length,savedEntries);
  }
  const legacySuccess=await x.events.get('session_stop')({},x.ctx);
  assert.equal(legacySuccess.continue,true);
  assert.match(legacySuccess.additionalContext,/POST-EXECUTION QA REVIEW/);
  assert.equal(x.entries.at(-1).data.phase,'QA');
});

test('approved execution stop enters QA; status waits only for the reviewer', async () => {
  const x=setup(); await advanceToReview(x);
  await approvePlan(x);
  await x.events.get('agent_start')({},x.ctx);
  const qa=await x.events.get('session_stop')({},x.ctx);
  assert.equal(qa.continue,true);
  assert.equal(x.entries.at(-1).data.phase,'QA');
  assert.ok(!x.notifications.some(n=>/forge-executor|Forge halted/.test(n.message)));
  const savedEntries=x.entries.length;
  await x.commands.get('forge').handler('status',x.ctx);
  assert.match(x.notifications.at(-1).message,/waiting agents: forge-code-reviewer/);
  assert.equal(x.entries.length,savedEntries,'status formatting must not write workflow state');
});

test('each gate switches the main-session model before its turn and keeps thinking level', async () => {
  const MODELS = {'@plan':{provider:'anthropic',id:'opus'}, '@default':{provider:'openai',id:'gpt'}, '@slow':{provider:'x',id:'slow'}};
  const x=setup();
  x.ctx.models = { resolve: s => MODELS[s], current: () => x.getModel() };
  x.setModel(MODELS['@default']); x.setThinking('high');
  try {
    await x.commands.get('forge').handler('model qa @slow',x.ctx);
    assert.match(readFileSync(process.env.FORGE_CONFIG_PATH,'utf8'),/"qa": "@slow"/);
    await advanceToReview(x);
    const first = x.log.findIndex(e=>e[0]==='setModel');
    assert.deepEqual(x.log[first],['setModel','anthropic/opus']);
    assert.deepEqual(x.log[first+1],['thinking','high']);
    assert.ok(first < x.log.findIndex(e=>e[0]==='send'),'planning model is set before the planning turn');
    // A manual /model pick inside the gate is respected.
    x.setModel({provider:'manual',id:'m'});
    const before = x.log.filter(e=>e[0]==='setModel').length;
    await x.events.get('agent_end')({},x.ctx);
    assert.equal(x.log.filter(e=>e[0]==='setModel').length,before);
    const mark = x.log.length;
    await approvePlan(x);
    const exec = x.log.slice(mark);
    const execSwitch = exec.findIndex(e=>e[0]==='setModel');
    assert.deepEqual(exec[execSwitch],['setModel','openai/gpt']);
    const execSend = exec.findIndex(e=>e[0]==='send');
    assert.ok(execSwitch < execSend);
    assert.match(exec[execSend][1],/FORGE PLAN APPROVED/);
    await x.events.get('agent_start')({},x.ctx);
    const qa=await x.events.get('session_stop')({},x.ctx);
    assert.equal(qa.continue,true);
    assert.deepEqual(x.log.filter(e=>e[0]==='setModel').at(-1),['setModel','x/slow']);
    const cfgBefore = readFileSync(process.env.FORGE_CONFIG_PATH,'utf8');
    await x.commands.get('forge').handler('model qa anthropic/nope',x.ctx);
    assert.equal(x.notifications.at(-1).level,'error');
    assert.equal(readFileSync(process.env.FORGE_CONFIG_PATH,'utf8'),cfgBefore);
  } finally {
    await x.commands.get('forge').handler('model reset',x.ctx);
  }
  assert.match(readFileSync(process.env.FORGE_CONFIG_PATH,'utf8'),/"qa": "@default"/);
});

test('provider failures after implementation and during QA never synthesize transitions or reports', async () => {
  const x=setup(); await advanceToReview(x);
  await approvePlan(x);
  await x.events.get('agent_start')({},x.ctx);
  const providerFailure={last_assistant_message:{role:'assistant',content:[],stopReason:'error',errorStatus:429}};
  const savedEntries=x.entries.length, sentMessages=x.sent.length;
  assert.equal(await x.events.get('session_stop')(providerFailure,x.ctx),undefined);
  assert.equal(x.entries.at(-1).data.phase,'EXECUTE');
  assert.equal(x.entries.length,savedEntries);
  assert.equal(x.sent.length,sentMessages);
  const successful=await x.events.get('session_stop')({last_assistant_message:{role:'assistant',content:[],stopReason:'stop'}},x.ctx);
  assert.equal(successful.continue,true);
  assert.equal(x.entries.at(-1).data.phase,'QA');
  const qaBefore=structuredClone(x.entries.at(-1).data);
  const qaEntries=x.entries.length, qaMessages=x.sent.length;
  for (let i=0;i<2;i++) {
    assert.equal(await x.events.get('session_stop')(providerFailure,x.ctx),undefined);
    const state=x.entries.at(-1).data;
    assert.equal(state.phase,'QA');
    assert.equal(state.qaRetries,qaBefore.qaRetries);
    assert.equal(state.qaStatus,qaBefore.qaStatus);
    assert.equal(state.qaReportPath,qaBefore.qaReportPath);
    assert.equal(x.entries.length,qaEntries);
    assert.equal(x.sent.length,qaMessages);
  }
});

test('approved blocked checkpoint enters read-only independent QA without replaying execution', async () => {
  const x=setup(); const footer=[];
  x.ctx.ui.setStatus=(key,value)=>footer.push({key,value});
  const blocked=await reachInactiveExecution(x);
  const approvedHash=blocked.approvedPlanHash, planPath=blocked.planPath;
  const completions=structuredClone(blocked.agentCompletions);
  const savedEntries=x.entries.length;
  await runCompletedAgent(x,'scout'); // inactive workflow ignores this late task result
  assert.equal(x.entries.length,savedEntries);
  assert.deepEqual(x.entries.at(-1).data.agentCompletions,completions);
  const sentMessages=x.sent.length;
  await x.commands.get('forge').handler('qa',x.ctx);
  const review=x.entries.at(-1).data;
  assert.equal(review.phase,'QA');
  assert.equal(review.active,true);
  assert.equal(review.approved,true);
  assert.equal(review.approvedPlanHash,approvedHash);
  assert.equal(review.planPath,planPath);
  assert.deepEqual(review.gateAgents.QA,[]);
  assert.deepEqual(review.agentCompletions,completions);
  assert.equal(x.sent.length,sentMessages+1);
  assert.match(x.sent.at(-1).content,/POST-EXECUTION QA REVIEW/);
  assert.doesNotMatch(x.sent.at(-1).content,/GATE 3\/5: EXECUTION/);
  assert.match(footer.at(-1).value,/QA review 3\/3/);
  assert.equal((await x.events.get('tool_call')({toolName:'edit',input:{path:'src/app.go'}},x.ctx)).block,true);
  const premature=await x.tools.get('forge_qa_submit').execute('call',SUBMISSION,null,null,x.ctx);
  assert.equal(premature.isError,true);
  assert.match(premature.content[0].text,/Independent reviewer forge-code-reviewer must run/);
  await runQaAgents(x);
  const result=await x.tools.get('forge_qa_submit').execute('call',SUBMISSION,null,null,x.ctx);
  assert.match(result.content[0].text,/GATE: PASS/);
  assert.equal(x.entries.at(-1).data.phase,'QA');
});

test('blocked QA requires current valid approval and never restores approval on an empty branch', async () => {
  const x=setup(); const blocked=structuredClone(await reachInactiveExecution(x));
  const invalidStates=[
    {...blocked,approved:false},
    {...blocked,planValid:false},
    {...blocked,approvedPlanHash:''},
    {...blocked,approvedPlanHash:17},
    (()=>{const state={...blocked}; delete state.approvedPlanHash; return state;})(),
  ];
  for (const state of invalidStates) {
    x.entries.push({type:'custom',customType:'dev.omp-forge.workflow.v1',data:state});
    await x.events.get('session_start')({},x.ctx);
    const savedEntries=x.entries.length, sentMessages=x.sent.length;
    await x.commands.get('forge').handler('qa',x.ctx);
    assert.equal(x.entries.length,savedEntries);
    assert.equal(x.sent.length,sentMessages);
    assert.match(x.notifications.at(-1).message,/No approved execution is available for QA/);
  }
  const empty=setup();
  await empty.events.get('session_start')({},empty.ctx);
  await empty.commands.get('forge').handler('qa',empty.ctx);
  assert.equal(empty.entries.length,0);
  assert.equal(empty.sent.length,0);
  assert.match(empty.notifications.at(-1).message,/No approved execution is available for QA/);
});

test('global chain runs planning and after Forge approval starts execution then QA', async () => {
  const x=setup();
  await advanceToReview(x);
  await approvePlan(x);
  assert.equal(x.entries.at(-1).data.phase,'EXECUTE');
  assert.equal(x.entries.at(-1).data.active,true);
  assert.equal(await x.events.get('session_stop')({},x.ctx),undefined,'not yet observed execution');
  await x.events.get('agent_start')({},x.ctx);
  const qa=await x.events.get('session_stop')({},x.ctx);
  assert.equal(qa.continue,true);
  assert.match(qa.additionalContext,/POST-EXECUTION QA REVIEW/);
  assert.match(qa.additionalContext,/BIZ-002: Approval/);
  assert.equal(x.entries.at(-1).data.phase,'QA');
  assert.equal((await x.events.get('tool_call')({toolName:'write',input:{path:'src/service.ts'}},x.ctx)).block,true);
  assert.equal((await x.events.get('tool_call')({toolName:'bash',input:{command:'rm -rf .'}},x.ctx)).block,true);
  assert.equal(await x.events.get('tool_call')({toolName:'bash',input:{command:'npm run lint'}},x.ctx),undefined);
  await runQaAgents(x);
  const result=await x.tools.get('forge_qa_submit').execute('call',SUBMISSION,null,null,x.ctx);
  assert.match(result.content[0].text,/GATE: PASS/);
  assert.equal(x.entries.at(-1).data.phase,'QA');
  assert.equal(x.entries.at(-1).data.qaStatus,'PASS');
  assert.equal(x.entries.at(-1).data.active,true);
  assert.ok(existsSync(x.entries.at(-1).data.qaReportPath));
  assert.match(readFileSync(x.entries.at(-1).data.qaReportPath,'utf8'),/BIZ-001 — Booking/);
  await x.commands.get('forge').handler('report',x.ctx);
  assert.ok(x.notifications.at(-1).message.includes('qa-report.md'));
});

test('QA submits a grouped FAIL report and does not auto-fix', async () => {
  const x=setup(); await advanceToReview(x);
  await approvePlan(x);
  await x.events.get('agent_start')({},x.ctx);
  await x.events.get('session_stop')({},x.ctx);
  const submission=structuredClone(SUBMISSION);
  submission.topicResults[1].tests[0].status='FAIL';
  submission.topicResults[1].tests[0].actual='Rejected';
  await runQaAgents(x);
  const result=await x.tools.get('forge_qa_submit').execute('call',submission,null,null,x.ctx);
  assert.match(result.content[0].text,/GATE: FAIL/);
  assert.match(result.content[0].text,/BIZ-002 Approval \/ TC-002/);
  assert.equal(x.entries.at(-1).data.qaStatus,'FAIL');
  assert.equal(x.entries.at(-1).data.active,true);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  assert.equal(x.entries.at(-1).data.approved,false);
});

test('missing QA submission fails closed instead of claiming PASS', async () => {
  const x=setup(); await advanceToReview(x);
  await approvePlan(x);
  await x.events.get('agent_start')({},x.ctx);
  await x.events.get('session_stop')({},x.ctx);
  const retry=await x.events.get('session_stop')({},x.ctx);
  assert.equal(retry.continue,true);
  await x.events.get('session_stop')({},x.ctx);
  assert.equal(x.entries.at(-1).data.qaStatus,'BLOCKED');
  assert.equal(x.entries.at(-1).data.phase,'QA');
  assert.equal(x.entries.at(-1).data.active,true);
  assert.equal(x.entries.at(-1).data.approved,true, 'approval must be retained for evidence-only blockers');
  assert.ok(x.entries.at(-1).data.approvedPlanHash);
});

test('dismissed plan review does not authorize execution', async () => {
  const x=setup(); await advanceToReview(x);
  await approvePlan(x,'Not now — keep plan for /forge review');
  assert.equal(x.entries.at(-1).data.approved,false);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
});

test('Forge PLAN is read-only except the plan file; research tools and scout tasks run without skill injection', async () => {
  const x=setup();
  await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Create a CRM',x.ctx);
  const hook=x.events.get('tool_call');
  assert.equal((await hook({toolName:'bash',input:{command:'echo test'}},x.ctx)).block,true);
  assert.equal((await hook({toolName:'write',input:{path:'src/app.ts'}},x.ctx)).block,true);
  assert.equal((await hook({toolName:'write',input:{path:'local://forge-plan.md'}},x.ctx)).block,true);
  assert.equal((await hook({toolName:'write',input:{path:'xd://propose'}},x.ctx)).block,true);
  for (const tool of ['read','grep','glob','ask','web_search']) assert.equal(await hook({toolName:tool,input:{}},x.ctx),undefined,tool);
  const task = await hook({toolName:'task',input:{agent:'scout',task:'Analyze'}},x.ctx);
  assert.notEqual(task?.block,true);
  assert.doesNotMatch(task?.input?.task ?? '',/Skill:/);
});

test('input with forge: prefix enters Forge without native Plan Mode or slash command', async () => {
  const x=setup();
  await x.events.get('session_start')({},x.ctx);
  const result=await x.events.get('input')({source:'interactive',text:'forge: Build a booking system'},x.ctx);
  assert.equal(x.getPlan(),'inactive');
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  assert.match(result.text,/Build a booking system/);
  assert.equal(x.sent.length,0);
});


test('after QA PASS, the main agent submits delivery without any delivery agent or Git writes', async () => {
  const x = setup(); await advanceToReview(x);
  await approvePlan(x);
  await x.events.get('agent_start')({},x.ctx);
  await x.events.get('session_stop')({},x.ctx);
  await runQaAgents(x);
  await x.tools.get('forge_qa_submit').execute('call',SUBMISSION,null,null,x.ctx);
  const next = await x.events.get('session_stop')({},x.ctx);
  assert.equal(next.continue,true);
  assert.match(next.additionalContext,/DELIVERY PREPARATION — QA PASSED/);
  assert.equal((await x.events.get('before_subagent_spawn')({},x.ctx)).block,true);
  for (const command of ['git commit -m "oops"','git -C /repo push origin main','gh pr create --fill','git add .','bash -c "git commit -am x"']) {
    assert.equal((await x.events.get('tool_call')({toolName:'bash',input:{command}},x.ctx)).block,true,command);
  }
  assert.equal(await x.events.get('tool_call')({toolName:'bash',input:{command:'git diff --stat'}},x.ctx),undefined);
  const delivery = await x.tools.get('forge_delivery_submit').execute('call',{
    subject:'feat(booking): add approval workflow',
    body:'- Implement booking approvals\n- Cover overlapping reservations',
    highlights:['Approval workflow completed'],changedFiles:['src/booking.ts'],
  },null,null,x.ctx);
  assert.match(delivery.content[0].text,/COPY THIS COMMIT MESSAGE/);
  assert.match(delivery.content[0].text,/feat\(booking\): add approval workflow/);
  assert.equal(x.entries.at(-1).data.phase,'QA');
  assert.equal(x.entries.at(-1).data.active,false);
  assert.equal(readFileSync(x.entries.at(-1).data.commitMessagePath,'utf8'),'feat(booking): add approval workflow\n\n- Implement booking approvals\n- Cover overlapping reservations\n');
  assert.match(readFileSync(x.entries.at(-1).data.deliveryPath,'utf8'),/QA PASS — READY FOR MANUAL COMMIT/);
  assert.equal((await x.events.get('tool_call')({toolName:'bash',input:{command:'git commit -m x'}},x.ctx)).block,true,'still blocks agent commit after delivery');
  await x.commands.get('forge').handler('delivery',x.ctx);
  assert.match(x.notifications.at(-1).message,/commit-message.txt/);
});

test('QA failure stays in Forge PLAN and reopens Forge review after the rework proposal', async () => {
  const x=setup(); await advanceToReview(x);
  await approvePlan(x);
  await x.events.get('agent_start')({},x.ctx);
  await x.events.get('session_stop')({},x.ctx);
  const fail=structuredClone(SUBMISSION);
  fail.topicResults[0].tests[0].status='FAIL';fail.topicResults[0].tests[0].actual='Duplicate booking created';
  await runQaAgents(x);
  const failed=await x.tools.get('forge_qa_submit').execute('call',fail,null,null,x.ctx);
  assert.match(failed.content[0].text,/GATE: FAIL[\s\S]*WAITING FOR THE USER/);
  assert.doesNotMatch(failed.content[0].text,/QA FAILED: REWORK PLAN/,'no fix plan before the user decides');
  const table=x.shown.at(-1).message;
  assert.equal(table.customType,'forge-qa-summary');
  assert.match(table.content,/### Forge QA ❌ FAIL[\s\S]*\| ❌ \| TC-001 \| BIZ-001 Booking \| Create booking \| Duplicate booking created \|/);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  assert.equal(x.entries.at(-1).data.approved,false);
  assert.equal(x.entries.at(-1).data.reworkCycles,1);
  assert.equal(x.entries.at(-1).data.reworkDecisionPending,true);
  assert.equal((await x.events.get('tool_call')({toolName:'edit',input:{path:'src/booking.ts'}},x.ctx)).block,true);
  const pendingWrite=await x.events.get('tool_call')({toolName:'write',input:{path:`local://${x.entries.at(-1).data.slug}-rework-1-plan.md`,content:PLAN}},x.ctx);
  assert.match(pendingWrite.reason,/waiting for the user's decision/);

  // The QA turn ends: Forge asks the user before any fix is planned.
  const decisionTimers=[];
  x.ctx.setTimeout=callback=>decisionTimers.push(callback);
  assert.equal(await x.events.get('session_stop')({},x.ctx),undefined);
  assert.equal(decisionTimers.length,1);
  x.ctx.ui.select=async(title,options)=>{
    assert.match(title,/QA FAILED — plan a fix\?/);
    assert.deepEqual(options,['Plan the fix — draft a rework plan, then approve it','Not now — keep the QA report (/forge review to decide later)']);
    return options[0];
  };
  await decisionTimers[0]();
  assert.equal(x.entries.at(-1).data.reworkDecisionPending,false);
  assert.match(x.sent.at(-1).content,/APPROVED BY THE OPERATOR[\s\S]*QA FAILED: REWORK PLAN[\s\S]*Forge PLAN owns rework drafting/);

  const reminder=await x.events.get('session_stop')({},x.ctx);
  assert.equal(reminder.continue,true,'Forge keeps rework in its own PLAN without native Plan Mode');
  assert.match(reminder.additionalContext,/turn ended without a required tool call/);
  assert.equal(x.getPlan(),'inactive');
  const reworkState = x.entries.at(-1).data;
  const originalPlanPath = reworkState.reworkBasePlanPath;
  const reworkPath = `local://${reworkState.slug}-rework-${reworkState.reworkCycles}-plan.md`;
  const reworkPlan = PLAN+'\n## QA Rework Changes\n- Fix duplicate booking.\n';
  assert.notEqual(reworkPath, originalPlanPath);
  assert.equal((await x.events.get('tool_call')({
    toolName:'write', input:{path:originalPlanPath,content:PLAN},
  },x.ctx)).block,true,'the approved base plan must remain read-only');

  await writeCanonicalPlan(x,reworkPath,reworkPlan);
  const proposed=await proposePlan(x);
  assert.notEqual(proposed.isError,true,proposed.content[0].text);
  assert.equal(x.entries.at(-1).data.planPath,reworkPath);
  assert.equal(x.entries.at(-1).data.reviewRequested,true);
  const timers=[];
  x.ctx.isIdle=()=>true;
  x.ctx.setTimeout=callback=>timers.push(callback);
  assert.equal(await x.events.get('session_stop')({},x.ctx),undefined);
  assert.equal(timers.length,1);
  x.ctx.ui.select=async(_title,options)=>{ assert.ok(options.includes('Refine plan')); return 'Refine plan'; };
  x.ctx.ui.editor=async()=>'Fix duplicate booking';
  await timers.shift()();
  let state=x.entries.at(-1).data;
  assert.equal(state.phase,'PLAN');
  assert.equal(state.approved,false,'refine is not approval');
  assert.equal(state.planWritten,false);
  assert.equal(state.planValid,false);
  assert.match(x.sent.at(-1).content,/FORGE PLAN REFINE[\s\S]*Fix duplicate booking/);
  assert.equal(x.getPlan(),'inactive');
  delete x.ctx.ui.editor;
  x.ctx.setTimeout=()=>{};
  await writeCanonicalPlan(x,reworkPath,reworkPlan+'- Reject overlapping bookings.\n');
  const again=await proposePlan(x);
  assert.notEqual(again.isError,true,again.content[0].text);
  await approvePlan(x);
  state=x.entries.at(-1).data;
  assert.equal(state.phase,'EXECUTE');
  assert.equal(state.approved,true);
  assert.equal(state.reworkCycles,1);
});

/** Type a prompt while Forge runs and answer the steering popup ('steer' or 'cancel'). */
async function typePrompt(x, text, pick = 'steer') {
  const asked = {};
  x.ctx.ui.select = async (title, options) => {
    Object.assign(asked, {title, options});
    return pick === 'steer' ? options.find(o=>o.startsWith('Steer · ')) : options.find(o=>o.startsWith('Cancel · '));
  };
  try { return {result: await x.events.get('input')({source:'interactive',text},x.ctx), asked}; }
  finally { delete x.ctx.ui.select; }
}

test('a prompt typed during QA asks first, then steers: approval revoked, rework planned, no QA report fabricated', async () => {
  const x=setup(); await advanceToReview(x);
  await approvePlan(x);
  await x.events.get('agent_start')({},x.ctx);
  await x.events.get('session_stop')({},x.ctx);
  const approved=x.entries.at(-1).data;
  assert.equal(approved.phase,'QA');
  const qaTask='qa-in-flight';
  await x.events.get('tool_call')({toolName:'task',toolCallId:qaTask,input:{agent:'forge-code-reviewer',task:'Verify'}},x.ctx);
  await x.events.get('before_subagent_spawn')({agent:'forge-code-reviewer'},x.ctx);

  assert.equal(await x.events.get('input')({source:'interactive',text:'/forge status'},x.ctx),undefined,'slash commands are not steering');
  const {result,asked}=await typePrompt(x,'Also export bookings as CSV');
  assert.equal(asked.title,'Forge steering · prompt "Also export bookings as CSV" from user');
  assert.deepEqual(asked.options,['Steer · QA → PLAN · revokes approval, re-plan and approve again','Cancel · keep working on QA']);
  assert.match(result.text,/\[FORGE STEERING — PROMPT FROM USER\]/);
  assert.match(result.text,/Steering status: #1 · QA → PLAN\. Approval of the running plan is revoked/);
  assert.match(result.text,/USER STEERING: REWORK PLAN, NEW APPROVAL REQUIRED/);
  assert.match(result.text,/DELTA RUN: read the previous approved plan and change only the sections the steering changes/);
  assert.equal(result.text.split('Also export bookings as CSV').length-1,1,'the prompt is sent once, inside the steering list');
  assert.match(result.text,/1\. \[during QA\] Also export bookings as CSV/);
  assert.doesNotMatch(result.text,/QA FAILED/);
  assert.match(x.notifications.at(-1).message,/^Forge steering #1 · QA → PLAN · approval revoked.*prompt "Also export bookings as CSV" from user$/);

  const state=x.entries.at(-1).data;
  assert.equal(state.phase,'PLAN');
  assert.equal(state.approved,false);
  assert.equal(state.approvedPlanHash,null);
  assert.equal(state.qaStatus,null);
  assert.equal(state.qaReportPath,null,'no QA report is written for a user steering prompt');
  assert.equal(state.reworkReason,'STEERING');
  assert.equal(state.reworkBaseHash,approved.approvedPlanHash);
  assert.equal(state.reworkBasePlanPath,approved.planPath);
  assert.equal(state.reworkCycles,1);
  assert.deepEqual(state.requirementSteering.map(s=>[s.revision,s.phase,s.text]),[[1,'QA','Also export bookings as CSV']]);
  assert.equal((await x.events.get('tool_call')({toolName:'edit',input:{path:'src/booking.ts'}},x.ctx)).block,true);

  // The QA specialist dispatched before the steering cannot complete the new gate.
  await x.events.get('tool_result')({toolName:'task',toolCallId:qaTask,isError:false,content:[{type:'text',text:'late QA report'}]},x.ctx);
  assert.deepEqual(x.entries.at(-1).data.gateAgents.PLAN,[]);
  const next=await x.events.get('session_stop')({},x.ctx);
  assert.equal(next.continue,true);
  assert.match(next.additionalContext,/turn ended without a required tool call/);
  assert.ok(next.additionalContext.includes(`local://${state.slug}-rework-1-plan.md`));
  assert.equal(x.entries.at(-1).data.qaReportPath,null);

  const reworkPath=`local://${state.slug}-rework-1-plan.md`;
  await writeCanonicalPlan(x,reworkPath,PLAN+'\n## QA Rework Changes\n- Add CSV export.\n');
  const proposed=await proposePlan(x);
  assert.notEqual(proposed.isError,true,proposed.content[0].text);
  await approvePlan(x);
  assert.equal(x.entries.at(-1).data.phase,'EXECUTE');
  assert.equal(x.entries.at(-1).data.approved,true);
});

test('cancelling the steering popup changes nothing and returns the prompt to the editor', async () => {
  const x=setup(); await advanceToReview(x);
  await approvePlan(x);
  await x.events.get('agent_start')({},x.ctx);
  await x.events.get('session_stop')({},x.ctx);
  const before=structuredClone(x.entries.at(-1).data);
  const savedEntries=x.entries.length, sentMessages=x.sent.length;
  let editor=null, aborted=false;
  x.ctx.ui.setEditorText=t=>{ editor=t; };
  x.ctx.isIdle=()=>false;
  x.ctx.abort=async()=>{ aborted=true; };
  const {result}=await typePrompt(x,'Also export bookings as CSV','cancel');
  assert.deepEqual(result,{handled:true});
  assert.equal(editor,'Also export bookings as CSV');
  assert.equal(aborted,false,'cancel keeps the running QA turn');
  assert.deepEqual(x.entries.at(-1).data,before);
  assert.equal(x.entries.length,savedEntries);
  assert.equal(x.sent.length,sentMessages);
  assert.match(x.notifications.at(-1).message,/^Forge steering cancelled\. Forge continues QA; your prompt is back in the editor\.$/);
});

test('steering a busy execution turn aborts it and revokes the running helper write permission', async () => {
  const x=setup(); await advanceToReview(x);
  await approvePlan(x);
  await x.events.get('agent_start')({},x.ctx);
  const helper={...x.ctx,agent:{kind:'sub',name:'task'}};
  assert.equal(await x.events.get('tool_call')({toolName:'edit',input:{path:'src/a.ts'}},helper),undefined);
  let busy=true, aborts=0;
  x.ctx.isIdle=()=>!busy;
  x.ctx.abort=async()=>{ aborts++; busy=false; };
  const {result}=await typePrompt(x,'Use UUID ids instead of integers');
  assert.equal(aborts,1,'the obsolete execution turn stops instead of running to its end');
  assert.match(result.text,/Steering status: #1 · EXECUTE → PLAN\. Approval of the running plan is revoked/);
  assert.equal((await x.events.get('tool_call')({toolName:'edit',input:{path:'src/a.ts'}},helper)).block,true);
  assert.equal(x.entries.at(-1).data.reworkReason,'STEERING');
  const aborted={last_assistant_message:{role:'assistant',content:[],stopReason:'aborted'}};
  assert.equal(await x.events.get('session_stop')(aborted,x.ctx),undefined,'the aborted turn never nudges a gate');
});

test('a prompt typed during PLAN re-plans as PLAN → PLAN', async () => {
  const x=setup(); await reachPlanning(x,'Create a CRM');
  const {result,asked}=await typePrompt(x,'Only B2B customers, no consumers');
  assert.deepEqual(asked.options,['Steer · PLAN → PLAN · re-plan before approval','Cancel · keep working on PLAN']);
  assert.match(result.text,/Steering status: #1 · PLAN → PLAN\./);
  assert.match(result.text,/GATE 1\/3: PLAN — Forge plan mode[\s\S]*Create a CRM\n\nRequirement steering[\s\S]*\[during PLAN\] Only B2B customers, no consumers/);
  const state=x.entries.at(-1).data;
  assert.equal(state.phase,'PLAN');
  assert.equal(state.approved,false);
  assert.deepEqual(state.requirementSteering.map(s=>[s.phase,s.text]),[['PLAN','Only B2B customers, no consumers']]);
  assert.equal(x.notifications.some(n=>/prompt "Only B2B customers, no consumers" from user/.test(n.message)),true);
});

test('a prompt typed while a plan awaits review withdraws the proposal and re-plans as a delta', async () => {
  const x=setup(); await advanceToReview(x);
  const before=x.entries.at(-1).data;
  assert.equal(before.planValid,true);
  const {result,asked}=await typePrompt(x,'Drop the approval step');
  assert.deepEqual(asked.options,['Steer · PLAN → PLAN · re-plan before approval','Cancel · keep working on PLAN']);
  assert.match(result.text,/Steering status: #1 · PLAN → PLAN\. Any proposed plan is withdrawn/);
  assert.match(result.text,/GATE 1\/3: PLAN — Forge plan mode[\s\S]*\[during PLAN\] Drop the approval step/);
  assert.ok(result.text.includes(`DELTA RUN: an earlier draft exists at ${before.planPath}.`));
  const state=x.entries.at(-1).data;
  assert.equal(state.planWritten,false);
  assert.equal(state.planValid,false);
  assert.equal(state.approvedPlanHash,null);
  assert.equal(state.reworkBaseHash ?? null,null,'an unapproved proposal is not a rework base');
  assert.deepEqual(state.gateAgents.PLAN,[]);
  await x.commands.get('forge').handler('review',x.ctx);
  assert.equal(x.notifications.at(-1).message,'No proposed Forge plan awaits review.');
});

test('delivery cannot be prepared before QA PASS', async () => {
  const x=setup(); await advanceToReview(x);
  const result=await x.tools.get('forge_delivery_submit').execute('call',{subject:'feat: add booking',body:'',highlights:[],changedFiles:[]},null,null,x.ctx);
  assert.equal(result.isError,true);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
});

test('PLAN blocks forge-code-reviewer and task subagents but allows scout', async () => {
  const x=setup(); await reachPlanning(x,'Create a CRM');
  const spawn=agent=>x.events.get('before_subagent_spawn')({agent},x.ctx);
  const reviewer=await spawn('forge-code-reviewer');
  assert.equal(reviewer.block,true);
  assert.match(reviewer.reason,/forge-code-reviewer is not part of this gate[\s\S]*forge-code-reviewer runs in QA review/);
  const task=await spawn('task');
  assert.equal(task.block,true);
  assert.match(task.reason,/only read-only research agents \(scout\)/);
  assert.equal(await spawn('scout'),undefined);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
});

test('post-execution QA PASS is blocked if the independent reviewer did not run', async () => {
  const x=setup(); await advanceToReview(x);
  await approvePlan(x);
  await x.events.get('agent_start')({},x.ctx);
  await x.events.get('session_stop')({},x.ctx);
  const result=await x.tools.get('forge_qa_submit').execute('call',SUBMISSION,null,null,x.ctx);
  assert.equal(result.isError,true);
  assert.match(result.content[0].text,/Independent reviewer forge-code-reviewer must run/);
  assert.equal(x.entries.at(-1).data.phase,'QA');
});

test('wrong agent is rejected during read-only QA and delivery phases', async () => {
  const x=setup(); await advanceToReview(x);
  await approvePlan(x);
  await x.events.get('agent_start')({},x.ctx);
  await x.events.get('session_stop')({},x.ctx);
  assert.equal((await x.events.get('before_subagent_spawn')({agent:'forge-executor'},x.ctx)).block,true);
  await runCompletedAgent(x,'forge-code-reviewer');
  await x.tools.get('forge_qa_submit').execute('call',SUBMISSION,null,null,x.ctx);
  assert.equal((await x.events.get('before_subagent_spawn')({agent:'forge-code-reviewer'},x.ctx)).block,true);
  assert.equal((await x.events.get('before_subagent_spawn')({agent:'forge-delivery'},x.ctx)).block,true);
  assert.equal(await x.events.get('before_subagent_spawn')({agent:'scout'},x.ctx),undefined);
});

test('v5 a spawned reviewer without a task result cannot satisfy the QA gate', async () => {
  const x=setup(); await reachQa(x);
  await x.events.get('before_subagent_spawn')({agent:'forge-code-reviewer'},x.ctx);
  const result=await x.tools.get('forge_qa_submit').execute('call',SUBMISSION,null,null,x.ctx);
  assert.equal(result.isError,true);
  assert.equal(x.entries.at(-1).data.phase,'QA');
  assert.deepEqual(x.entries.at(-1).data.gateAgents.QA ?? [],[]);
});

test('v5 failed reviewer task result cannot satisfy the QA gate', async () => {
  const x=setup(); await reachQa(x);
  await x.events.get('tool_call')({toolName:'task',toolCallId:'broken1',input:{agent:'forge-code-reviewer'}},x.ctx);
  await x.events.get('before_subagent_spawn')({agent:'forge-code-reviewer'},x.ctx);
  await x.events.get('tool_result')({toolName:'task',toolCallId:'broken1',isError:true,content:[{type:'text',text:'Failed'}]},x.ctx);
  assert.deepEqual(x.entries.at(-1).data.gateAgents.QA ?? [],[]);
  const result=await x.tools.get('forge_qa_submit').execute('call',SUBMISSION,null,null,x.ctx);
  assert.equal(result.isError,true);
  assert.match(result.content[0].text,/Independent reviewer forge-code-reviewer must run/);
});

test('an invalid Forge plan contract cannot reach the approval dialog', async () => {
  const x=setup(); await reachPlanning(x);
  await writeCanonicalPlan(x,null,'# Plan\nNo test cases');
  const result=await proposePlan(x);
  assert.equal(result.isError,true);
  assert.match(result.content[0].text,/Missing ## Business Topics/);
  assert.equal(x.entries.at(-1).data.planValid,false);
  await x.commands.get('forge').handler('review',x.ctx);
  assert.equal(x.notifications.at(-1).message,'No proposed Forge plan awaits review.');
  assert.equal(x.entries.at(-1).data.approved,false);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
});

test('v5 disallows Git writes in a Forge subagent session', async () => {
  const x=setup();
  const sub={...x.ctx,agent:{kind:'sub',name:'forge-code-reviewer'}};
  const forbidden=await x.events.get('tool_call')({toolName:'bash',input:{command:'git commit -m done'}},sub);
  assert.equal(forbidden.block,true);
  assert.equal((await x.events.get('tool_call')({toolName:'write',input:{path:'src/x.ts'}},sub)).block,true);
});


test('v5.1: read-only Rework permits agents but never source code changes', async () => {
  const x=setup(); await advanceToReview(x);
  await approvePlan(x);
  await x.events.get('agent_start')({},x.ctx);
  await x.events.get('session_stop')({},x.ctx);
  const fail=structuredClone(SUBMISSION); fail.topicResults[0].tests[0].status='FAIL';
  await runQaAgents(x);
  await x.tools.get('forge_qa_submit').execute('call',fail,null,null,x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  for (const tool of ['read','grep','glob','ask']) assert.equal(await x.events.get('tool_call')({toolName:tool,input:{}},x.ctx),undefined);
  assert.equal((await x.events.get('tool_call')({toolName:'edit',input:{path:'src/change.ts'}},x.ctx)).block,true);
});


test('v5.1: QA prevents arbitrary shell and exec aliases, not just bash', async () => {
  const x=setup(); await advanceToReview(x);
  await approvePlan(x);
  await x.events.get('agent_start')({},x.ctx);
  await x.events.get('session_stop')({},x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'QA');
  for (const tool of ['bash','shell','terminal','exec','run']) {
    assert.equal((await x.events.get('tool_call')({toolName:tool,input:{command:'rm -rf src'}},x.ctx)).block,true,tool);
    assert.equal(await x.events.get('tool_call')({toolName:tool,input:{command:'git diff --stat'}},x.ctx),undefined,tool);
  }
});

// Bare /forge prefills the main composer: only it delivers pasted images to extensions.
test('bare /forge prefills the composer with forge: and starts nothing', async () => {
  const x = setup();
  await x.events.get('session_start')({}, x.ctx);
  const prefills = [];
  x.ctx.ui.editor = async () => { throw new Error('dialog must not open'); };
  x.ctx.ui.setEditorText = t => prefills.push(t);
  await x.commands.get('forge').handler('', x.ctx);
  assert.deepEqual(prefills, ['forge: ']);
  assert.equal(x.entries.length, 0);
  assert.equal(x.sent.length, 0);
  assert.match(x.notifications.at(-1).message, /Shift\+Enter/);
  assert.match(x.notifications.at(-1).message, /image/i);
});

test('v5.2: direct /forge args and management commands do not open multiline editor', async () => {
  const x = setup();
  await x.events.get('session_start')({}, x.ctx);
  x.ctx.ui.editor = async () => { throw new Error('editor should not open'); };
  await x.commands.get('forge').handler('status', x.ctx);
  assert.equal(x.entries.length, 0);
  await x.commands.get('forge').handler('Create a CRM', x.ctx);
  assert.equal(x.entries.at(-1).data.requirement, 'Create a CRM');
});

test('bare /forge without setEditorText warns and starts nothing', async () => {
  const x = setup();
  await x.events.get('session_start')({}, x.ctx);
  await x.commands.get('forge').handler('', x.ctx);
  assert.equal(x.entries.length, 0);
  assert.match(x.notifications.at(-1).message, /cannot prefill the prompt/);
});

test('forge: input with pasted images saves them and lists their paths in the requirement', async () => {
  const x = setup(); await x.events.get('session_start')({}, x.ctx);
  const data = Buffer.from('fake-png-bytes').toString('base64');
  const result = await x.events.get('input')({source:'interactive', text:'forge: Build login\n\nMatch [Image #1]', images:[{type:'image', data, mimeType:'image/png'}]}, x.ctx);
  const state = x.entries.at(-1).data;
  const file = join(process.env.PI_CODING_AGENT_DIR, 'forge-attachments', state.slug, 'image-1.png');
  assert.equal(state.phase, 'PLAN');
  assert.equal(readFileSync(file, 'utf8'), 'fake-png-bytes');
  assert.ok(state.requirement.startsWith('Build login\n\nMatch [Image #1]'));
  assert.ok(state.requirement.includes(`- [Image #1] ${file}`));
  assert.ok(result.text.includes(file));
  assert.equal('images' in result, false); // attachments preserved on the instruction
  assert.equal(x.sent.length, 0);
});

test('legacy v5 COOKING state restores as PLAN without approval', async () => {
  const x = setup();
  const old = {
    ...initialOld(), phase: 'COOKING', approved: true, gateAgents: { DISCOVERY: ['forge-requirement'], COOKING: ['forge-requirement'] },
    gateAgentsSpawned: { COOKING: ['forge-requirement'] }, agentRetries: { COOKING: 1 },
  };
  x.entries.push({ type: 'custom', customType: 'dev.omp-forge.workflow.v1', data: old });
  await x.events.get('session_start')({}, x.ctx);
  await x.commands.get('forge').handler('status', x.ctx);
  assert.match(x.notifications.at(-1).message, /approved: no/);
  assert.match(x.notifications.at(-1).message, /Forge: PLAN/);
  assert.equal((await x.events.get('before_subagent_spawn')({agent:'forge-code-reviewer'}, x.ctx)).block, true);
  assert.equal((await x.events.get('before_subagent_spawn')({agent:'forge-critic'}, x.ctx)).block, true);
  await writeCanonicalPlan(x);
  assert.notEqual((await proposePlan(x)).isError, true);
  const state = x.entries.at(-1).data;
  assert.equal(state.phase, 'PLAN');
  assert.equal(state.approved, false);
  assert.equal('COOKING' in (state.gateAgents ?? {}), false);
});

test('legacy v6.0 state with requirementStep/mode restores as PLAN and drops requirement records', async () => {
  const x = setup();
  const old = {
    ...initialState('Legacy v6.0 requirement', 'legacy-v60'), phase: 'REQUIREMENT',
    gateSkills: {}, skillPins: {},
    requirementStep: 'CHALLENGE', requirementMode: 'fast',
    gateAgents: { 'REQUIREMENT:DISCOVERY': ['forge-requirement'], 'REQUIREMENT:COOKING': ['forge-requirement','forge-critic'] },
    agentRetries: { 'REQUIREMENT:COOKING': 1 },
  };
  x.entries.push({ type: 'custom', customType: 'dev.omp-forge.workflow.v1', data: old });
  await x.events.get('session_start')({}, x.ctx);
  await x.commands.get('forge').handler('status', x.ctx);
  assert.match(x.notifications.at(-1).message, /Forge: PLAN/);
  await writeCanonicalPlan(x);
  assert.notEqual((await proposePlan(x)).isError, true);
  const planned = x.entries.at(-1).data;
  assert.equal(planned.phase, 'PLAN');
  assert.deepEqual(Object.keys(planned.gateAgents ?? {}).filter(k => k.startsWith('REQUIREMENT')), []);
  assert.deepEqual(Object.keys(planned.agentRetries ?? {}).filter(k => k.startsWith('REQUIREMENT')), []);
});

function initialOld() {
  return {
    phase: 'DISCOVERY', active: true, slug: 'legacy-job', requirement: 'Legacy requirement',
    gateAgents: {}, agentRetries: {}, gateAgentsSpawned: {}, proposalRetries: 0,
  };
}

test('v5.4: a missing plan file cannot be proposed', async () => {
  const x=setup();await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Feature to analyze',x.ctx);
  const path=`local://${x.entries.at(-1).data.slug}-plan.md`;
  assert.equal(await x.events.get('tool_call')({toolName:'write',toolCallId:'write-failed',input:{path}},x.ctx),undefined);
  const result=await proposePlan(x);
  assert.equal(result.isError,true);
  assert.match(result.content[0].text,/does not exist yet/);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  assert.equal(x.entries.at(-1).data.planWritten,false);
  assert.equal((await x.events.get('tool_call')({toolName:'write',input:{path:'xd://propose'}},x.ctx)).block,true);
});

test('plan review shows Plan review status; execution restores 2/3 progress', async () => {
  const x=setup();
  const widgets=[];
  x.ctx.ui.setWidget=(id,lines,options)=>widgets.push({id,lines,options});
  await advanceToReview(x);
  assert.equal(widgets.at(-1).id,'forge-gates');
  assert.deepEqual(widgets.at(-1).lines,['FORGE  ▰▱▱  Plan review  1/3']);
  await approvePlan(x);
  const finalWidget=widgets.at(-1);
  assert.deepEqual(finalWidget.lines,['FORGE  ▰▰▱  Execution  2/3']);
  assert.equal(finalWidget.options.placement,'aboveEditor');
});

test('v5.6: planning sandbox exception remains narrow and source writes still blocked', async () => {
  const x=setup();
  await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Plan a feature',x.ctx);
  x.setPlan('paused');
  const blockedPaths=['src/main.go','.github/workflows/test.yml','local://notes.md','local://folder/other-plan.md','local://../bad-plan.md','local://plan.md','local://other-plan.md','xd://resolve','xd://reject','/tmp/forge-plan.md'];
  for (const path of blockedPaths) {
    const v=await x.events.get('tool_call')({toolName:'write',input:{path,content:'bad'}},x.ctx);
    assert.equal(v?.block,true,`blocked path: ${path}`);
  }
  assert.equal(await x.events.get('tool_call')({toolName:'write',input:{path:`local://${x.entries.at(-1).data.slug}-plan.md`,content:PLAN}},x.ctx),undefined);
  for (const command of ['git add .','git commit -m test','git push origin main','echo code > src/main.go']) {
    const v=await x.events.get('tool_call')({toolName:'bash',input:{command}},x.ctx);
    assert.equal(v?.block,true,`blocked command: ${command}`);
  }
});

test('v5.6: an unwritten plan file never advances to review', async () => {
  const x=setup();
  await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Plan a feature',x.ctx);
  const path=`local://${x.entries.at(-1).data.slug}-plan.md`;
  assert.equal(await x.events.get('tool_call')({toolName:'write',toolCallId:'bad-plan',input:{path,content:PLAN}},x.ctx),undefined);
  const result=await proposePlan(x);
  assert.equal(result.isError,true);
  assert.match(result.content[0].text,/does not exist yet/);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  assert.equal(x.entries.at(-1).data.planWritten,false);
  assert.equal((await x.events.get('tool_call')({toolName:'write',input:{path:'xd://propose'}},x.ctx)).block,true);
});

test('v5.6: QA FAIL clears previous plan-written and approval validity before rework', async () => {
  const x=setup(); await advanceToReview(x);
  await approvePlan(x);
  await x.events.get('agent_start')({},x.ctx);
  await x.events.get('session_stop')({},x.ctx);
  await runQaAgents(x);
  const submission=structuredClone(SUBMISSION);
  submission.topicResults[0].tests[0].status='FAIL';
  await x.tools.get('forge_qa_submit').execute('call',submission,null,null,x.ctx);
  const state=x.entries.at(-1).data;
  assert.equal(state.phase,'PLAN');
  assert.equal(state.planWritten,false);
  assert.equal(state.planValid,false);
  assert.equal(state.approvedPlanHash,null);
  assert.equal((await x.events.get('tool_call')({toolName:'write',input:{path:'xd://propose'}},x.ctx)).block,true);
});

// v5.7: Global Agent override commands and actual task routing.
test('v5.8 gate skill is installed, pinned and attached to specialist task in current gate', async () => {
  const skillRoot=join(process.env.PI_CODING_AGENT_DIR,'skills','security-review');
  mkdirSync(skillRoot,{recursive:true});
  const skillPath=join(skillRoot,'SKILL.md');
  writeFileSync(skillPath,'---\nname: security-review\ndescription: Review security risks\n---\nCheck access controls and request validation.\n');
  const x=setup();
  await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('skill add planning security-review',x.ctx);
  await x.commands.get('forge').handler('skills',x.ctx);
  assert.match(x.notifications.at(-1).message,/security-review/);
  await x.commands.get('forge').handler('Build payment API',x.ctx);
  const state=x.entries.at(-1).data;
  assert.ok(state.gateSkills.planning.includes('forge-plan-gate'));
  assert.ok(state.gateSkills.planning.includes('security-review'));
  assert.ok(state.skillPins['security-review'].sha256);
  assert.ok(x.sent.at(-1).content.startsWith('Load and follow the forge-plan-gate, security-review skills.'));
  const blocked=await x.events.get('tool_call')({toolName:'write',input:{path:'src/unsafe.ts'}},x.ctx);
  assert.equal(blocked.block,true);
});

test('v5.8 changed pinned skill blocks task rather than injecting stale instruction',async()=>{
  const skillRoot=join(process.env.PI_CODING_AGENT_DIR,'skills','go-testing');
  mkdirSync(skillRoot,{recursive:true});
  const path=join(skillRoot,'SKILL.md');
  writeFileSync(path,'---\ndescription: Go testing standards\n---\nRun go test.\n');
  const x=setup();
  await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('skill add qa go-testing',x.ctx);
  await x.commands.get('forge').handler('Create a CRM',x.ctx);
  assert.ok(x.entries.at(-1).data.gateSkills.qa.includes('forge-qa-gate'));
  assert.ok(x.entries.at(-1).data.gateSkills.qa.includes('go-testing'));
  writeFileSync(path,'---\ndescription: Go testing standards\n---\nRun go test race detector.\n');
  // Simulate QA state to inspect gate lock without advancing unrelated phases.
  const current=x.entries.at(-1).data;
  const altered={...current,phase:'QA',qaStatus:null};
  x.entries.push({type:'custom',customType:'dev.omp-forge.workflow.v1',data:altered});
  await x.events.get('session_start')({},x.ctx);
  const rejected=await x.events.get('tool_call')({toolName:'task',toolCallId:'skills-2',input:{agent:'forge-code-reviewer',task:'Verify tests'}},x.ctx);
  assert.equal(rejected.block,true);
  assert.match(rejected.reason,/changed or disappeared/);
});

test('v5.8 skill assignment cannot change during active workflow',async()=>{
  const x=setup(); await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Create a CRM',x.ctx);
  await x.commands.get('forge').handler('skill reset all',x.ctx);
  assert.match(x.notifications.at(-1).message,/pinned for this active workflow/);
});


test('skill create with explicit gate writes SKILL.md and attaches it without touching other settings', async () => {
  const x=setup();
  x.ctx.ui.editor=async () => '---\nname: pasted-qa\ndescription: QA instructions\n---\n# Tests\n- Test edge cases';
  await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('skill create qa',x.ctx);
  const file=join(process.env.PI_CODING_AGENT_DIR,'skills','pasted-qa','SKILL.md');
  assert.equal(existsSync(file),true);
  assert.match(readFileSync(file,'utf8'),/Test edge cases/);
  const cfg=JSON.parse(readFileSync(process.env.FORGE_CONFIG_PATH,'utf8'));
  assert.ok(cfg.gateSkills.qa.includes('pasted-qa'));
  assert.equal(cfg.autoStart,false);
  assert.match(x.notifications.at(-1).message,/Created pasted-qa/);
});

test('skill create menu chooses Gate and cancellation never creates files or assignments', async () => {
  const x=setup();
  x.ctx.ui.select=async (title, options) => options.includes('Create skill from Markdown') ? 'Create skill from Markdown' : options.includes('planning') ? 'planning' : null;
  x.ctx.ui.editor=async () => null;
  await x.events.get('session_start')({},x.ctx);
  const before=readFileSync(process.env.FORGE_CONFIG_PATH,'utf8');
  await x.commands.get('forge').handler('skill',x.ctx);
  assert.equal(readFileSync(process.env.FORGE_CONFIG_PATH,'utf8'),before);
  assert.equal(existsSync(join(process.env.PI_CODING_AGENT_DIR,'skills','cancelled-skill')),false);
  x.ctx.ui.editor=async () => '---\nname: created-from-menu\ndescription: From UI\n---\n# My Skill';
  await x.commands.get('forge').handler('skill',x.ctx);
  assert.ok(existsSync(join(process.env.PI_CODING_AGENT_DIR,'skills','created-from-menu','SKILL.md')));
  assert.ok(JSON.parse(readFileSync(process.env.FORGE_CONFIG_PATH,'utf8')).gateSkills.planning.includes('created-from-menu'));
});

test('skill create cannot overwrite existing directory or change config for invalid Markdown', async () => {
  const x=setup();
  await x.events.get('session_start')({},x.ctx);
  const existingDir=join(process.env.PI_CODING_AGENT_DIR,'skills','preexisting-skill');
  mkdirSync(existingDir,{recursive:true});
  writeFileSync(join(existingDir,'SKILL.md'),'original content unchanged');
  const before=readFileSync(process.env.FORGE_CONFIG_PATH,'utf8');
  x.ctx.ui.editor=async ()=>'---\nname: preexisting-skill\ndescription: Attempt overwrite\n---\n# Overwrite';
  await x.commands.get('forge').handler('skill create qa',x.ctx);
  assert.equal(readFileSync(join(existingDir,'SKILL.md'),'utf8'),'original content unchanged');
  assert.equal(readFileSync(process.env.FORGE_CONFIG_PATH,'utf8'),before);
  x.ctx.ui.editor=async ()=>'---\nname: ../../bad\ndescription: traversal\n---\n# Bad';
  await x.commands.get('forge').handler('skill create qa',x.ctx);
  assert.equal(readFileSync(process.env.FORGE_CONFIG_PATH,'utf8'),before);
  assert.ok(x.notifications.some(n=>/Skill not created/.test(n.message)));
});

test('skill create is blocked while an active Forge run exists',async()=>{
  const x=setup();
  await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Create a CRM',x.ctx);
  let editorCalled=false;
  x.ctx.ui.editor=async()=>{editorCalled=true;return '---\nname: forbidden-skill\ndescription: Not now\n---\n# Check';};
  await x.commands.get('forge').handler('skill create qa',x.ctx);
  assert.equal(editorCalled,false);
  assert.equal(existsSync(join(process.env.PI_CODING_AGENT_DIR,'skills','forbidden-skill')),false);
});


test('v5.12 old agent assignment command directs to native OMP without changing config', async () => {
  const x=setup();
  await x.events.get('session_start')({},x.ctx);
  const before=readFileSync(process.env.FORGE_CONFIG_PATH,'utf8');
  await x.commands.get('forge').handler('agent set planning my-planner',x.ctx);
  assert.match(x.notifications.at(-1).message,/OMP \/agents/);
  assert.equal(readFileSync(process.env.FORGE_CONFIG_PATH,'utf8'),before);
  await x.commands.get('forge').handler('agents',x.ctx);
  assert.match(x.notifications.at(-1).message,/forge-code-reviewer/);
  assert.match(x.notifications.at(-1).message,/found/);
});

test('v5.12 legacy config does not override gate routing for new workflows', async () => {
  const backup=readFileSync(process.env.FORGE_CONFIG_PATH,'utf8');
  try {
    writeFileSync(process.env.FORGE_CONFIG_PATH,JSON.stringify({autoStart:false,agentAssignments:{planning:{planner:'my-planner'}}}));
    const x=setup(); await x.events.get('session_start')({},x.ctx);
    await x.commands.get('forge').handler('Build a CRM',x.ctx);
    const state=x.entries.at(-1).data;
    assert.deepEqual(state.agentAssignments,{planning:{critic:'forge-plan-critic'},qa:{reviewer:'forge-code-reviewer'}});
    assert.deepEqual(requiredAgentsFor({...state,phase:'QA'}),['forge-code-reviewer']);
  } finally { writeFileSync(process.env.FORGE_CONFIG_PATH,backup); }
});

test('v5.12 missing mandatory Agent definition fails before starting workflow', async () => {
  const file=join(process.env.PI_CODING_AGENT_DIR,'agents','forge-code-reviewer.md');
  const original=readFileSync(file);
  try {
    rmSync(file);
    const x=setup(); await x.events.get('session_start')({},x.ctx);
    await x.commands.get('forge').handler('Build a CRM',x.ctx);
    assert.equal(x.entries.length,0);
    assert.match(x.notifications.at(-1).message,/missing required OMP agent definitions: forge-code-reviewer/);
  } finally { writeFileSync(file, original); }
});

test('v5.12 OMP model frontmatter is untouched and Forge executes fixed names', async () => {
  const file=join(process.env.PI_CODING_AGENT_DIR,'agents','forge-code-reviewer.md');
  const old=readFileSync(file);
  try {
    writeFileSync(file,'---\nname: forge-code-reviewer\ndescription: Code reviews\nmodel: "@review"\n---\nReview diffs\n');
    const x=setup(); await x.events.get('session_start')({},x.ctx);
    await x.commands.get('forge').handler('agents',x.ctx);
    assert.match(x.notifications.at(-1).message,/model @review/);
    await x.commands.get('forge').handler('Build a CRM',x.ctx);
    const state=x.entries.at(-1).data;
    assert.equal(state.agentAssignments.qa.reviewer,'forge-code-reviewer');
  } finally { writeFileSync(file,old); }
});

test('v5.18: QA BLOCKED keeps approved plan and pauses for evidence instead of automatic rework', async () => {
  const x = setup(); await advanceToReview(x);
  await approvePlan(x);
  await x.events.get('agent_start')({},x.ctx);
  await x.events.get('session_stop')({},x.ctx);
  await runQaAgents(x);
  const blocked = structuredClone(SUBMISSION);
  blocked.topicResults[0].tests[0].status='NOT_RUN';
  blocked.topicResults[0].tests[0].actual='No runtime evidence obtained';
  const expectedHash=x.entries.at(-1).data.approvedPlanHash;
  const res=await x.tools.get('forge_qa_submit').execute('call',blocked,null,null,x.ctx);
  assert.match(res.content[0].text,/GATE: BLOCKED/);
  const state=x.entries.at(-1).data;
  assert.equal(state.phase,'QA');
  assert.equal(state.approved,true);
  assert.equal(state.planValid,true);
  assert.equal(state.approvedPlanHash, expectedHash);
  assert.equal(state.reworkCycles,0);
  assert.equal(state.qaEvidencePending,true);
  assert.equal(await x.events.get('session_stop')({},x.ctx),undefined,'QA BLOCKED must not autostart planning');
  assert.equal((await x.events.get('tool_call')({toolName:'edit',input:{path:'src/main.go'}},x.ctx)).block,true);
  assert.equal(await x.events.get('tool_call')({toolName:'bash',input:{command:'git diff --name-only'}},x.ctx),undefined);
  assert.equal((await x.events.get('tool_call')({toolName:'bash',input:{command:'git commit -am x'}},x.ctx)).block,true);
});

test('v5.18: evidence-only QA retry preserves approval and rechecks specialists', async () => {
  const x=setup(); await advanceToReview(x);
  await approvePlan(x);
  await x.events.get('agent_start')({},x.ctx);
  await x.events.get('session_stop')({},x.ctx);
  await runQaAgents(x);
  const blocked=structuredClone(SUBMISSION); blocked.codeQualityChecks[0].status='NOT_RUN';
  await x.tools.get('forge_qa_submit').execute('call',blocked,null,null,x.ctx);
  const before=x.entries.at(-1).data.approvedPlanHash;
  await x.commands.get('forge').handler('resume current',x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'QA','resume alone must not replay writes or approval');
  await x.commands.get('forge').handler('qa',x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'QA');
  assert.equal(x.entries.at(-1).data.approvedPlanHash,before);
  assert.deepEqual(x.entries.at(-1).data.gateAgents.QA, []);
  assert.match(x.sent.at(-1).content,/forge_qa_scope/);
  await runQaAgents(x);
  const result=await x.tools.get('forge_qa_submit').execute('call',SUBMISSION,null,null,x.ctx);
  assert.match(result.content[0].text,/GATE: PASS/);
  assert.equal(x.entries.at(-1).data.phase,'QA');
});

test('v5.18: scope read is unavailable before approved QA and gracefully handles non-repo',async()=>{
  const x=setup(); await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Build a booking flow',x.ctx);
  const before=await x.tools.get('forge_qa_scope').execute('call',{},null,null,x.ctx);
  assert.equal(before.isError,true);
  await advanceToReview(x);
  await approvePlan(x);
  await x.events.get('agent_start')({},x.ctx);
  await x.events.get('session_stop')({},x.ctx);
  x.ctx.cwd=tmp; // tmp is not a git repo
  const during=await x.tools.get('forge_qa_scope').execute('call',{},null,null,x.ctx);
  assert.equal(during.isError,undefined);
  assert.equal(during.details.available,false);
  assert.match(during.details.reason,/Git status\/diff inventory unavailable/);
});

test('explicit rework from QA BLOCKED stays in Forge PLAN without native mode',async()=>{
  const x=setup(); await advanceToReview(x);
  await approvePlan(x);
  await x.events.get('agent_start')({},x.ctx);
  await x.events.get('session_stop')({},x.ctx);
  await runQaAgents(x);
  const blocked=structuredClone(SUBMISSION); blocked.codeQualityChecks[0].status='NOT_RUN';
  await x.tools.get('forge_qa_submit').execute('call',blocked,null,null,x.ctx);
  const modeRequests=[];
  x.ctx.sessionModes.set=async (...args)=>{ modeRequests.push(args); return {ok:false,message:'session is busy'}; };
  await x.commands.get('forge').handler('rework',x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  assert.equal(x.entries.at(-1).data.approved,false);
  assert.equal(x.entries.at(-1).data.reworkCycles,1);
  assert.equal(modeRequests.length,0,'rework does not ask native Plan Mode to start');
  assert.equal(x.getPlan(),'inactive');
  assert.match(x.sent.at(-1).content,/QA FAILED: REWORK PLAN/);
});

test('v5.18: forge_qa_scope provides actual untracked files without executing repo code', async () => {
  const { execFileSync } = await import('node:child_process');
  const repo = mkdtempSync(join(tmp, 'qa-scope-git-'));
  const git = (...args) => execFileSync('git', args, {cwd:repo,stdio:['ignore','pipe','pipe']});
  git('init','-q');
  git('config','user.email','test@example.invalid');
  git('config','user.name','Forge test');
  writeFileSync(join(repo,'tracked.md'),'baseline\n');
  git('add','tracked.md'); git('commit','-qm','baseline');
  writeFileSync(join(repo,'tracked.md'),'changed\n');
  writeFileSync(join(repo,'new.md'),'new document\n');
  const x=setup(); await advanceToReview(x);
  await approvePlan(x);
  await x.events.get('agent_start')({},x.ctx);
  await x.events.get('session_stop')({},x.ctx);
  x.ctx.cwd=repo;
  const out=await x.tools.get('forge_qa_scope').execute('call',{},null,null,x.ctx);
  assert.equal(out.details.available,true);
  assert.equal(out.details.hasCurrentDiff,true);
  assert.ok(out.details.files.includes('tracked.md'));
  assert.ok(out.details.files.includes('new.md'));
  assert.equal(git('status','--porcelain').toString().includes('new.md'),true,'untracked file must remain untracked');
  rmSync(repo,{recursive:true,force:true});
});

test('v5.18: clean working tree has a specific evidence warning, not automatic QA PASS',async()=>{
  const { execFileSync } = await import('node:child_process');
  const repo=mkdtempSync(join(tmp,'qa-scope-clean-'));
  const git=(...args)=>execFileSync('git',args,{cwd:repo,stdio:['ignore','pipe','pipe']});
  git('init','-q'); git('config','user.email','test@example.invalid'); git('config','user.name','Forge test');
  writeFileSync(join(repo,'doc.md'),'already present\n'); git('add','doc.md'); git('commit','-qm','existing requirement');
  const x=setup(); await advanceToReview(x);
  await approvePlan(x);
  await x.events.get('agent_start')({},x.ctx);
  await x.events.get('session_stop')({},x.ctx);
  x.ctx.cwd=repo;
  const result=await x.tools.get('forge_qa_scope').execute('call',{},null,null,x.ctx);
  assert.equal(result.details.available,true);
  assert.equal(result.details.hasCurrentDiff,false);
  assert.deepEqual(result.details.files,[]);
  assert.match(result.details.note,/do not infer QA PASS or NOT_RUN/);
  rmSync(repo,{recursive:true,force:true});
});

test('v5.20: recover opens native select and safely corrects a corrupt executing state',async()=>{
  const x=setup(); await advanceToReview(x);
  const previous=x.entries.at(-1).data;
  x.entries.push({type:'custom',customType:'dev.omp-forge.workflow.v1',
    data:{...previous,phase:'EXECUTING',approved:false,active:true}});
  x.ctx.ui.select=async (_label, options)=>options[0];
  await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('recover',x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  assert.equal(x.entries.at(-1).data.approved,false);
  assert.ok(x.entries.at(-1).data.recoveryAudit?.length);
  assert.equal((await x.events.get('tool_call')({toolName:'write',input:{path:'src/file.ts',content:'x'}},x.ctx)).block,true);
});

test('v5.20: decline popup leaves current checkpoint unchanged',async()=>{
  const x=setup(); await advanceToReview(x);
  const previous=x.entries.at(-1).data;
  x.entries.push({type:'custom',customType:'dev.omp-forge.workflow.v1',data:{...previous,phase:'EXECUTING',approved:false,active:true}});
  x.ctx.ui.select=async(_label,options)=>options[1];
  await x.events.get('session_start')({},x.ctx);
  const n=x.entries.length;
  await x.commands.get('forge').handler('recover',x.ctx);
  assert.equal(x.entries.length,n);
  assert.equal(x.entries.at(-1).data.phase,'EXECUTING', 'declining recovery does not rewrite the legacy checkpoint');
});

test('v5.20: automatic recovery popup is scheduled on loading an inconsistent session',async()=>{
  const x=setup(); await advanceToReview(x);
  const previous=x.entries.at(-1).data;
  x.entries.push({type:'custom',customType:'dev.omp-forge.workflow.v1',data:{...previous,phase:'EXECUTING',approved:false,active:true}});
  const callbacks=[];
  const labels=[];
  x.ctx.setTimeout=callback=>callbacks.push(callback);
  x.ctx.ui.select=async(label,options)=>{labels.push(label); return options[1]};
  await x.events.get('session_start')({},x.ctx);
  assert.ok(callbacks.length>0);
  await callbacks.shift()();
  assert.match(labels.at(-1),/State inconsistency/);
  assert.equal(x.entries.at(-1).data.phase,'EXECUTING', 'declining recovery leaves the legacy checkpoint untouched');
});

test('v5.20: unsafe mismatch blocks executor subagent before repair is confirmed',async()=>{
  const x=setup(); await advanceToReview(x);
  const state=x.entries.at(-1).data;
  x.entries.push({type:'custom',customType:'dev.omp-forge.workflow.v1',data:{...state,phase:'EXECUTING',approved:false,active:true}});
  await x.events.get('session_start')({},x.ctx);
  const result=await x.events.get('before_subagent_spawn')({agent:'forge-executor'},x.ctx);
  assert.equal(result.block,true);
  assert.match(result.reason,/human review/);
});

// v5.21: a persistent footer status identifies the actual Forge Gate; the old
// transient editor widget is removed.
test('v5.21: Forge plan approval restores Forge EXECUTION status in the footer', async () => {
  const x=setup();
  const footer=[]; const widgets=[];
  x.ctx.ui.setStatus=(key,value)=>footer.push({key,value});
  x.ctx.ui.setWidget=(key,value)=>widgets.push({key,value});
  await x.events.get('session_start')({},x.ctx);
  await advanceToReview(x);
  assert.equal(footer.at(-1).value,'FORGE ▰▱▱ Plan review 1/3');
  await approvePlan(x);
  assert.equal(footer.at(-1).value,'FORGE ▰▰▱ Execution 2/3');
  assert.equal(widgets.at(-1).value,undefined,'legacy above-editor status was removed');
  footer.length=0;
  await x.events.get('agent_start')({},x.ctx);
  assert.match(footer.at(-1).value,/Execution 2\/3/);
  assert.equal(x.entries.at(-1).data.phase,'EXECUTE');
  footer.length=0;
  await x.events.get('agent_end')({},x.ctx);
  assert.match(footer.at(-1).value,/Execution 2\/3/);
});

test('v5.21: QA transition and session lifecycle refresh footer without changing approval state', async () => {
  const x=setup(); const statuses=[];
  x.ctx.ui.setStatus=(key,value)=>statuses.push({key,value});
  await x.events.get('session_start')({},x.ctx);
  await advanceToReview(x);
  await approvePlan(x);
  await x.events.get('agent_start')({},x.ctx);
  await x.events.get('session_stop')({},x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'QA');
  assert.equal(x.entries.at(-1).data.approved,true);
  assert.match(statuses.at(-1).value,/QA review 3\/3/);
  // A re-render must not append new checkpoints or advance the Gate.
  const n=x.entries.length;
  await x.events.get('agent_end')({},x.ctx);
  assert.equal(x.entries.length,n);
  assert.match(statuses.at(-1).value,/QA review 3\/3/);
});

test('v5.21: status widget fallback still works when OMP footer API is unavailable', async () => {
  const x=setup(); const widgets=[];
  x.ctx.ui.setWidget=(key,value)=>widgets.push({key,value});
  await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('A booking system',x.ctx);
  assert.match(widgets.at(-1).value[0],/Planning/);
});


// Simulates a branch switch long after approval (no in-process handoff).
async function laterBranchSwitch(x, eventName='session_tree') {
  const realNow = Date.now;
  Date.now = () => realNow() + 60_000;
  try { await x.events.get(eventName)({},x.ctx); } finally { Date.now = realNow; }
}

test('v5.22: later branch switch without Forge entries shows recovery, not inactive', async () => {
  const x=setup({persistentSession:true}); await advanceToReview(x);
  await approvePlan(x);
  assert.equal(x.entries.at(-1).data.phase,'EXECUTE');
  x.setBranch([]);
  await laterBranchSwitch(x);
  await x.commands.get('forge').handler('status',x.ctx);
  const last=x.notifications.at(-1).message;
  assert.match(last,/RECOVERY_AVAILABLE/);
  assert.match(last,/EXECUTE/);
  assert.doesNotMatch(last,/Forge: inactive/);
  // Historical approval must not be imported into the newly selected branch.
  // No Forge workflow is active. Forge has NOT silently restored EXECUTING privileges.
});

test('v5.22: accepting missing-branch checkpoint starts from PLANNING with renewed human approval', async () => {
  const x=setup({persistentSession:true}); await advanceToReview(x);
  await approvePlan(x);
  x.setBranch([]); await laterBranchSwitch(x);
  x.ctx.ui.select=async (_title, options)=>options[0];
  await x.commands.get('forge').handler('recover',x.ctx);
  const current=x.entries.at(-1).data;
  assert.equal(current.phase,'PLAN');
  assert.equal(current.approved,false);
  assert.equal(current.planValid,false);
  assert.equal(current.approvedPlanHash,null);
  assert.equal(current.recoveryAudit.at(-1).priorApprovalRevoked,true);
  assert.equal((await x.events.get('tool_call')({toolName:'write',input:{path:'lib/main.dart'}},x.ctx)).block,true);
  await x.commands.get('forge').handler('status',x.ctx);
  assert.match(x.notifications.at(-1).message,/Forge: PLAN/);
});

test('v5.22: declining recovery leaves the new OMP branch untouched', async () => {
  const x=setup({persistentSession:true}); await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('A feature request',x.ctx);
  x.setBranch([]); await x.events.get('session_tree')({},x.ctx);
  const count=x.entries.length;
  x.ctx.ui.select=async (_title, options)=>options[1];
  await x.commands.get('forge').handler('recover',x.ctx);
  assert.equal(x.entries.length,count);
  await x.commands.get('forge').handler('status',x.ctx);
  assert.match(x.notifications.at(-1).message,/RECOVERY_AVAILABLE/);
});

test('v5.22: Forge tombstone in active branch is authoritative over older checkpoint mirror', async () => {
  const x=setup({persistentSession:true}); await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('A feature request',x.ctx);
  x.setBranch([{type:'custom',customType:'dev.omp-forge.workflow.v1',data:{active:false,version:9}}]);
  await x.events.get('session_tree')({},x.ctx);
  await x.commands.get('forge').handler('status',x.ctx);
  assert.match(x.notifications.at(-1).message,/Forge: inactive/);
  assert.doesNotMatch(x.notifications.at(-1).message,/RECOVERY_AVAILABLE/);
});

test('v5.22: explicitly closed workflow does not reappear from history on branch change', async () => {
  const x=setup({persistentSession:true}); await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('A temporary requirement',x.ctx);
  await x.commands.get('forge').handler('off',x.ctx);
  x.setBranch([]); await x.events.get('session_tree')({},x.ctx);
  await x.commands.get('forge').handler('status',x.ctx);
  assert.match(x.notifications.at(-1).message,/Forge: inactive/);
  assert.doesNotMatch(x.notifications.at(-1).message,/RECOVERY_AVAILABLE/);
});

test('v5.22: unambiguous full-session entry can offer recovery without mirror', async () => {
  const x=setup({persistentSession:true});
  x.entries.push({type:'custom',customType:'dev.omp-forge.workflow.v1',data:{
    active:true, phase:'QA_EVIDENCE_PENDING', slug:'forge-history', requirement:'Check QA history',
    approved:true,planValid:true,approvedPlanHash:'hash',planWritten:true,planPath:'local://forge-history-plan.md',
  }});
  x.setBranch([]); await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('status',x.ctx);
  assert.match(x.notifications.at(-1).message,/RECOVERY_AVAILABLE/);
  assert.match(x.notifications.at(-1).message,/QA/);
  x.ctx.ui.select=async (_title,opts)=>opts[0];
  await x.commands.get('forge').handler('recover',x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  assert.equal(x.entries.at(-1).data.approved,false);
});


// ---------------------------------------------------------------- v5.23

test('v5.23: unresolved orphaned workflow pauses edits/shell/subagents and blocks Git', async () => {
  const x=setup({persistentSession:true}); await advanceToReview(x);
  await approvePlan(x);
  x.setBranch([]); await laterBranchSwitch(x);
  const call=(toolName,input)=>x.events.get('tool_call')({toolName,input},x.ctx);
  assert.equal((await call('bash',{command:'git commit -am wip && git push'})).block,true);
  assert.equal((await call('write',{path:'lib/main.dart'})).block,true);
  assert.equal((await call('edit',{path:'lib/main.dart'})).block,true);
  assert.equal((await call('bash',{command:'npm test'})).block,true);
  assert.equal((await call('task',{agent:'forge-executor',task:'x'})).block,true);
  assert.equal(await call('read',{path:'lib/main.dart'}),undefined);
  assert.equal(await call('grep',{pattern:'x'}),undefined);
});

test('v5.23: declining recovery releases edits but keeps the Git guard', async () => {
  const x=setup({persistentSession:true}); await advanceToReview(x);
  await approvePlan(x);
  x.setBranch([]); await laterBranchSwitch(x);
  x.ctx.ui.select=async (_t,o)=>o[1];
  await x.commands.get('forge').handler('recover',x.ctx);
  const call=(toolName,input)=>x.events.get('tool_call')({toolName,input},x.ctx);
  assert.equal(await call('write',{path:'lib/main.dart'}),undefined);
  assert.equal(await call('bash',{command:'npm test'}),undefined);
  assert.equal((await call('bash',{command:'git push origin main'})).block,true);
  await x.commands.get('forge').handler('status',x.ctx);
  assert.match(x.notifications.at(-1).message,/recovery declined/);
});

test('v5.23: sessions without any Forge history stay completely unguarded', async () => {
  const x=setup({persistentSession:true}); await x.events.get('session_start')({},x.ctx);
  assert.equal(await x.events.get('tool_call')({toolName:'bash',input:{command:'git commit -m x'}},x.ctx),undefined);
});

test('v5.23: blocked workflow in the mirror is offered for recovery', async () => {
  const x=setup({persistentSession:true}); await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('A feature request',x.ctx);
  const {persistForgeCheckpoint, sessionIdentity}=await import('../forge/checkpoint-recovery.mjs');
  const id=sessionIdentity(x.ctx.sessionManager,'/tmp');
  persistForgeCheckpoint(join(process.env.PI_CODING_AGENT_DIR,'forge-checkpoints'),id,{...x.entries.at(-1).data,phase:'AGENTS_BLOCKED',active:false});
  x.setBranch([]); await x.events.get('session_tree')({},x.ctx);
  await x.commands.get('forge').handler('status',x.ctx);
  assert.match(x.notifications.at(-1).message,/RECOVERY_AVAILABLE \| previousGate: PLAN/);
  x.ctx.ui.select=async (_t,o)=>o[0];
  await x.commands.get('forge').handler('recover',x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  assert.equal(x.entries.at(-1).data.active,true);
});

test('v5.23: a save on another branch does not erase a different workflow; picker offers both', async () => {
  const x=setup({persistentSession:true}); await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('First workflow on branch A',x.ctx);
  const first=x.entries.at(-1).data.slug;
  // branch B: no Forge entry; human keeps it inactive and starts another workflow
  const branchB=[]; x.setBranch(branchB); await laterBranchSwitch(x);
  x.ctx.ui.select=async (_t,o)=>o[1];
  await x.commands.get('forge').handler('recover',x.ctx);
  await x.commands.get('forge').handler('Second workflow on branch B',x.ctx);
  const second=x.entries.at(-1).data.slug;
  assert.notEqual(first,second);
  // branch C: both workflows must be offered, newest first
  x.setBranch([]); await laterBranchSwitch(x);
  let offered=[];
  x.ctx.ui.select=async (_t,o)=>{ offered=o; return o[3]; };
  await x.commands.get('forge').handler('recover',x.ctx);
  assert.match(offered[0],/Second workflow/);
  assert.match(offered[0],/saved \d{4}-\d{2}-\d{2}/);
  assert.match(offered[3],/older workflow: PLAN .*First workflow/);
  assert.equal(x.entries.at(-1).data.slug,first);
  assert.equal(x.entries.at(-1).data.approved,false);
});

test('v5.23: /forge off retires only the cancelled workflow from the mirror', async () => {
  const x=setup({persistentSession:true}); await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Temporary requirement',x.ctx);
  await x.commands.get('forge').handler('off',x.ctx);
  assert.equal(typeof x.entries.at(-1).data.cancelledSlug,'string');
  x.setBranch([]); await laterBranchSwitch(x);
  await x.commands.get('forge').handler('status',x.ctx);
  assert.match(x.notifications.at(-1).message,/Forge: inactive/);
});
test('PLAN blocks unknown tools and source writes', async () => {
  const x=setup(); await reachPlanning(x,'Create a CRM');
  const unknown=await x.events.get('tool_call')({toolName:'mystery_tool',input:{}},x.ctx);
  assert.equal(unknown.block,true);
  assert.match(unknown.reason,/unknown tool mystery_tool cannot run before human plan approval/);
  assert.equal((await x.events.get('tool_call')({toolName:'write',input:{path:'src/a.ts'}},x.ctx)).block,true);
});
test('three persisted phases preserve explicit approval and read-only QA', async () => {
  const x=setup(); await reachPlanning(x,'Create a CRM');
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  await writeCanonicalPlan(x);
  assert.notEqual((await proposePlan(x)).isError,true);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  assert.equal(x.entries.at(-1).data.approved,false);
  assert.equal((await x.events.get('tool_call')({toolName:'write',input:{path:'src/a.ts'}},x.ctx)).block,true);
  await approvePlan(x);
  assert.equal(x.entries.at(-1).data.phase,'EXECUTE');
  await x.events.get('agent_start')({},x.ctx);
  await x.events.get('session_stop')({},x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'QA');
  assert.equal((await x.events.get('tool_call')({toolName:'write',input:{path:'src/a.ts'}},x.ctx)).block,true);
  assert.ok(x.entries.filter(e=>e.customType==='dev.omp-forge.workflow.v1' && e.data).every(e=>['PLAN','EXECUTE','QA'].includes(e.data.phase)));
});
// ---------------------------------------------------------------- Forge-owned plan mode
test('starting Forge exits native OMP Plan Mode; a refused exit starts nothing', async () => {
  const x=setup(); x.setPlan('active');
  await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Create a CRM',x.ctx);
  assert.equal(x.getPlan(),'inactive');
  assert.equal(x.entries.at(-1).data.phase,'PLAN');

  const y=setup(); y.setPlan('active');
  y.ctx.sessionModes.set=async()=>({ok:false,code:'busy'});
  await y.events.get('session_start')({},y.ctx);
  await y.commands.get('forge').handler('Create a CRM',y.ctx);
  assert.equal(y.entries.length,0);
  assert.equal(y.sent.length,0);
  assert.match(y.notifications.at(-1).message,/could not be exited/);
});

test('forge_plan_propose records a pending review and freezes the plan file', async () => {
  const x=setup(); await reachPlanning(x);
  const path=await writeCanonicalPlan(x);
  const result=await proposePlan(x);
  assert.match(result.content[0].text,/FORGE PLAN PROPOSED/);
  const w=x.entries.at(-1).data;
  assert.equal(w.planWritten,true);
  assert.equal(w.planValid,true);
  assert.equal(w.reviewRequested,true);
  assert.equal(w.approved,false);
  assert.equal(w.planPath,`local://${w.slug}-plan.md`);
  assert.equal(w.approvedPlanHash,createHash('sha256').update(PLAN).digest('hex'));
  const blocked=await x.events.get('tool_call')({toolName:'write',input:{path,content:PLAN}},x.ctx);
  assert.equal(blocked.block,true);
  assert.match(blocked.reason,/awaiting human review/);
});

test('the approval dialog opens after the proposing turn; keep approval dispatches execution', async () => {
  const x=setup(); await reachPlanning(x);
  await writeCanonicalPlan(x);
  await proposePlan(x);
  const timers=[]; x.ctx.setTimeout=callback=>timers.push(callback);
  x.ctx.ui.editor=async()=>{ throw new Error('editor must not open'); };
  let offered=null;
  x.ctx.ui.select=async(_title,options)=>{ offered=options; return 'Approve and keep context'; };
  assert.equal(await x.events.get('session_stop')({},x.ctx),undefined);
  assert.equal(timers.length,1);
  await timers.shift()();
  assert.deepEqual(offered,['Approve and keep context','Approve and compact context','Refine plan','Not now — keep plan for /forge review']);
  const shown=x.shown.find(item=>item.message.customType==='forge-plan-review');
  assert.equal(shown.message.excludeFromContext,true);
  assert.ok(shown.message.content.includes(PLAN));
  const w=x.entries.at(-1).data;
  assert.equal(w.phase,'EXECUTE');
  assert.equal(w.approved,true);
  assert.equal(w.recoveryAudit.at(-1).reviewedBy,'forge-plan-review');
  assert.match(x.sent.at(-1).content,/FORGE PLAN APPROVED/);
  assert.ok(x.sent.at(-1).content.includes('## Business Topics'));
});

test('compact approval dispatches execution exactly once after compaction', async () => {
  const x=setup(); await advanceToReview(x);
  const calls=[]; x.ctx.compact=options=>{ calls.push(options); };
  const before=x.sent.length;
  await approvePlan(x,'Approve and compact context');
  assert.equal(x.entries.at(-1).data.phase,'EXECUTE');
  assert.equal(x.sent.length,before,'execution waits for compaction');
  assert.equal(calls.length,1);
  assert.equal(calls[0].suppressContinuation,true);
  calls[0].onComplete();
  assert.equal(x.sent.length,before+1);
  assert.match(x.sent.at(-1).content,/FORGE PLAN APPROVED/);
  calls[0].onError(new Error('x'));
  assert.equal(x.sent.length,before+1,'a late compaction error never dispatches twice');
});

test('a plan changed after proposal cannot be approved', async () => {
  const x=setup(); await advanceToReview(x);
  putPlanFile(x,x.entries.at(-1).data.planPath,PLAN+'\n- edited after proposal\n');
  let selects=0; x.ctx.ui.select=async()=>{ selects++; return 'Approve and keep context'; };
  await x.commands.get('forge').handler('review',x.ctx);
  assert.equal(selects,0);
  const w=x.entries.at(-1).data;
  assert.equal(w.planWritten,false);
  assert.equal(w.planValid,false);
  assert.equal(w.approved,false);
  assert.ok(x.notifications.some(n=>n.level==='error' && /changed after it was proposed/.test(n.message)));
});

test('approval exits native Plan Mode first; a refused exit pauses instead of executing', async () => {
  const x=setup(); await advanceToReview(x);
  x.setPlan('active');
  await approvePlan(x);
  assert.equal(x.getPlan(),'inactive');
  assert.match(x.sent.at(-1).content,/FORGE PLAN APPROVED/);

  const y=setup(); await advanceToReview(y);
  y.setPlan('active');
  y.ctx.sessionModes.set=async()=>({ok:false,code:'busy'});
  const before=y.sent.length;
  await approvePlan(y);
  const w=y.entries.at(-1).data;
  assert.equal(w.phase,'EXECUTE');
  assert.equal(w.approved,true);
  assert.equal(w.active,false);
  assert.equal(y.sent.length,before);
  assert.match(y.notifications.at(-1).message,/Exit it with \/plan/);
});

test('an unchanged rework plan is rejected as identical', async () => {
  const x=setup(); await advanceToReview(x);
  await approvePlan(x);
  await x.events.get('agent_start')({},x.ctx);
  await x.events.get('session_stop')({},x.ctx);
  const fail=structuredClone(SUBMISSION); fail.topicResults[0].tests[0].status='FAIL';
  await runQaAgents(x);
  await x.tools.get('forge_qa_submit').execute('call',fail,null,null,x.ctx);
  await x.commands.get('forge').handler('rework',x.ctx); // the human's go-ahead to plan a fix
  const s=x.entries.at(-1).data;
  await writeCanonicalPlan(x,`local://${s.slug}-rework-${s.reworkCycles}-plan.md`,PLAN);
  const result=await proposePlan(x);
  assert.equal(result.isError,true);
  assert.match(result.content[0].text,/identical/);
});

async function reachQa(x) {
  await advanceToReview(x);
  await approvePlan(x);
  await x.events.get('agent_start')({},x.ctx);
  await x.events.get('session_stop')({},x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'QA');
}

async function startPendingAgent(x, agent) {
  const id=`pending-${++agentCallSeq}`;
  const call=await x.events.get('tool_call')({toolName:'task',toolCallId:id,input:{agent,task:'Return independent evidence'}},x.ctx);
  assert.notEqual(call?.block,true);
  assert.notEqual((await x.events.get('before_subagent_spawn')({agent},x.ctx))?.block,true);
  return () => x.events.get('tool_result')({toolName:'task',toolCallId:id,isError:false,content:[{type:'text',text:'Completed independent report'}]},x.ctx);
}

for (const delivery of [false,true]) {
  test(`read-only ${delivery ? 'QA PASS delivery' : 'QA'} denies unknown mutation tools but permits evidence tools`, async () => {
    const x=setup(); await reachQa(x);
    if (delivery) {
      await runQaAgents(x);
      const result=await x.tools.get('forge_qa_submit').execute('pass',SUBMISSION,null,null,x.ctx);
      assert.match(result.content[0].text,/GATE: PASS/);
    }
    const hook=x.events.get('tool_call');
    for (const [toolName,input] of [
      ['eval',{language:'py',code:'open("src/app.ts", "w").write("changed")'}],
      ['ast_edit',{path:'src/app.ts',operation:'replace',replacement:'changed'}],
      ['lsp',{action:'rename',path:'src/app.ts',newName:'changed'}],
      ['mcp__workspace__write_file',{path:'src/app.ts',content:'changed'}],
      ['mystery_tool',{}],
    ]) {
      assert.equal((await hook({toolName,input},x.ctx))?.block,true,toolName);
    }
    for (const toolName of ['read','grep','glob',...(delivery ? ['forge_delivery_submit'] : ['forge_qa_scope','forge_qa_submit'])]) {
      assert.equal(await hook({toolName,input:{}},x.ctx),undefined,toolName);
    }
    const task=await hook({toolName:'task',toolCallId:`allowed-${++agentCallSeq}`,input:{agent:'scout',task:'Read evidence'}},x.ctx);
    assert.notEqual(task?.block,true,'task remains available for the current specialist');
    assert.equal(await hook({toolName:'bash',input:{command:'npm test'}},x.ctx),undefined);
  });
}

test('a late reviewer report from closed workflow A cannot complete workflow B', async () => {
  const x=setup(); await reachQa(x);
  const finishA=await startPendingAgent(x,'forge-code-reviewer');
  await x.commands.get('forge').handler('off',x.ctx);
  await reachQa(x);
  const finishB=await startPendingAgent(x,'forge-code-reviewer');
  const before=structuredClone(x.entries.at(-1).data), count=x.entries.length;
  await finishA();
  assert.equal(x.entries.length,count);
  assert.deepEqual(x.entries.at(-1).data,before);
  const rejected=await x.tools.get('forge_qa_submit').execute('early',SUBMISSION,null,null,x.ctx);
  assert.equal(rejected.isError,true);
  assert.match(rejected.content[0].text,/Independent reviewer forge-code-reviewer must run/);
  await finishB();
  assert.match((await x.tools.get('forge_qa_submit').execute('b',SUBMISSION,null,null,x.ctx)).content[0].text,/GATE: PASS/,'only workflow B report satisfies its gate');
});

test('a late task report from an earlier QA round cannot satisfy a QA retry', async () => {
  const x=setup(); await reachQa(x);
  const finishOld=await startPendingAgent(x,'forge-code-reviewer');
  await runQaAgents(x);
  const blocked=structuredClone(SUBMISSION); blocked.codeQualityChecks[0].status='NOT_RUN';
  await x.tools.get('forge_qa_submit').execute('blocked',blocked,null,null,x.ctx);
  await x.commands.get('forge').handler('qa',x.ctx);
  const before=structuredClone(x.entries.at(-1).data), count=x.entries.length;
  await finishOld();
  assert.equal(x.entries.length,count);
  assert.deepEqual(x.entries.at(-1).data,before);
  assert.deepEqual(x.entries.at(-1).data.gateAgents.QA,[]);
  const result=await x.tools.get('forge_qa_submit').execute('retry',SUBMISSION,null,null,x.ctx);
  assert.equal(result.isError,true);
  assert.match(result.content[0].text,/Independent reviewer forge-code-reviewer must run/);
  await runQaAgents(x);
  assert.match((await x.tools.get('forge_qa_submit').execute('fresh',SUBMISSION,null,null,x.ctx)).content[0].text,/GATE: PASS/);
});

test('branch changes invalidate pending reports even when the loaded workflow checkpoint is unchanged', async () => {
  const x=setup(); await reachQa(x);
  const finish=await startPendingAgent(x,'forge-code-reviewer');
  x.setBranch([...x.entries]);
  await x.events.get('session_tree')({},x.ctx);
  const before=structuredClone(x.entries.at(-1).data), count=x.entries.length;
  await finish();
  assert.equal(x.entries.length,count);
  assert.deepEqual(x.entries.at(-1).data,before);
  assert.equal((await x.tools.get('forge_qa_submit').execute('stale',SUBMISSION,null,null,x.ctx)).isError,true);
  await runQaAgents(x);
  assert.match((await x.tools.get('forge_qa_submit').execute('fresh',SUBMISSION,null,null,x.ctx)).content[0].text,/GATE: PASS/);
});

for (const change of ['branch','session','phase']) {
  test(`a delayed steering choice is ignored after ${change} changes`, async () => {
    const x=setup(); await x.events.get('session_start')({},x.ctx);
    await x.commands.get('forge').handler('Original requirement',x.ctx);
    let choose, opened;
    const ready=new Promise(resolve=>{ opened=resolve; });
    x.ctx.ui.select=async (_title,options) => {
      opened();
      return await new Promise(resolve=>{ choose=()=>resolve(options.find(option=>option.startsWith('Steer · '))); });
    };
    let aborts=0;
    x.ctx.isIdle=()=>false;
    x.ctx.abort=async()=>{ aborts++; };
    const pending=x.events.get('input')({source:'interactive',text:'Do not apply this stale steering'},x.ctx);
    await ready;
    if (change==='branch') {
      x.setBranch([...x.entries]);
      await x.events.get('session_tree')({},x.ctx);
    } else if (change==='session') {
      x.ctx.sessionManager.getSessionId=()=>`different-session-${savedSessionSeq}`;
      await x.events.get('session_switch')({},x.ctx);
    } else {
      await writeCanonicalPlan(x);
      assert.notEqual((await proposePlan(x)).isError,true);
      await approvePlan(x);
      assert.equal(x.entries.at(-1).data.phase,'EXECUTE');
    }
    const before=structuredClone(x.entries.at(-1).data), count=x.entries.length, sent=x.sent.length;
    choose();
    assert.deepEqual(await pending,{handled:true});
    assert.equal(aborts,0);
    assert.equal(x.entries.length,count);
    assert.equal(x.sent.length,sent);
    assert.deepEqual(x.entries.at(-1).data,before);
    assert.match(x.notifications.at(-1).message,/state changed/i);
  });
}

for (const replacement of ['off','approved B']) {
  for (const callback of ['onComplete','onError']) {
    test(`compact approval A ${callback} is harmless after ${replacement}`, async () => {
      const x=setup(); await advanceToReview(x);
      const calls=[]; x.ctx.compact=options=>{ calls.push(options); };
      await approvePlan(x,'Approve and compact context');
      assert.equal(calls.length,1);
      await x.commands.get('forge').handler('off',x.ctx);
      if (replacement==='approved B') {
        await advanceToReview(x);
        await approvePlan(x);
        assert.equal(x.entries.at(-1).data.phase,'EXECUTE');
      }
      const before=structuredClone(x.entries.at(-1).data), count=x.entries.length, sent=x.sent.length;
      await assert.doesNotReject(async()=>{ await calls[0][callback](new Error('old compaction failed')); });
      assert.equal(x.sent.length,sent,'stale callbacks never dispatch execution instructions');
      assert.equal(x.entries.length,count);
      assert.deepEqual(x.entries.at(-1).data,before);
    });
  }
}

test('QA PASS can start a fresh approved QA round and cannot reuse specialist completions', async () => {
  const x=setup(); await reachQa(x);
  await runQaAgents(x);
  assert.match((await x.tools.get('forge_qa_submit').execute('first',SUBMISSION,null,null,x.ctx)).content[0].text,/GATE: PASS/);
  const approved=structuredClone(x.entries.at(-1).data);
  await x.commands.get('forge').handler('qa',x.ctx);
  const state=x.entries.at(-1).data;
  assert.equal(state.phase,'QA');
  assert.equal(state.approved,true);
  assert.equal(state.planValid,true);
  assert.equal(state.approvedPlanHash,approved.approvedPlanHash);
  assert.equal(state.planPath,approved.planPath);
  assert.equal(state.qaStatus,null);
  assert.deepEqual(state.gateAgents.QA,[]);
  assert.match(x.sent.at(-1).content,/forge_qa_scope/);
  const rejected=await x.tools.get('forge_qa_submit').execute('without-specialists',SUBMISSION,null,null,x.ctx);
  assert.equal(rejected.isError,true);
  assert.match(rejected.content[0].text,/Independent reviewer forge-code-reviewer must run/);
  await runQaAgents(x);
  assert.match((await x.tools.get('forge_qa_submit').execute('second',SUBMISSION,null,null,x.ctx)).content[0].text,/GATE: PASS/);
});

test('restarting a pending rework proposal preserves the paired approved base hash and path', async () => {
  const x=setup(); await reachQa(x);
  const approved=structuredClone(x.entries.at(-1).data);
  await runQaAgents(x);
  const fail=structuredClone(SUBMISSION); fail.topicResults[0].tests[0].status='FAIL';
  await x.tools.get('forge_qa_submit').execute('fail',fail,null,null,x.ctx);
  await x.commands.get('forge').handler('rework',x.ctx); // the human's go-ahead to plan a fix
  const state=x.entries.at(-1).data;
  const reworkPath=`local://${state.slug}-rework-${state.reworkCycles}-plan.md`;
  await writeCanonicalPlan(x,reworkPath,PLAN+'\n## QA Rework Changes\n- Fix duplicate bookings.\n');
  assert.notEqual((await proposePlan(x)).isError,true);
  await x.commands.get('forge').handler('rework',x.ctx);
  const restarted=x.entries.at(-1).data;
  assert.equal(restarted.phase,'PLAN');
  assert.equal(restarted.approved,false);
  assert.equal(restarted.reworkBaseHash,approved.approvedPlanHash);
  assert.equal(restarted.reworkBasePlanPath,approved.planPath);
  assert.notEqual(restarted.reworkBasePlanPath,reworkPath);
  assert.equal((await x.events.get('tool_call')({toolName:'write',input:{path:approved.planPath,content:PLAN}},x.ctx)).block,true);
});

// ---------------------------------------------------------------- v6.2 Forge plan mode, main-agent execution, lean QA
test('v6.2: /forge opens PLAN in Forge plan mode with scout research and no requirement/planner agents', async () => {
  const x=setup(); await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Create a CRM',x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  const instruction=x.sent.at(-1).content;
  assert.ok(instruction.includes('[GATE 1/3: PLAN — Forge plan mode]'));
  assert.ok(instruction.includes('parallel `scout` subagents'));
  assert.doesNotMatch(instruction,/forge-requirement|forge-planner/);
});

test('v6.2: subagent policy — scout in PLAN, any helper in approved EXECUTE, reviewer only in QA', async () => {
  const x=setup(); await reachPlanning(x,'Create a CRM');
  const spawn=agent=>x.events.get('before_subagent_spawn')({agent},x.ctx);
  assert.equal(await spawn('scout'),undefined);
  assert.equal((await spawn('forge-code-reviewer')).block,true);
  assert.equal((await spawn('task')).block,true);
  await writeCanonicalPlan(x);
  assert.notEqual((await proposePlan(x)).isError,true);
  await approvePlan(x);
  assert.equal(x.entries.at(-1).data.phase,'EXECUTE');
  assert.equal(await spawn('task'),undefined);
  assert.equal((await spawn('forge-code-reviewer')).block,true);
  await x.events.get('agent_start')({},x.ctx);
  await x.events.get('session_stop')({},x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'QA');
  assert.equal((await spawn('task')).block,true);
  assert.equal(await spawn('scout'),undefined);
  assert.notEqual((await spawn('forge-code-reviewer'))?.block,true);
});

test('v6.2: PLAN allows only the plan file to be written and research/todo/wait tools without agents', async () => {
  const x=setup(); const state=await reachPlanning(x,'Create a CRM');
  const planPath=`local://${state.slug}-plan.md`;
  const hook=input=>x.events.get('tool_call')(input,x.ctx);
  assert.equal(await hook({toolName:'write',input:{path:planPath,content:PLAN}}),undefined);
  assert.equal(await hook({toolName:'edit',input:{input:`[${planPath}#ABCD]\nPUT 1.=1:\n+x`}}),undefined);
  assert.equal(await hook({toolName:'todo',input:{}}),undefined);
  assert.equal(await hook({toolName:'wait',input:{}}),undefined);
  const source=await hook({toolName:'edit',input:{input:'[src/a.ts#ABCD]\nPUT 1.=1:\n+x'}});
  assert.equal(source.block,true);
  assert.ok(source.reason.includes(`Only ${planPath} is writable`));
  const removal=await hook({toolName:'edit',input:{input:`[${planPath}#ABCD]\nREM`}});
  assert.equal(removal.block,true);
  assert.deepEqual(x.entries.at(-1).data.agentCompletions ?? [],[]);
});

test('v6.2: PLAN without a proposal reminds twice on session_stop, then warns and stops', async () => {
  const x=setup(); await reachPlanning(x,'Create a CRM');
  for (let i=0;i<2;i++) {
    const stop=await x.events.get('session_stop')({},x.ctx);
    assert.equal(stop.continue,true);
    assert.match(stop.additionalContext,/turn ended without a required tool call/);
  }
  assert.equal(await x.events.get('session_stop')({},x.ctx),undefined);
  assert.equal(x.notifications.at(-1).level,'warning');
  assert.match(x.notifications.at(-1).message,/waiting for a plan proposal/);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
});

test('v6.2: approved execution settles straight into QA with no executor agent', async () => {
  const x=setup(); await advanceToReview(x);
  await approvePlan(x);
  await x.events.get('agent_start')({},x.ctx);
  const qa=await x.events.get('session_stop')({},x.ctx);
  assert.equal(qa.continue,true);
  assert.match(qa.additionalContext,/POST-EXECUTION QA REVIEW/);
  assert.match(qa.additionalContext,/forge-code-reviewer/);
  assert.equal(x.entries.at(-1).data.phase,'QA');
  assert.deepEqual(x.entries.at(-1).data.agentCompletions ?? [],[]);
});

test('v6.2: reviewer + QA PASS lets the main agent submit delivery with no further agent', async () => {
  const x=setup(); await reachQa(x);
  await runQaAgents(x);
  assert.match((await x.tools.get('forge_qa_submit').execute('pass',SUBMISSION,null,null,x.ctx)).content[0].text,/GATE: PASS/);
  const delivery=await x.tools.get('forge_delivery_submit').execute('deliver',{
    subject:'feat(booking): add approvals',body:'- Add approvals',highlights:['Approvals'],changedFiles:['src/booking.ts'],
  },null,null,x.ctx);
  assert.notEqual(delivery.isError,true,delivery.content?.[0]?.text);
  assert.match(delivery.content[0].text,/COPY THIS COMMIT MESSAGE/);
  const state=x.entries.at(-1).data;
  assert.equal(state.active,false);
  assert.deepEqual(state.agentCompletions.map(c=>c.agent),['forge-code-reviewer']);
});

test('v6.2: an approved legacy REQUIREMENT branch entry restores as PLAN without approval', async () => {
  const x=setup();
  x.entries.push({type:'custom',customType:'dev.omp-forge.workflow.v1',data:{
    ...initialState('Legacy approved requirement','legacy-req'), phase:'REQUIREMENT', active:true,
    approved:true, approvedPlanHash:'abc', planValid:true, planWritten:true,
  }});
  await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('status',x.ctx);
  assert.match(x.notifications.at(-1).message,/Forge: PLAN/);
  assert.match(x.notifications.at(-1).message,/approved: no/);
  assert.equal((await x.events.get('tool_call')({toolName:'write',input:{path:'src/a.ts'}},x.ctx)).block,true);
  await x.commands.get('forge').handler('review',x.ctx);
  assert.equal(x.notifications.at(-1).message,'No proposed Forge plan awaits review.');
});

async function runAgentWithReport(x, agent, text) {
  const id = `task-${++agentCallSeq}`;
  await x.events.get('tool_call')({toolName:'task',toolCallId:id,input:{agent,task:'Review and report findings'}},x.ctx);
  const spawned = await x.events.get('before_subagent_spawn')({agent},x.ctx);
  assert.notEqual(spawned?.block,true,`unexpected block for ${agent}: ${spawned?.reason}`);
  return await x.events.get('tool_result')({toolName:'task',toolCallId:id,isError:false,content:[{type:'text',text}]},x.ctx);
}

test('v6.2: plan contract rejects a plan without the enforced sections and Approach decision lines', async () => {
  const x=setup(); await reachPlanning(x,'Create a CRM');
  const bare=PLAN.replace(/## Context[\s\S]*?(?=## Business Topics)/,'');
  await writeCanonicalPlan(x,null,bare);
  const rejected=await proposePlan(x);
  assert.equal(rejected.isError,true);
  for (const issue of [/Missing ## Context section/,/Missing ## Approach section/,/Missing ## Verification section/,/Missing ## Assumptions & contingencies section/]) assert.match(rejected.content[0].text,issue);
  await writeCanonicalPlan(x,null,PLAN.replace('- Open decisions: none','- Open decisions: who approves refunds — BLOCKER'));
  assert.match((await proposePlan(x)).content[0].text,/is a BLOCKER: resolve it with the user/);
  await writeCanonicalPlan(x,null,PLAN.replace('- Migration & rollback: not applicable — no data or API change\n',''));
  assert.match((await proposePlan(x)).content[0].text,/needs a "Migration & rollback:" line/);
  assert.equal(x.entries.at(-1).data.planValid,false);
});

test('v6.2: /forge planreview on requires forge-plan-critic and its CRITICAL/HIGH IDs before the proposal', async () => {
  const backup=readFileSync(process.env.FORGE_CONFIG_PATH,'utf8');
  try {
    const x=setup(); await x.events.get('session_start')({},x.ctx);
    await x.commands.get('forge').handler('planreview on',x.ctx);
    assert.equal(JSON.parse(readFileSync(process.env.FORGE_CONFIG_PATH,'utf8')).planReview,true);
    await x.commands.get('forge').handler('Create a CRM',x.ctx);
    assert.equal(x.entries.at(-1).data.planReview,true);
    assert.match(x.sent.at(-1).content,/PLAN REVIEW is ON[\s\S]*`forge-plan-critic` ONCE/);
    await writeCanonicalPlan(x);
    assert.match((await proposePlan(x)).content[0].text,/run forge-plan-critic once on the written plan/);
    assert.equal((await x.events.get('before_subagent_spawn')({agent:'forge-code-reviewer'},x.ctx)).block,true);
    const critique=await runAgentWithReport(x,'forge-plan-critic','- PC-001 [HIGH] Approach — refunds have no rollback — add a rollback step\n- PC-002 [LOW] Context — wording');
    assert.match(critique.additionalContext,/PC-001/);
    assert.doesNotMatch(critique.additionalContext,/PC-002/);
    const missing=await proposePlan(x);
    assert.equal(missing.isError,true);
    assert.match(missing.content[0].text,/resolve plan-review finding\(s\) PC-001/);
    await writeCanonicalPlan(x,null,PLAN.replace('## Assumptions & contingencies\n- none','## Assumptions & contingencies\n- PC-001: rollback restores the previous refund state'));
    const proposed=await proposePlan(x);
    assert.notEqual(proposed.isError,true,proposed.content[0].text);
    assert.equal(x.entries.at(-1).data.planValid,true);
  } finally { writeFileSync(process.env.FORGE_CONFIG_PATH,backup); }
});

test('v6.2: QA cannot drop a reviewer CRITICAL/HIGH finding; a disputed one stays visible', async () => {
  const x=setup(); await reachQa(x);
  const reviewed=await runAgentWithReport(x,'forge-code-reviewer','Findings:\n- CR-001 [HIGH] src/booking.ts:12 — approval skips the role check — require manager role\n- CR-002 [LOW] src/booking.ts:3 — naming');
  assert.match(reviewed.additionalContext,/CR-001/);
  const dropped=await x.tools.get('forge_qa_submit').execute('drop',SUBMISSION,null,null,x.ctx);
  assert.equal(dropped.isError,true);
  assert.match(dropped.content[0].text,/CR-001/);
  assert.equal(x.entries.at(-1).data.qaStatus,null);
  const disputed={...SUBMISSION,codeReview:{...SUBMISSION.codeReview,findings:[{id:'CR-001',title:'Role check',severity:'MEDIUM',evidence:'Disputed: the role is enforced by middleware at src/auth.ts:40',fileRefs:['src/auth.ts:40']}]}};
  const passed=await x.tools.get('forge_qa_submit').execute('disputed',disputed,null,null,x.ctx);
  assert.notEqual(passed.isError,true,passed.content[0].text);
  assert.match(passed.content[0].text,/GATE: PASS/);
  const report=readFileSync(x.entries.at(-1).data.qaReportPath,'utf8');
  assert.match(report,/CR-001 \[MEDIUM\] Role check\*\* — Disputed:/);
});

test('v6.2: every QA result shows the summary table to the user; PASS goes on to delivery without a decision', async () => {
  const x=setup(); await reachQa(x);
  await runQaAgents(x);
  await x.tools.get('forge_qa_submit').execute('pass',SUBMISSION,null,null,x.ctx);
  const table=x.shown.at(-1).message;
  assert.equal(table.customType,'forge-qa-summary');
  assert.equal(table.display,true);
  assert.equal(table.excludeFromContext,true);
  assert.match(table.content,/### Forge QA ✅ PASS\n\n✅ 5 PASS · ❌ 0 FAIL · ⚠️ 0 BLOCKED · ⏸️ 0 NOT RUN · Full report: /);
  assert.match(table.content,/\| ✅ \| TC-002 \| BIZ-002 Approval \| Approve booking \| Approved \| test approval passed \|/);
  assert.match(table.content,/\| ✅ \| QG-001 \| unit tests \| tests exit 0 \|/);
  const state=x.entries.at(-1).data;
  assert.equal(state.reworkDecisionPending,false);
  const next=await x.events.get('session_stop')({},x.ctx);
  assert.match(next.additionalContext,/DELIVERY PREPARATION/);
});

test('v6.2: QA BLOCKED asks the user: rerun QA, plan a fix with notes, or keep the report for /forge review', async () => {
  const x=setup(); await reachQa(x);
  await runQaAgents(x);
  const blocked=structuredClone(SUBMISSION); blocked.topicResults[1].tests[0].status='NOT_RUN'; blocked.topicResults[1].tests[0].actual='Test runner unavailable';
  await x.tools.get('forge_qa_submit').execute('blocked',blocked,null,null,x.ctx);
  assert.match(x.shown.at(-1).message.content,/### Forge QA ⚠️ BLOCKED[\s\S]*\| ⏸️ \| TC-002 \|/);
  assert.equal(x.entries.at(-1).data.reworkDecisionPending,true);
  assert.equal((await x.events.get('tool_call')({toolName:'forge_qa_submit',input:SUBMISSION},x.ctx)).block,true);
  assert.match(renderForgeWidget(x.entries.at(-1).data)[0],/▰▰▰  QA blocked · your decision  3\/3/);

  // "Not now" keeps everything; /forge review shows the table again and reopens the decision.
  const timers=[]; x.ctx.setTimeout=callback=>timers.push(callback);
  assert.equal(await x.events.get('session_stop')({},x.ctx),undefined);
  let offered;
  x.ctx.ui.select=async(title,options)=>{ offered=options; assert.match(title,/QA BLOCKED/); return options.at(-1); };
  x.ctx.ui.editor=async()=>'Use the in-memory store for TC-002';
  await timers[0]();
  assert.deepEqual(offered,['Rerun QA — I collected the missing evidence','Plan the fix — draft a rework plan, then approve it','Plan the fix with my notes','Not now — keep the QA report (/forge review to decide later)']);
  assert.equal(x.entries.at(-1).data.reworkDecisionPending,true);
  assert.equal(x.entries.at(-1).data.phase,'QA');

  const shownBefore=x.shown.length, sentBefore=x.sent.length;
  x.ctx.ui.select=async(_title,options)=>'Plan the fix with my notes';
  await x.commands.get('forge').handler('review',x.ctx);
  assert.equal(x.shown.length,shownBefore+1);
  assert.match(x.shown.at(-1).message.content,/### Forge QA ⚠️ BLOCKED/);
  const state=x.entries.at(-1).data;
  assert.equal(state.phase,'PLAN');
  assert.equal(state.approved,false);
  assert.equal(state.reworkDecisionPending,false);
  assert.equal(state.reworkNotes,'Use the in-memory store for TC-002');
  assert.equal(x.sent.length,sentBefore+1);
  assert.match(x.sent.at(-1).content,/APPROVED BY THE OPERATOR[\s\S]*Operator notes for this fix[\s\S]*Use the in-memory store for TC-002/);
});

test('v6.2: QA BLOCKED "Rerun QA" starts a fresh QA round with the approval kept', async () => {
  const x=setup(); await reachQa(x);
  await runQaAgents(x);
  const blocked=structuredClone(SUBMISSION); blocked.topicResults[1].tests[0].status='NOT_RUN';
  await x.tools.get('forge_qa_submit').execute('blocked',blocked,null,null,x.ctx);
  x.ctx.ui.select=async(_title,options)=>options[0];
  await x.commands.get('forge').handler('review',x.ctx);
  const state=x.entries.at(-1).data;
  assert.equal(state.phase,'QA');
  assert.equal(state.qaStatus,null);
  assert.equal(state.approved,true);
  assert.equal(state.reworkDecisionPending,false);
  assert.deepEqual(state.gateAgents.QA,[]);
  assert.match(x.sent.at(-1).content,/POST-EXECUTION QA REVIEW/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync, writeFileSync, copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import forgeExtension from '../forge/index.ts';
import {requiredAgentsFor, initialState} from '../forge/core.mjs';

const tmp = mkdtempSync(join(tmpdir(),'omp-forge-tests-'));
process.env.FORGE_REPORT_DIR = tmp;
process.env.FORGE_CONFIG_PATH = join(tmp, 'test-forge-config.json');
process.env.PI_CODING_AGENT_DIR = join(tmp, 'agent-home');
mkdirSync(join(process.env.PI_CODING_AGENT_DIR, 'agents'), {recursive:true});
for (const name of ['forge-requirement','forge-planner','forge-executor','forge-qa','forge-code-reviewer','forge-delivery','my-planner']) {
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR,'agents',`${name}.md`),'---\nname: '+name+'\ndescription: Custom specialist\n---\nTest specialist\n');
}
for (const name of ['forge-requirement-gate','forge-plan-gate','forge-execute-gate','forge-qa-gate']) {
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
  const entries = [];
  const sessionPath = join(tmp,`session-${++savedSessionSeq}.jsonl`);
  let branchEntries = null;
  const notifications = [];
  let plan = 'inactive';
  const pi = {
    zod:fakeZ,
    setLabel() {},
    on(event, handler) { events.set(event, handler); },
    registerCommand(name, cmd) { commands.set(name, cmd); },
    registerTool(tool) { tools.set(tool.name, tool); },
    sendUserMessage(content, options) { sent.push({content, options}); },
    appendEntry(customType, data) { entries.push({type:'custom', customType, data}); },
  };
  forgeExtension(pi);
  const ctx = {
    agent: {kind:'main'}, mode:'tui',
    sessionModes: {
      getState: () => ({plan}),
      set: async () => { plan = 'active'; return {ok:true,changed:true}; },
    },
    sessionManager: { getBranch: () => branchEntries ?? entries, getEntries: () => entries, getSessionId: () => persistentSession ? `test-session-${savedSessionSeq}` : 'test-session', ...(persistentSession ? {getSessionFile: () => sessionPath} : {}) },
    ui: {notify: (message, level) => notifications.push({message, level}), input: async () => 'Create a CRM'},
    hasPendingMessages: () => false,
    getPendingPlanReview: () => undefined,
    isIdle: () => true,
    setTimeout: () => {},
  };
  return {events,commands,tools,sent,entries,notifications,ctx,getPlan:()=>plan,setPlan:v=>{plan=v;},setBranch:v=>{branchEntries=v;},sessionPath};
}

const PLAN = `# Plan\n## Business Topics\n- BIZ-001: Booking\n- BIZ-002: Approval\n## Requirement Traceability\n- REQ-001 | BIZ-001 | Create booking | Created\n- REQ-002 | BIZ-002 | Approve booking | Approved\n## Business Test Cases\n- TC-001 | BIZ-001 | REQ-001 | Create booking | Created | node test\n- TC-002 | BIZ-002 | REQ-002 | Approve booking | Approved | node test\n## Code Quality Gates\n- QG-001: Unit tests\n- QG-002: Lint\n`;
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

async function writeCanonicalPlan(x, targetPath = null) {
  const state = x.entries.at(-1).data;
  const path = targetPath ?? `local://${state.slug}-plan.md`;
  const id = `write-${++agentCallSeq}`;
  assert.equal(await x.events.get('tool_call')({toolName:'write',toolCallId:id,input:{path,content:PLAN}},x.ctx),undefined);
  const result = await x.events.get('tool_result')({toolName:'write',toolCallId:id,isError:false,content:[{type:'text',text:`Wrote ${path}`}]},x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  assert.match(result.additionalContext,/FORGE PLAN SAVED/);
  return path;
}
const SUMMARY = {
  baseline:'Goal: deliver the requested feature; scope and acceptance are agreed.',
  findings:[{severity:'MEDIUM',title:'Edge case for empty input unspecified',source:'forge-requirement'}],
  blockers:[], assumptions:['Single tenant'], relevantFiles:[],
};
async function submitSummary(x, params = SUMMARY) {
  return await x.tools.get('forge_requirement_summary').execute('summary-call',params,undefined,undefined,x.ctx);
}

/** REQUIREMENT → one forge-requirement report → summary → PLANNING. */
async function completeRequirement(x, params = SUMMARY) {
  const report = await runCompletedAgent(x,'forge-requirement');
  assert.match(report.additionalContext,/\[FORGE REQUIREMENT — report received\]/);
  const result = await submitSummary(x, params);
  assert.notEqual(result.isError,true,result.content?.[0]?.text);
  return result;
}

async function reachPlanning(x, requirement = 'Plan a feature') {
  await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler(requirement,x.ctx);
  await completeRequirement(x);
  await runCompletedAgent(x,'forge-planner');
  return x.entries.at(-1).data;
}

async function runQaAgents(x) {
  for (const agent of ['forge-qa','forge-code-reviewer']) {
    await runCompletedAgent(x,agent);
  }
}

async function advanceToReview(x) {
  await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Create a CRM',x.ctx);
  assert.equal(x.getPlan(),'active');
  assert.match(x.sent[0].content,/GATE 1\/4: REQUIREMENT — single-pass analysis/);
  const result = await completeRequirement(x);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  assert.match(result.content[0].text,/^Forge: requirement summary recorded \(0 CRITICAL\/HIGH, 0 open blocker\(s\)\) → Planning\./);
  assert.match(result.content[0].text,/GATE 2\/4: PLANNING/);
  await runCompletedAgent(x,'forge-planner');
  await writeCanonicalPlan(x);
  await x.events.get('plan_review_requested')({planContent:PLAN,planPath:`local://${x.entries.at(-1).data.slug}-plan.md`},x.ctx);
  assert.equal(x.entries.at(-1).data.businessTopics.length,2);
  assert.equal(x.entries.at(-1).data.requirements.length,2);
  assert.equal(x.entries.at(-1).data.qualityGates.length,2);
}

test('native review resolution ignores mismatched IDs and duplicate late events', async () => {
  const x=setup();
  await advanceToReview(x);
  await x.events.get('plan_review_requested')({reviewId:'review-current',planContent:PLAN},x.ctx);
  const before=x.entries.length;
  await x.events.get('plan_review_resolved')({reviewId:'review-old',choice:'execute'},x.ctx);
  await x.events.get('plan_review_resolved')({choice:'execute'},x.ctx);
  assert.equal(x.entries.length,before);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  await x.events.get('plan_review_resolved')({reviewId:'review-current',choice:'execute'},x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'EXECUTE');
  x.setPlan('inactive');
  await x.events.get('agent_start')({},x.ctx);
  await runCompletedAgent(x,'forge-executor');
  await x.events.get('session_stop')({},x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'QA');
  const qaState=structuredClone(x.entries.at(-1).data), count=x.entries.length;
  for (const choice of ['execute','refine',undefined]) {
    await x.events.get('plan_review_resolved')({reviewId:'review-current',choice},x.ctx);
  }
  assert.equal(x.entries.length,count);
  assert.deepEqual(x.entries.at(-1).data,qaState);
});

test('a review resolution cannot approve a different session workflow', async () => {
  const x=setup({persistentSession:true});
  await advanceToReview(x);
  await x.events.get('plan_review_requested')({reviewId:'review-original',planContent:PLAN},x.ctx);
  const other={...x.entries.at(-1).data,slug:'other-workflow'};
  x.setBranch([{type:'custom',customType:'dev.omp-forge.workflow.v1',data:other}]);
  x.ctx.sessionManager.getSessionId=()=> 'other-session';
  x.ctx.sessionManager.getSessionFile=()=>join(tmp,'other-session.jsonl');
  await x.events.get('session_switch')({reason:'resume'},x.ctx);
  const count=x.entries.length;
  await x.events.get('plan_review_resolved')({reviewId:'review-original',choice:'execute'},x.ctx);
  assert.equal(x.entries.length,count);
  await x.commands.get('forge').handler('status',x.ctx);
  assert.match(x.notifications.at(-1).message,/PLAN/);
  assert.ok(x.notifications.some(n=>n.message.includes('Open /plan-review')));
  assert.match(x.notifications.at(-1).message,/approved: no/);
});
async function reachExecutionBlocked(x) {
  await advanceToReview(x);
  await x.events.get('plan_review_resolved')({choice:'execute'},x.ctx);
  x.setPlan('inactive');
  await x.events.get('agent_start')({},x.ctx);
  const retry=await x.events.get('session_stop')({},x.ctx);
  assert.equal(retry.continue,true);
  assert.equal(await x.events.get('session_stop')({},x.ctx),undefined);
  assert.equal(x.entries.at(-1).data.phase,'EXECUTE');
  return x.entries.at(-1).data;
}

test('native provider rate limits preserve approved execution until real executor completion', async () => {
  const x=setup(); await advanceToReview(x);
  await x.events.get('plan_review_resolved')({choice:'execute'},x.ctx);
  x.setPlan('inactive'); await x.events.get('agent_start')({},x.ctx);
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
  await runCompletedAgent(x,'forge-executor');
  const success=await x.events.get('session_stop')({last_assistant_message:{role:'assistant',content:[],stopReason:'stop'}},x.ctx);
  assert.equal(success.continue,true);
  assert.match(success.additionalContext,/POST-EXECUTION QA REVIEW/);
  assert.equal(x.entries.at(-1).data.phase,'QA');
  assert.equal(x.entries.at(-1).data.agentCompletions.filter(item=>item.agent==='forge-executor').length,1);
});

test('aborted stops do not spend retries; legacy stops without assistant payload still continue', async () => {
  const x=setup(); await advanceToReview(x);
  await x.events.get('plan_review_resolved')({choice:'execute'},x.ctx);
  x.setPlan('inactive'); await x.events.get('agent_start')({},x.ctx);
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
  assert.equal(x.entries.at(-1).data.phase,'EXECUTE');
  assert.equal(x.entries.at(-1).data.agentRetries.EXECUTE,1);
});

test('missing executor blocks truthfully and status offers QA and execution recovery', async () => {
  const x=setup(); await reachExecutionBlocked(x);
  assert.equal(x.notifications.at(-1).message,'Forge halted: no completed forge-executor report was recorded. Check /forge status. Use /forge qa to review existing implementation, or /forge resume to retry execution.');
  const savedEntries=x.entries.length;
  await x.commands.get('forge').handler('status',x.ctx);
  const status=x.notifications.at(-1).message;
  assert.match(status,/waiting agents: forge-executor/);
  assert.match(status,/\| action: \/forge qa reviews existing work without rerunning implementation; \/forge resume retries execution\./);
  assert.equal(x.entries.length,savedEntries,'status formatting must not write workflow state');
});

test('provider failures after implementation and during QA never synthesize transitions or reports', async () => {
  const x=setup(); await advanceToReview(x);
  await x.events.get('plan_review_resolved')({choice:'execute'},x.ctx);
  x.setPlan('inactive'); await x.events.get('agent_start')({},x.ctx);
  await runCompletedAgent(x,'forge-executor');
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
  const blocked=await reachExecutionBlocked(x);
  const approvedHash=blocked.approvedPlanHash, planPath=blocked.planPath;
  const completions=structuredClone(blocked.agentCompletions);
  const savedEntries=x.entries.length;
  await runCompletedAgent(x,'forge-executor'); // inactive workflow ignores this late task result
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
  assert.match(footer.at(-1).value,/QA review 4\/4/);
  assert.equal((await x.events.get('tool_call')({toolName:'edit',input:{path:'src/app.go'}},x.ctx)).block,true);
  const premature=await x.tools.get('forge_qa_submit').execute('call',SUBMISSION,null,null,x.ctx);
  assert.equal(premature.isError,true);
  assert.match(premature.content[0].text,/independent QA specialists/i);
  await runQaAgents(x);
  const result=await x.tools.get('forge_qa_submit').execute('call',SUBMISSION,null,null,x.ctx);
  assert.match(result.content[0].text,/GATE: PASS/);
  assert.equal(x.entries.at(-1).data.phase,'QA');
});

test('blocked QA requires current valid approval and never restores approval on an empty branch', async () => {
  const x=setup(); const blocked=structuredClone(await reachExecutionBlocked(x));
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

test('global chain runs planning and after native approval starts execution then QA', async () => {
  const x=setup();
  await advanceToReview(x);
  await x.events.get('plan_review_resolved')({choice:'execute'},x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'EXECUTE');
  assert.equal(x.entries.at(-1).data.active,true);
  x.setPlan('inactive');
  assert.equal(await x.events.get('session_stop')({},x.ctx),undefined,'not yet observed execution');
  await x.events.get('agent_start')({},x.ctx);
  await runCompletedAgent(x,'forge-executor');
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
  await x.events.get('plan_review_resolved')({choice:'keep'},x.ctx);
  x.setPlan('inactive'); await x.events.get('agent_start')({},x.ctx); await runCompletedAgent(x,'forge-executor');
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
  await x.events.get('plan_review_resolved')({choice:'execute'},x.ctx);
  x.setPlan('inactive'); await x.events.get('agent_start')({},x.ctx); await runCompletedAgent(x,'forge-executor');
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
  await x.events.get('plan_review_resolved')({choice:undefined},x.ctx);
  assert.equal(x.entries.at(-1).data.approved,false);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
});

test('forge read-only policy blocks mutation during discovery but allows reading and asks', async () => {
  const x=setup();
  await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Create a CRM',x.ctx);
  const hook=x.events.get('tool_call');
  assert.equal((await hook({toolName:'bash',input:{command:'echo test'}},x.ctx)).block,true);
  assert.equal((await hook({toolName:'write',input:{path:'src/app.ts'}},x.ctx)).block,true);
  assert.equal((await hook({toolName:'write',input:{path:'local://forge-plan.md'}},x.ctx)).block,true);
  assert.equal((await hook({toolName:'write',input:{path:'xd://propose'}},x.ctx)).block,true);
  for (const tool of ['read','grep','glob','ask']) assert.equal(await hook({toolName:tool,input:{}},x.ctx),undefined,tool);
  const task = await hook({toolName:'task',input:{agent:'forge-requirement',task:'Analyze'}},x.ctx);
  assert.match(task.input.task,/Skill: forge-requirement-gate/);
});

test('input with forge: prefix enters plan without slash command', async () => {
  const x=setup();
  await x.events.get('session_start')({},x.ctx);
  const result=await x.events.get('input')({source:'interactive',text:'forge: Build a booking system'},x.ctx);
  assert.equal(x.getPlan(),'active');
  assert.match(result.text,/Build a booking system/);
  assert.equal(x.sent.length,0);
});


test('after QA PASS, delivery tool produces copy-ready message without invoking Git writes', async () => {
  const x = setup(); await advanceToReview(x);
  await x.events.get('plan_review_resolved')({choice:'execute'},x.ctx);
  x.setPlan('inactive'); await x.events.get('agent_start')({},x.ctx); await runCompletedAgent(x,'forge-executor');
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
  await runCompletedAgent(x,'forge-delivery');
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

test('QA failure loops through rework plan then fresh approval before execution', async () => {
  const x=setup(); await advanceToReview(x);
  await x.events.get('plan_review_resolved')({choice:'execute'},x.ctx);
  x.setPlan('inactive'); await x.events.get('agent_start')({},x.ctx); await runCompletedAgent(x,'forge-executor');
  await x.events.get('session_stop')({},x.ctx);
  const fail=structuredClone(SUBMISSION);
  fail.topicResults[0].tests[0].status='FAIL';fail.topicResults[0].tests[0].actual='Duplicate booking created';
  await runQaAgents(x);
  await x.tools.get('forge_qa_submit').execute('call',fail,null,null,x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  assert.equal(x.entries.at(-1).data.approved,false);
  assert.equal(x.entries.at(-1).data.reworkCycles,1);
  assert.equal((await x.events.get('tool_call')({toolName:'edit',input:{path:'src/booking.ts'}},x.ctx)).block,true);
  assert.equal(await x.events.get('session_stop')({},x.ctx),undefined,'rework waits safely until native Plan Mode can be activated');
  x.setPlan('active');
  const rework=await x.events.get('session_stop')({},x.ctx);
  assert.equal(rework.continue,true);
  assert.match(rework.additionalContext,/QA FAILED: REWORK PLAN/);
  assert.match(rework.additionalContext,/qa-report.md/);
  assert.equal(x.getPlan(),'active');
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  const reworkState = x.entries.at(-1).data;
  const originalPlanPath = reworkState.reworkBasePlanPath;
  const reworkPath = `local://${reworkState.slug}-rework-${reworkState.reworkCycles}-plan.md`;
  assert.notEqual(reworkPath, originalPlanPath);
  assert.equal((await x.events.get('tool_call')({
    toolName:'write', input:{path:originalPlanPath,content:PLAN},
  },x.ctx)).block,true,'the approved base plan must remain read-only');

  await runCompletedAgent(x,'forge-planner');
  await writeCanonicalPlan(x,reworkPath);
  await x.events.get('plan_review_requested')({planContent:PLAN,planPath:reworkPath},x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  assert.equal(x.entries.at(-1).data.approved,false);
  // Refine is not approval; it loops to planning.
  await x.events.get('plan_review_resolved')({choice:'refine'},x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  assert.equal(x.entries.at(-1).data.approved,false);
  await runCompletedAgent(x,'forge-planner');
  await writeCanonicalPlan(x,reworkPath);
  await x.events.get('plan_review_requested')({planContent:PLAN+'\n## Rework fix\n- Remove duplicate booking\n',planPath:reworkPath},x.ctx);
  await x.events.get('plan_review_resolved')({choice:'keep'},x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'EXECUTE');
  assert.equal(x.entries.at(-1).data.approved,true);
  assert.equal(x.entries.at(-1).data.reworkCycles,1);
});

test('delivery cannot be prepared before QA PASS', async () => {
  const x=setup(); await advanceToReview(x);
  const result=await x.tools.get('forge_delivery_submit').execute('call',{subject:'feat: add booking',body:'',highlights:[],changedFiles:[]},null,null,x.ctx);
  assert.equal(result.isError,true);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
});

test('required gate agents are enforced and wrong agent is blocked', async () => {
  const x=setup(); await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Create a CRM',x.ctx);
  const blocked=await x.events.get('before_subagent_spawn')({agent:'executor'},x.ctx);
  assert.equal(blocked.block,true);
  assert.match(blocked.reason,/forge-requirement/);
  let next=await x.events.get('session_stop')({},x.ctx);
  assert.equal(next.continue,true);
  assert.match(next.additionalContext,/Mandatory named subagents were not observed: forge-requirement/);
  next=await x.events.get('session_stop')({},x.ctx);
  assert.equal(next,undefined);
  assert.equal(x.entries.at(-1).data.phase,'REQUIREMENT');
  assert.equal(x.entries.at(-1).data.active,false);
  await x.commands.get('forge').handler('resume current',x.ctx);
  const resumed=x.entries.at(-1).data;
  assert.equal(resumed.phase,'REQUIREMENT');
  assert.equal(resumed.active,true);
  assert.deepEqual(resumed.gateAgents,{});
  assert.deepEqual(resumed.agentRetries,{});
  assert.equal(resumed.requirementSummaryRequested,false);
  assert.match(x.sent.at(-1).content,/GATE 1\/4: REQUIREMENT — single-pass analysis/);
  await completeRequirement(x);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
});

test('post-execution QA PASS is blocked if independent specialists did not spawn', async () => {
  const x=setup(); await advanceToReview(x);
  await x.events.get('plan_review_resolved')({choice:'execute'},x.ctx);
  x.setPlan('inactive'); await x.events.get('agent_start')({},x.ctx);
  await runCompletedAgent(x,'forge-executor');
  await x.events.get('session_stop')({},x.ctx);
  const result=await x.tools.get('forge_qa_submit').execute('call',SUBMISSION,null,null,x.ctx);
  assert.equal(result.isError,true);
  assert.match(result.content[0].text,/independent QA specialists/i);
  assert.equal(x.entries.at(-1).data.phase,'QA');
});

test('wrong agent is rejected during read-only QA and delivery phases', async () => {
  const x=setup(); await advanceToReview(x);
  await x.events.get('plan_review_resolved')({choice:'execute'},x.ctx);
  x.setPlan('inactive'); await x.events.get('agent_start')({},x.ctx);
  await runCompletedAgent(x,'forge-executor');
  await x.events.get('session_stop')({},x.ctx);
  assert.equal((await x.events.get('before_subagent_spawn')({agent:'forge-executor'},x.ctx)).block,true);
  await runCompletedAgent(x,'forge-qa');
  await runCompletedAgent(x,'forge-code-reviewer');
  await x.tools.get('forge_qa_submit').execute('call',SUBMISSION,null,null,x.ctx);
  assert.equal((await x.events.get('before_subagent_spawn')({agent:'forge-qa'},x.ctx)).block,true);
  assert.notEqual((await x.events.get('before_subagent_spawn')({agent:'forge-delivery'},x.ctx)).block,true);
});

test('v5 a spawned agent without a task result cannot satisfy a gate', async () => {
  const x=setup(); await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Create a CRM',x.ctx);
  await x.events.get('before_subagent_spawn')({agent:'forge-requirement'},x.ctx);
  const result=await x.events.get('session_stop')({},x.ctx);
  assert.equal(result.continue,true);
  assert.match(result.additionalContext,/not observed/);
  assert.equal(x.entries.at(-1).data.phase,'REQUIREMENT');
  assert.deepEqual(x.entries.at(-1).data.gateAgents.REQUIREMENT ?? [],[]);
});

test('v5 failed task tool result cannot satisfy the gate', async () => {
  const x=setup(); await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Create a CRM',x.ctx);
  await x.events.get('tool_call')({toolName:'task',toolCallId:'broken1',input:{agent:'forge-requirement'}},x.ctx);
  await x.events.get('before_subagent_spawn')({agent:'forge-requirement'},x.ctx);
  await x.events.get('tool_result')({toolName:'task',toolCallId:'broken1',isError:true,content:[{type:'text',text:'Failed'}]},x.ctx);
  const result=await x.events.get('session_stop')({},x.ctx);
  assert.equal(result.continue,true);
  assert.equal(x.entries.at(-1).data.phase,'REQUIREMENT');
  assert.deepEqual(x.entries.at(-1).data.gateAgents.REQUIREMENT ?? [],[]);
  const summary=await submitSummary(x);
  assert.equal(summary.isError,true);
  assert.match(summary.content[0].text,/requirement report missing: run forge-requirement once/);
});

test('v5 invalid native plan review cannot authorize execution', async () => {
  const x=setup(); await advanceToReview(x);
  await x.events.get('plan_review_requested')({reviewId:'invalid-review',planContent:'# Plan\nNo test cases',planPath:'local://broken.md'},x.ctx);
  assert.equal(x.entries.at(-1).data.planValid,false);
  await x.events.get('plan_review_resolved')({choice:'execute'},x.ctx);
  assert.equal(x.entries.at(-1).data.approved,false);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
});

test('v5 disallows Git writes in a Forge subagent session', async () => {
  const x=setup();
  const sub={...x.ctx,agent:{kind:'sub',name:'forge-executor'}};
  const forbidden=await x.events.get('tool_call')({toolName:'bash',input:{command:'git commit -m done'}},sub);
  assert.equal(forbidden.block,true);
  const qa={...x.ctx,agent:{kind:'sub',name:'forge-qa'}};
  assert.equal((await x.events.get('tool_call')({toolName:'write',input:{path:'src/x.ts'}},qa)).block,true);
});


test('v5.1 regression: OMP Plan Mode inactive cannot deadlock read-only requirement analysis and required task', async () => {
  const x=setup(); await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Change debit card enum references',x.ctx);
  x.setPlan('inactive'); // OMP mode transition between turns/subagent entry
  for (const tool of ['read','grep','glob','ask','task']) {
    const outcome = await x.events.get('tool_call')({toolName:tool,input:tool === 'task' ? {agent:'forge-requirement',task:'Analyze'} : {path:'src/operations.ts'}},x.ctx);
    assert.notEqual(outcome?.block,true,`${tool} must work even when plan is inactive`);
  }
  assert.equal((await x.events.get('tool_call')({toolName:'edit',input:{path:'src/operations.ts'}},x.ctx)).block,true);
  assert.equal((await x.events.get('tool_call')({toolName:'write',input:{path:'xd://propose'}},x.ctx)).block,true);
  await runCompletedAgent(x,'forge-requirement');
  assert.equal(await x.events.get('tool_call')({toolName:'forge_requirement_summary',input:SUMMARY},x.ctx),undefined);
  const result=await submitSummary(x);
  assert.notEqual(result.isError,true);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
});

test('v5.1 regression: temporarily paused Plan Mode is not a blocker for the requirement report and summary', async () => {
  const x=setup(); await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Build booking workflow',x.ctx);
  x.setPlan('paused');
  await runCompletedAgent(x,'forge-requirement');
  const next=await x.events.get('session_stop')({},x.ctx);
  assert.equal(next.continue,true);
  assert.match(next.additionalContext,/\[FORGE REQUIREMENT — report received\]/);
  assert.equal(x.entries.at(-1).data.phase,'REQUIREMENT');
  await submitSummary(x);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
});

test('v5.4: Plan Mode resumed after requirement summary, and proposal requires successful plan write', async () => {
  const x=setup(); await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Build booking workflow',x.ctx);
  x.setPlan('paused');
  await completeRequirement(x);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  assert.equal(x.getPlan(),'active');
  assert.equal((await x.events.get('tool_call')({toolName:'write',input:{path:'xd://propose'}},x.ctx)).block,true);
  await runCompletedAgent(x,'forge-planner');
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  await writeCanonicalPlan(x);
  assert.equal(await x.events.get('tool_call')({toolName:'write',input:{path:'xd://propose',content:x.entries.at(-1).data.slug}},x.ctx),undefined);
});

test('v5.1: read-only Rework permits agents but never source code changes', async () => {
  const x=setup(); await advanceToReview(x);
  await x.events.get('plan_review_resolved')({choice:'execute'},x.ctx);
  x.setPlan('inactive'); await x.events.get('agent_start')({},x.ctx);
  await runCompletedAgent(x,'forge-executor'); await x.events.get('session_stop')({},x.ctx);
  const fail=structuredClone(SUBMISSION); fail.topicResults[0].tests[0].status='FAIL';
  await runQaAgents(x);
  await x.tools.get('forge_qa_submit').execute('call',fail,null,null,x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  for (const tool of ['read','grep','glob','ask']) assert.equal(await x.events.get('tool_call')({toolName:tool,input:{}},x.ctx),undefined);
  assert.equal((await x.events.get('tool_call')({toolName:'edit',input:{path:'src/change.ts'}},x.ctx)).block,true);
});


test('v5.1: QA prevents arbitrary shell and exec aliases, not just bash', async () => {
  const x=setup(); await advanceToReview(x);
  await x.events.get('plan_review_resolved')({choice:'execute'},x.ctx);
  x.setPlan('inactive'); await x.events.get('agent_start')({},x.ctx);
  await runCompletedAgent(x,'forge-executor'); await x.events.get('session_stop')({},x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'QA');
  for (const tool of ['bash','shell','terminal','exec','run']) {
    assert.equal((await x.events.get('tool_call')({toolName:tool,input:{command:'rm -rf src'}},x.ctx)).block,true,tool);
    assert.equal(await x.events.get('tool_call')({toolName:tool,input:{command:'git diff --stat'}},x.ctx),undefined,tool);
  }
});

// v5.2: The bare /forge command must provide native multiline composition.
test('v5.2: /forge opens multiline editor and preserves line breaks before starting', async () => {
  const x = setup();
  await x.events.get('session_start')({}, x.ctx);
  const draft = 'Feature: Replacement debit card\n\nConstraints:\n- Keep existing behavior\n- No commits';
  let editorCalls = 0;
  x.ctx.ui.input = async () => { throw new Error('single-line input must never be opened'); };
  x.ctx.ui.editor = async (title, prefill) => {
    editorCalls++;
    assert.match(title, /Forge/);
    assert.equal(prefill, '');
    return draft;
  };
  await x.commands.get('forge').handler('', x.ctx);
  assert.equal(editorCalls, 1);
  assert.equal(x.entries.at(-1).data.requirement, draft);
  assert.equal(x.entries.at(-1).data.phase, 'REQUIREMENT');
  assert.equal(x.sent.length, 1);
});

test('v5.2: cancelling or submitting empty multiline editor does not start workflow', async () => {
  for (const result of [undefined, null, '', '  \n  ']) {
    const x = setup();
    await x.events.get('session_start')({}, x.ctx);
    x.ctx.ui.editor = async () => result;
    await x.commands.get('forge').handler('', x.ctx);
    assert.equal(x.sent.length, 0);
    assert.equal(x.entries.length, 0);
  }
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

test('v5.2: unsupported editor API warns rather than silently using single line', async () => {
  const x = setup();
  await x.events.get('session_start')({}, x.ctx);
  x.ctx.ui.input = async () => { throw new Error('no fallback to single line'); };
  await x.commands.get('forge').handler('', x.ctx);
  assert.equal(x.entries.length, 0);
  assert.match(x.notifications.at(-1).message, /multiline requirement editor/i);
});

// v5.3 regression: the UI shows one REQUIREMENT gate, never internal steps.
test('v6.1: one REQUIREMENT gate runs a single forge-requirement pass, then the summary opens PLANNING', async () => {
  const x = setup();
  const widgets = [];
  x.ctx.ui.setWidget = (id, lines) => widgets.push({ id, lines });
  await x.events.get('session_start')({}, x.ctx);
  await x.commands.get('forge').handler('Create a cross-platform booking flow', x.ctx);
  const state = x.entries.at(-1).data;
  assert.equal(state.phase, 'REQUIREMENT');
  assert.deepEqual(requiredAgentsFor(state), ['forge-requirement']);
  const lastWidget = widgets.at(-1).lines;
  assert.equal(lastWidget.length, 1);
  assert.match(lastWidget[0], /Requirement/);
  assert.doesNotMatch(lastWidget[0], /DISCOVERY|COOKING|CHALLENGE|AWAITING APPROVAL|○/);
  const first = await runCompletedAgent(x, 'forge-requirement');
  assert.match(first.additionalContext, /^\[FORGE REQUIREMENT — report received\]/);
  assert.equal(x.entries.at(-1).data.phase, 'REQUIREMENT', 'a report alone never opens PLANNING');
  assert.equal(x.entries.at(-1).data.requirementSummaryRequested, true);
  const second = await runCompletedAgent(x, 'forge-requirement');
  assert.doesNotMatch(second?.additionalContext ?? '', /report received/, 'summary prompt is sent only once');
  const result = await submitSummary(x, {...SUMMARY, blockers:['Max booking horizon?']});
  assert.match(result.content[0].text, /^Forge: requirement summary recorded \(0 CRITICAL\/HIGH, 1 open blocker\(s\)\) → Planning\./);
  assert.match(result.content[0].text, /Use this requirement synthesis as the starting point[\s\S]*Edge case for empty input unspecified[\s\S]*Max booking horizon\?/);
  const planning = x.entries.at(-1).data;
  assert.equal(planning.phase, 'PLAN');
  assert.equal(planning.planWritten, false);
  assert.equal(planning.requirementSummary.baseline, SUMMARY.baseline);
  assert.deepEqual(planning.requirementSummary.blockers, ['Max booking horizon?']);
  assert.deepEqual(planning.requirementSummary.specialistSeverities, {critical:0, high:0});
  assert.equal(x.getPlan(), 'active');
  assert.ok(planning.agentCompletions.every(c => c.gate === 'REQUIREMENT'));
  const again = await submitSummary(x);
  assert.equal(again.isError, true);
  assert.match(again.content[0].text, /no Forge REQUIREMENT gate is active/);
});

test('v6.1: legacy v5 COOKING state resumes as the single REQUIREMENT gate', async () => {
  const x = setup();
  const old = {
    ...initialOld(), phase: 'COOKING', gateAgents: { DISCOVERY: ['forge-requirement'], COOKING: ['forge-requirement'] },
    gateAgentsSpawned: { COOKING: ['forge-requirement'] }, agentRetries: { COOKING: 1 },
  };
  x.entries.push({ type: 'custom', customType: 'dev.omp-forge.workflow.v1', data: old });
  await x.events.get('session_start')({}, x.ctx);
  await x.commands.get('forge').handler('status', x.ctx);
  assert.match(x.notifications.at(-1).message, /REQUIREMENT/);
  assert.equal((await x.events.get('before_subagent_spawn')({agent:'forge-planner'}, x.ctx)).block, true);
  assert.equal((await x.events.get('before_subagent_spawn')({agent:'forge-critic'}, x.ctx)).block, true);
  await completeRequirement(x);
  assert.equal(x.entries.at(-1).data.phase, 'PLAN');
});

test('v6.1: legacy v6.0 state with requirementStep/mode still completes with one report and a new summary', async () => {
  const x = setup();
  const old = {
    ...initialState('Legacy v6.0 requirement', 'legacy-v60'),
    gateSkills: {}, skillPins: {},
    requirementStep: 'CHALLENGE', requirementMode: 'fast',
    gateAgents: { 'REQUIREMENT:DISCOVERY': ['forge-requirement'], 'REQUIREMENT:COOKING': ['forge-requirement','forge-critic'] },
    agentRetries: { 'REQUIREMENT:COOKING': 1 },
    requirementSummary: { baseline: 'Old v6.0 baseline that must be replaced', findings: [], blockers: [], assumptions: [], relevantFiles: [], escalate: true },
  };
  x.entries.push({ type: 'custom', customType: 'dev.omp-forge.workflow.v1', data: old });
  await x.events.get('session_start')({}, x.ctx);
  assert.equal((await submitSummary(x)).isError, true, 'old step keys do not count as the report');
  await completeRequirement(x);
  const state = x.entries.at(-1).data;
  assert.equal(state.phase, 'PLAN');
  assert.equal(state.requirementSummary.baseline, SUMMARY.baseline);
});

function initialOld() {
  return {
    phase: 'DISCOVERY', active: true, slug: 'legacy-job', requirement: 'Legacy requirement',
    gateAgents: {}, agentRetries: {}, gateAgentsSpawned: {}, proposalRetries: 0,
  };
}

// v5.4: a QA/plan deadlock was caused by advancing only in session_stop.
test('v5.4: requirement report asks for the summary via task tool_result without session_stop or user prompts', async () => {
  const x=setup(); await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Analyze a feature change',x.ctx);
  await completeRequirement(x);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  assert.equal(x.sent.length,1,'no synthetic user messages needed');
});

test('v5.4: plan write denied before requirements complete and approval cannot open without saved plan', async () => {
  const x=setup();await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Explore possible architecture',x.ctx);
  const forbidden=await x.events.get('tool_call')({toolName:'write',toolCallId:'early',input:{path:`local://${x.entries.at(-1).data.slug}-plan.md`}},x.ctx);
  assert.equal(forbidden.block,true);
  assert.match(forbidden.reason,/harness advances automatically/i);
  await x.events.get('plan_review_requested')({planContent:PLAN,planPath:`local://${x.entries.at(-1).data.slug}-plan.md`},x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'REQUIREMENT');
});

test('v5.4: a failed local plan write cannot advance PLANNING to PROPOSAL', async () => {
  const x=setup();await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Feature to analyze',x.ctx);
  await completeRequirement(x);
  await runCompletedAgent(x,'forge-planner');
  const id='write-failed';const path=`local://${x.entries.at(-1).data.slug}-plan.md`;
  await x.events.get('tool_call')({toolName:'write',toolCallId:id,input:{path}},x.ctx);
  await x.events.get('tool_result')({toolName:'write',toolCallId:id,isError:true,content:[{type:'text',text:'Disk failure'}]},x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  assert.equal(x.entries.at(-1).data.planWritten,false);
  assert.equal((await x.events.get('tool_call')({toolName:'write',input:{path:'xd://propose'}},x.ctx)).block,true);
});

test('v5.4: busy Plan Mode after specialist task defers planning until session settles', async () => {
  const x=setup();await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Design feature requirement',x.ctx);
  await runCompletedAgent(x,'forge-requirement');
  // In actual OMP mode transitions may return 'busy' during tool execution.
  x.setPlan('inactive');
  const origSet=x.ctx.sessionModes.set;
  let first=true;
  x.ctx.sessionModes.set=async (...args) => first ? (first=false,{ok:false,code:'busy',message:'turn running'}) : origSet(...args);
  const last=await submitSummary(x);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  assert.match(last.content[0].text,/\[FORGE REQUIREMENT COMPLETE\]/);
  assert.match(last.content[0].text,/Do NOT write local:\/\//);
  assert.equal((await x.events.get('tool_call')({toolName:'write',input:{path:`local://${x.entries.at(-1).data.slug}-plan.md`}},x.ctx)).block,true);
  const timers=[];
  x.ctx.setTimeout=(cb,_ms)=>{timers.push(cb);};
  const continuation=await x.events.get('session_stop')({},x.ctx);
  assert.equal(continuation,undefined,'mode recovery is deferred until the turn is idle');
  assert.ok(timers.length>0);
  while (timers.length && x.getPlan() !== 'active') await timers.shift()();
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  assert.equal(x.getPlan(),'active');
  assert.match(x.sent.at(-1).content,/GATE 2\/4: PLANNING/);
});

test('v5.4: restoring paused Plan Mode uses enter (not unsupported resume)', async () => {
  const x=setup();await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Design new feature',x.ctx);
  x.setPlan('paused');
  const calls=[];
  x.ctx.sessionModes.set=async arg=>{calls.push(arg);x.setPlan('active');return {ok:true};};
  await completeRequirement(x);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  assert.deepEqual(calls,[{mode:'plan',action:'enter'}]);
});

test('v5.5: approval hides Forge widget; execution restores compact 3/5 progress', async () => {
  const x=setup();
  const widgets=[];
  x.ctx.ui.setWidget=(id,lines,options)=>widgets.push({id,lines,options});
  await advanceToReview(x);
  assert.equal(widgets.at(-1).id,'forge-gates');
  assert.equal(widgets.at(-1).lines,undefined,'native review must not compete with Forge widget');
  await x.events.get('plan_review_resolved')({choice:'execute'},x.ctx);
  const finalWidget=widgets.at(-1);
  assert.deepEqual(finalWidget.lines,['FORGE  ▰▰▰▱  Execution  3/4']);
  assert.equal(finalWidget.options.placement,'aboveEditor');
});

// v5.6: OMP may report Plan Mode paused or temporarily inactive while an
// otherwise-valid plan file write is issued. Forge must not itself block the
// session-local plan; native OMP still decides whether the call succeeds.
for (const mode of ['active','paused','inactive']) {
  test(`v5.6: PLANNING permits sandbox plan write with mode=${mode}`, async () => {
    const x=setup();
    await x.events.get('session_start')({},x.ctx);
    await x.commands.get('forge').handler('Plan a feature',x.ctx);
    await completeRequirement(x);
    await runCompletedAgent(x,'forge-planner');
    assert.equal(x.entries.at(-1).data.phase,'PLAN');
    x.setPlan(mode);
    const path=`local://${x.entries.at(-1).data.slug}-plan.md`;
    const id=`plan-write-${mode}`;
    assert.equal(await x.events.get('tool_call')({toolName:'write',toolCallId:id,input:{path,content:PLAN}},x.ctx),undefined);
    assert.equal(x.entries.at(-1).data.phase,'PLAN','cannot claim write succeeded before tool_result');
    await x.events.get('tool_result')({toolName:'write',toolCallId:id,isError:false,content:[{type:'text',text:`Wrote ${path}`}]},x.ctx);
    assert.equal(x.entries.at(-1).data.phase,'PLAN');
    assert.equal(x.entries.at(-1).data.planPath,path);
    const proposal=await x.events.get('tool_call')({toolName:'write',input:{path:'xd://propose',content:x.entries.at(-1).data.slug}},x.ctx);
    if (mode==='active') assert.equal(proposal,undefined);
    else assert.match(proposal.reason,/deferred|temporarily paused/i);
  });
}
test('v6.1: PROPOSAL permits native propose only for the saved canonical plan', async () => {
  const x=setup();
  await reachPlanning(x);
  const path=await writeCanonicalPlan(x);
  const slug=x.entries.at(-1).data.slug;
  const hook=x.events.get('tool_call');
  assert.equal(await hook({toolName:'bash',input:{command:`propose ${slug}`}},x.ctx),undefined);
  assert.equal(x.entries.at(-1).data.approved,false,'proposal is not approval');
  assert.equal((await hook({toolName:'bash',input:{command:'propose unrelated-plan'}},x.ctx)).block,true);
  assert.equal((await hook({toolName:'bash',input:{command:`propose ${slug} --force`}},x.ctx)).block,true);
  assert.equal(path,x.entries.at(-1).data.planPath);
});

test('v5.6: PLANNING permits an alternate OMP-local plan filename then pins it', async () => {
  const x=setup();
  await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Plan a feature',x.ctx);
  await completeRequirement(x);
  await runCompletedAgent(x,'forge-planner');
  const path='local://nosess-occupation-ops-plan.md';
  assert.equal(await x.events.get('tool_call')({toolName:'write',toolCallId:'alt-plan',input:{path,content:PLAN}},x.ctx),undefined);
  await x.events.get('tool_result')({toolName:'write',toolCallId:'alt-plan',isError:false,content:[{type:'text',text:'wrote alternate local plan'}]},x.ctx);
  assert.equal(x.entries.at(-1).data.planPath,path);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  assert.equal((await x.events.get('tool_call')({toolName:'write',input:{path:`local://${x.entries.at(-1).data.slug}-plan.md`,content:PLAN}},x.ctx)).block,true,'different plan cannot be modified after pinning');
  assert.equal(await x.events.get('tool_call')({toolName:'write',input:{path,content:PLAN}},x.ctx),undefined);
});

test('v5.6: planning sandbox exception remains narrow and source writes still blocked', async () => {
  const x=setup();
  await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Plan a feature',x.ctx);
  await completeRequirement(x);
  await runCompletedAgent(x,'forge-planner');
  x.setPlan('paused');
  const blockedPaths=['src/main.go','.github/workflows/test.yml','local://notes.md','local://folder/other-plan.md','local://../bad-plan.md','local://plan.md','xd://resolve','xd://reject','/tmp/forge-plan.md'];
  for (const path of blockedPaths) {
    const v=await x.events.get('tool_call')({toolName:'write',input:{path,content:'bad'}},x.ctx);
    assert.equal(v?.block,true,`blocked path: ${path}`);
  }
  for (const command of ['git add .','git commit -m test','git push origin main','echo code > src/main.go']) {
    const v=await x.events.get('tool_call')({toolName:'bash',input:{command}},x.ctx);
    assert.equal(v?.block,true,`blocked command: ${command}`);
  }
});

test('v5.6: failed local plan write never advances to PROPOSAL', async () => {
  const x=setup();
  await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Plan a feature',x.ctx);
  await completeRequirement(x);
  await runCompletedAgent(x,'forge-planner');
  const path=`local://${x.entries.at(-1).data.slug}-plan.md`;
  assert.equal(await x.events.get('tool_call')({toolName:'write',toolCallId:'bad-plan',input:{path,content:PLAN}},x.ctx),undefined);
  await x.events.get('tool_result')({toolName:'write',toolCallId:'bad-plan',isError:true,content:[{type:'text',text:'native OMP rejected write'}]},x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  assert.equal(x.entries.at(-1).data.planWritten,false);
  assert.equal((await x.events.get('tool_call')({toolName:'write',input:{path:'xd://propose'}},x.ctx)).block,true);
});

test('v5.6: QA FAIL clears previous plan-written and approval validity before rework', async () => {
  const x=setup(); await advanceToReview(x);
  await x.events.get('plan_review_resolved')({choice:'execute'},x.ctx);
  x.setPlan('inactive');
  await x.events.get('agent_start')({},x.ctx);
  await runCompletedAgent(x,'forge-executor');
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
  await x.commands.get('forge').handler('skill add requirement security-review',x.ctx);
  await x.commands.get('forge').handler('skills',x.ctx);
  assert.match(x.notifications.at(-1).message,/security-review/);
  await x.commands.get('forge').handler('Build payment API',x.ctx);
  const state=x.entries.at(-1).data;
  assert.ok(state.gateSkills.requirement.includes('forge-requirement-gate'));
  assert.ok(state.gateSkills.requirement.includes('security-review'));
  assert.ok(state.skillPins['security-review'].sha256);
  const task={agent:'forge-requirement',task:'Analyze the code'};
  const event=await x.events.get('tool_call')({toolName:'task',toolCallId:'skills-1',input:task},x.ctx);
  assert.match(event.input.task,/Check access controls and request validation/);
  assert.match(event.input.task,/Skill: security-review/);
  assert.equal(task.task,'Analyze the code');
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
  const rejected=await x.events.get('tool_call')({toolName:'task',toolCallId:'skills-2',input:{agent:'forge-qa',task:'Verify tests'}},x.ctx);
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
  assert.match(x.notifications.at(-1).message,/forge-planner/);
  assert.match(x.notifications.at(-1).message,/found/);
});

test('v5.12 legacy config does not override gate routing for new workflows', async () => {
  const backup=readFileSync(process.env.FORGE_CONFIG_PATH,'utf8');
  try {
    writeFileSync(process.env.FORGE_CONFIG_PATH,JSON.stringify({autoStart:false,agentAssignments:{planning:{planner:'my-planner'}}}));
    const x=setup(); await x.events.get('session_start')({},x.ctx);
    await x.commands.get('forge').handler('Build a CRM',x.ctx);
    const state=x.entries.at(-1).data;
    assert.equal(state.agentAssignments.planning.planner,'forge-planner');
    assert.deepEqual(requiredAgentsFor({...state,phase:'PLAN'}),['forge-planner']);
  } finally { writeFileSync(process.env.FORGE_CONFIG_PATH,backup); }
});

test('v5.12 missing mandatory Agent definition fails before starting workflow', async () => {
  const file=join(process.env.PI_CODING_AGENT_DIR,'agents','forge-planner.md');
  const original=readFileSync(file);
  try {
    rmSync(file);
    const x=setup(); await x.events.get('session_start')({},x.ctx);
    await x.commands.get('forge').handler('Build a CRM',x.ctx);
    assert.equal(x.entries.length,0);
    assert.match(x.notifications.at(-1).message,/missing required OMP agent definitions: forge-planner/);
  } finally { writeFileSync(file, original); }
});

test('v5.12 OMP model frontmatter is untouched and Forge executes fixed names', async () => {
  const file=join(process.env.PI_CODING_AGENT_DIR,'agents','forge-planner.md');
  const old=readFileSync(file);
  try {
    writeFileSync(file,'---\nname: forge-planner\ndescription: Plan reviews\nmodel: "@review"\n---\nCreate tasks\n');
    const x=setup(); await x.events.get('session_start')({},x.ctx);
    await x.commands.get('forge').handler('agents',x.ctx);
    assert.match(x.notifications.at(-1).message,/model @review/);
    await x.commands.get('forge').handler('Build a CRM',x.ctx);
    const state=x.entries.at(-1).data;
    assert.equal(state.agentAssignments.planning.planner,'forge-planner');
  } finally { writeFileSync(file,old); }
});


// v5.13: the native proposal device is not a workspace mutation. It must not
// depend on receiving Forge's local write receipt: OMP validates the plan file.
test('v5.13: successful plan exists but lost write receipt cannot deadlock native approval', async () => {
  const x=setup();
  await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Implement feature with acceptance cases',x.ctx);
  await completeRequirement(x);
  await runCompletedAgent(x,'forge-planner');
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  const slug=x.entries.at(-1).data.slug;
  const path=`local://${slug}-plan.md`;
  // Simulate a real file successfully written by native OMP, but Forge misses
  // its tool_result event: no planWritten or PROPOSAL transition.
  assert.equal(x.entries.at(-1).data.planWritten,false);
  assert.equal(await x.events.get('tool_call')({toolName:'write',input:{path:'xd://propose',content:slug}},x.ctx),undefined);
  // The actual OMP native device verifies that the artifact exists BEFORE
  // emitting plan_review_requested. This mock stands for that native event.
  await x.events.get('plan_review_requested')({planContent:PLAN,planPath:path},x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  assert.equal(x.entries.at(-1).data.planWritten,true);
  assert.equal(x.entries.at(-1).data.planValid,true);
  assert.equal(x.entries.at(-1).data.approved,false);
  await x.events.get('plan_review_resolved')({choice:'execute'},x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'EXECUTE');
});

test('v5.13: native plan proposal bypasses only Forge stale state, not human approval or QA contract', async () => {
  const x=setup();
  await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Plan a feature',x.ctx);
  await completeRequirement(x);
  await runCompletedAgent(x,'forge-planner');
  const slug=x.entries.at(-1).data.slug;
  const path=`local://${slug}-plan.md`;
  for (const invalid of ['','local://'+slug+'-plan.md',slug+'-plan.md','../../src/main.go','a\nB']) {
    const result=await x.events.get('tool_call')({toolName:'write',input:{path:'xd://propose',content:invalid}},x.ctx);
    assert.equal(result?.block,true,'invalid proposal slug must be blocked');
  }
  assert.equal(await x.events.get('tool_call')({toolName:'write',input:{path:'xd://propose',content:slug}},x.ctx),undefined);
  assert.equal((await x.events.get('tool_call')({toolName:'write',input:{path:'xd://resolve',content:'yes'}},x.ctx))?.block,true);
  assert.equal((await x.events.get('tool_call')({toolName:'write',input:{path:'src/foo.go',content:'code'}},x.ctx))?.block,true);
  assert.equal((await x.events.get('tool_call')({toolName:'bash',input:{command:'git commit -m bad'}},x.ctx))?.block,true);
  // Simulate native review of an invalid plan: no execution.
  await x.events.get('plan_review_requested')({planContent:'# Plan\nMissing contracts',planPath:path},x.ctx);
  assert.equal(x.entries.at(-1).data.planValid,false);
  await x.events.get('plan_review_resolved')({choice:'execute'},x.ctx);
  assert.notEqual(x.entries.at(-1).data.phase,'EXECUTE');
});

test('v5.14: paused native Plan Mode after writing plan resumes only after idle and opens native review', async () => {
  const x=setup();
  await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Plan a feature',x.ctx);
  await completeRequirement(x);
  await runCompletedAgent(x,'forge-planner');
  let idle=false;
  const timers=[];
  x.ctx.isIdle=()=>idle;
  x.ctx.setTimeout=cb=>timers.push(cb);
  x.setPlan('paused');
  const state=x.entries.at(-1).data;
  const path=`local://${state.slug}-plan.md`;
  const id='v514-plan-write';
  await x.events.get('tool_call')({toolName:'write',toolCallId:id,input:{path,content:PLAN}},x.ctx);
  await x.events.get('tool_result')({toolName:'write',toolCallId:id,isError:false,content:[{type:'text',text:'Wrote plan'}]},x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  assert.equal(timers.length,1,'write completion arranges a deferred native review');
  assert.equal((await x.events.get('tool_call')({toolName:'write',input:{path:'src/index.ts',content:'bad'}},x.ctx)).block,true);
  await timers.shift()();
  assert.equal(x.getPlan(),'paused','Plan Mode must not change while OMP is busy');
  assert.equal(timers.length,1);
  idle=true;
  let firstBusy=true;
  const realSet=x.ctx.sessionModes.set;
  x.ctx.sessionModes.set=async (...args)=>firstBusy?(firstBusy=false,{ok:false,code:'busy',message:'mode switch still busy'}):realSet(...args);
  await timers.shift()();
  assert.equal(timers.length,1,'transient busy keeps recovery scheduled');
  let opened=0;
  x.ctx.openPlanReview=async()=>{
    opened++;
    await x.events.get('plan_review_requested')({planContent:PLAN,planPath:path},x.ctx);
    return true;
  };
  await timers.shift()();
  assert.equal(opened,1);
  assert.equal(x.getPlan(),'active');
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  assert.equal(x.entries.at(-1).data.approved,false,'no approval may occur without user action');
});

test('v5.14: proposal with stale write telemetry does not loop when mode paused', async () => {
  const x=setup();
  await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Plan a feature',x.ctx);
  await completeRequirement(x);
  await runCompletedAgent(x,'forge-planner');
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  x.setPlan('inactive');
  const timers=[];
  x.ctx.setTimeout=cb=>timers.push(cb);
  const slug=x.entries.at(-1).data.slug;
  const result=await x.events.get('tool_call')({toolName:'write',input:{path:'xd://propose',content:slug}},x.ctx);
  assert.equal(result.block,true);
  assert.match(result.reason,/Do NOT retry/);
  assert.equal(timers.length,1);
  x.ctx.openPlanReview=async()=>{
    await x.events.get('plan_review_requested')({planContent:PLAN,planPath:`local://${slug}-plan.md`},x.ctx);
    return true;
  };
  await timers.shift()();
  assert.equal(x.getPlan(),'active');
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  assert.equal(x.entries.at(-1).data.approved,false);
});

test('v5.14: permanent Plan Mode refusal never unlocks implementation or silently approves', async () => {
  const x=setup();
  await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Plan a feature',x.ctx);
  await completeRequirement(x);
  await runCompletedAgent(x,'forge-planner');
  x.setPlan('paused');
  const timers=[];
  x.ctx.setTimeout=cb=>timers.push(cb);
  x.ctx.sessionModes.set=async()=>({ok:false,code:'disabled',message:'Plan mode disabled'});
  const result=await x.events.get('tool_call')({toolName:'write',input:{path:'xd://propose',content:x.entries.at(-1).data.slug}},x.ctx);
  assert.equal(result.block,true);
  assert.equal(timers.length,1);
  await timers.shift()();
  assert.equal(timers.length,0,'non-retryable failure must not spin');
  assert.ok(x.notifications.some(n=>n.message.includes('Plan mode disabled')));
  assert.notEqual(x.entries.at(-1).data.phase,'EXECUTE');
  assert.equal((await x.events.get('tool_call')({toolName:'write',input:{path:'src/app.go',content:'not approved'}},x.ctx)).block,true);
});

test('v6.0: saved plan recovery survives long busy and pending-message periods', async () => {
  const x=setup();
  await reachPlanning(x);
  let idle=false, pending=false, modeCalls=0, opened=0;
  x.ctx.isIdle=()=>idle;
  x.ctx.hasPendingMessages=()=>pending;
  const realSet=x.ctx.sessionModes.set;
  x.ctx.sessionModes.set=async (...args)=>{modeCalls++; return realSet(...args);};
  const timers=[];
  x.ctx.setTimeout=cb=>timers.push(cb);
  x.setPlan('paused');
  const path=await writeCanonicalPlan(x);
  x.ctx.openPlanReview=async()=>{
    opened++;
    await x.events.get('plan_review_requested')({planContent:PLAN,planPath:path},x.ctx);
    return true;
  };
  const sentBefore=x.sent.length;
  for(let i=0;i<80;i++) await timers.shift()();
  assert.equal(timers.length,1);
  idle=true; pending=true;
  for(let i=0;i<80;i++) await timers.shift()();
  assert.equal(timers.length,1);
  assert.equal(modeCalls,0);
  assert.equal(opened,0);
  assert.equal(x.sent.length,sentBefore);
  assert.equal(x.getPlan(),'paused');
  assert.equal(x.entries.at(-1).data.proposalDeferred,true);
  assert.equal(x.notifications.some(n=>n.message.includes('session is still busy')),false);
  assert.equal((await x.events.get('tool_call')({toolName:'write',input:{path:'src/app.go',content:'blocked'}},x.ctx)).block,true);
  pending=false;
  await timers.shift()();
  assert.equal(opened,1);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  assert.equal(x.entries.at(-1).data.planPath,path);
  assert.equal(x.entries.at(-1).data.approved,false);
});

test('v6.0: lost plan-write receipt recovers after prolonged busy state', async () => {
  const x=setup();
  await reachPlanning(x);
  let idle=false, opened=0;
  x.ctx.isIdle=()=>idle;
  x.setPlan('paused');
  const timers=[];
  x.ctx.setTimeout=cb=>timers.push(cb);
  const state=x.entries.at(-1).data;
  const path=`local://${state.slug}-plan.md`;
  const result=await x.events.get('tool_call')({toolName:'write',input:{path:'xd://propose',content:state.slug}},x.ctx);
  assert.equal(result.block,true);
  x.ctx.openPlanReview=async()=>{
    opened++;
    await x.events.get('plan_review_requested')({planContent:PLAN,planPath:path},x.ctx);
    return true;
  };
  for(let i=0;i<80;i++) await timers.shift()();
  assert.equal(timers.length,1);
  assert.equal(opened,0);
  idle=true;
  await timers.shift()();
  assert.equal(opened,1);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  assert.equal(x.entries.at(-1).data.planPath,path);
  assert.equal(x.entries.at(-1).data.planWritten,true);
  assert.equal(x.entries.at(-1).data.approved,false);
});

test('v6.0: native setter busy results do not consume recovery attempts', async () => {
  const x=setup();
  await reachPlanning(x);
  x.setPlan('paused');
  const timers=[];
  x.ctx.setTimeout=cb=>timers.push(cb);
  const realSet=x.ctx.sessionModes.set;
  let calls=0, opened=0;
  x.ctx.sessionModes.set=async (...args)=>{
    calls++;
    if(calls<=80) return {ok:false,code:'busy',message:'mode switch still busy'};
    return realSet(...args);
  };
  const path=await writeCanonicalPlan(x);
  x.ctx.openPlanReview=async()=>{
    opened++;
    await x.events.get('plan_review_requested')({planContent:PLAN,planPath:path},x.ctx);
    return true;
  };
  for(let i=0;i<80;i++) await timers.shift()();
  assert.equal(calls,80);
  assert.equal(timers.length,1);
  assert.equal(opened,0);
  assert.equal(x.notifications.some(n=>n.message.includes('Plan Mode could not be activated')),false);
  await timers.shift()();
  assert.equal(calls,81);
  assert.equal(opened,1);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  assert.equal(x.entries.at(-1).data.approved,false);
});

test('v6.0: review retries count only actual opens and stop after three failures', async () => {
  const x=setup();
  await reachPlanning(x);
  let idle=false, opens=0;
  x.ctx.isIdle=()=>idle;
  const timers=[];
  x.ctx.setTimeout=cb=>timers.push(cb);
  const path=await writeCanonicalPlan(x);
  for(let i=0;i<60;i++) await timers.shift()();
  assert.equal(timers.length,1);
  idle=true;
  x.ctx.openPlanReview=async()=>{
    opens++;
    if(opens<3) return false;
    await x.events.get('plan_review_requested')({planContent:PLAN,planPath:path},x.ctx);
    return true;
  };
  for(let i=0;i<3;i++) await timers.shift()();
  assert.equal(opens,3);
  assert.equal(timers.length,0);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  assert.equal(x.entries.at(-1).data.proposalDeferred,false);
  assert.equal(x.entries.at(-1).data.approved,false);
  assert.equal(x.notifications.some(n=>n.message.includes('could not open the native Plan Review')),false);

  const y=setup();
  await reachPlanning(y);
  const retryTimers=[];
  y.ctx.setTimeout=cb=>retryTimers.push(cb);
  const retryPath=await writeCanonicalPlan(y);
  let failures=0;
  y.ctx.openPlanReview=async()=>{failures++; return false;};
  for(let i=0;i<3;i++) await retryTimers.shift()();
  assert.equal(failures,3);
  assert.equal(retryTimers.length,0);
  assert.equal(y.notifications.filter(n=>n.message.includes('could not open the native Plan Review')).length,1);
  assert.equal((await y.events.get('tool_call')({toolName:'write',input:{path:'src/app.go',content:'blocked'}},y.ctx)).block,true);
});

test('v6.0: pending native review prevents duplicate recovery operations', async () => {
  const x=setup();
  await reachPlanning(x);
  x.setPlan('paused');
  const timers=[];
  x.ctx.setTimeout=cb=>timers.push(cb);
  let modeCalls=0, opened=0;
  x.ctx.sessionModes.set=async()=>{modeCalls++; return {ok:true};};
  x.ctx.openPlanReview=async()=>{opened++; return true;};
  const slug=x.entries.at(-1).data.slug;
  await x.events.get('tool_call')({toolName:'write',input:{path:'xd://propose',content:slug}},x.ctx);
  x.ctx.getPendingPlanReview=()=>({reviewId:'already-open'});
  await timers.shift()();
  assert.equal(modeCalls,0);
  assert.equal(opened,0);
  assert.equal(timers.length,0);
  assert.equal(x.entries.at(-1).data.proposalDeferred,true);
  assert.equal((await x.events.get('tool_call')({toolName:'write',input:{path:'src/app.go',content:'blocked'}},x.ctx)).block,true);
});

test('v6.0: cancel and branch change invalidate queued recovery callbacks', async () => {
  const cancelled=setup();
  await reachPlanning(cancelled);
  cancelled.setPlan('paused');
  const cancelTimers=[];
  cancelled.ctx.setTimeout=cb=>cancelTimers.push(cb);
  let cancelModeCalls=0, cancelOpens=0;
  const cancelSet=cancelled.ctx.sessionModes.set;
  cancelled.ctx.sessionModes.set=async (...args)=>{cancelModeCalls++; return cancelSet(...args);};
  cancelled.ctx.openPlanReview=async()=>{cancelOpens++; return true;};
  await writeCanonicalPlan(cancelled);
  const staleCancel=cancelTimers[0];
  await cancelled.commands.get('forge').handler('off',cancelled.ctx);
  const cancelEntries=cancelled.entries.length, cancelMessages=cancelled.sent.length;
  await staleCancel();
  assert.equal(cancelModeCalls,0);
  assert.equal(cancelOpens,0);
  assert.equal(cancelled.entries.length,cancelEntries);
  assert.equal(cancelled.sent.length,cancelMessages);
  assert.equal(cancelled.getPlan(),'paused');

  const branched=setup();
  await reachPlanning(branched);
  branched.setPlan('paused');
  const branchTimers=[];
  branched.ctx.setTimeout=cb=>branchTimers.push(cb);
  let branchModeCalls=0, branchOpens=0;
  const branchSet=branched.ctx.sessionModes.set;
  branched.ctx.sessionModes.set=async (...args)=>{branchModeCalls++; return branchSet(...args);};
  branched.ctx.openPlanReview=async()=>{branchOpens++; return true;};
  await writeCanonicalPlan(branched);
  const staleBranch=branchTimers[0];
  branched.setBranch([]);
  await branched.events.get('session_branch')({},branched.ctx);
  const branchEntries=branched.entries.length, branchMessages=branched.sent.length;
  await staleBranch();
  assert.equal(branchModeCalls,0);
  assert.equal(branchOpens,0);
  assert.equal(branched.entries.length,branchEntries);
  assert.equal(branched.sent.length,branchMessages);
  assert.equal(branched.getPlan(),'paused');
});

test('v6.0: asynchronous recovery cannot overwrite cancellation or native review state', async () => {
  const cancelled=setup();
  await reachPlanning(cancelled);
  cancelled.setPlan('paused');
  const cancelTimers=[];
  cancelled.ctx.setTimeout=cb=>cancelTimers.push(cb);
  await writeCanonicalPlan(cancelled);
  let resolveSetter;
  cancelled.ctx.sessionModes.set=()=>new Promise(resolve=>{
    resolveSetter=result=>{cancelled.setPlan('active'); resolve(result);};
  });
  let cancelOpens=0;
  cancelled.ctx.openPlanReview=async()=>{cancelOpens++; return true;};
  const awaitingSetter=cancelTimers.shift()();
  assert.equal(typeof resolveSetter,'function');
  await cancelled.commands.get('forge').handler('off',cancelled.ctx);
  const cancelEntries=cancelled.entries.length, cancelMessages=cancelled.sent.length;
  resolveSetter({ok:true});
  await awaitingSetter;
  assert.equal(cancelOpens,0);
  assert.equal(cancelled.entries.length,cancelEntries);
  assert.equal(cancelled.sent.length,cancelMessages);

  const reviewed=setup();
  await reachPlanning(reviewed);
  reviewed.setPlan('paused');
  const reviewTimers=[];
  reviewed.ctx.setTimeout=cb=>reviewTimers.push(cb);
  const path=await writeCanonicalPlan(reviewed);
  let finishReview, enteredReview;
  const inReview=new Promise(resolve=>{enteredReview=resolve;});
  reviewed.ctx.openPlanReview=async()=>{
    await reviewed.events.get('plan_review_requested')({planContent:PLAN,planPath:path},reviewed.ctx);
    enteredReview();
    return await new Promise(resolve=>{finishReview=resolve;});
  };
  const awaitingReview=reviewTimers.shift()();
  await inReview;
  assert.equal(reviewed.entries.at(-1).data.phase,'PLAN');
  assert.equal(reviewed.entries.at(-1).data.proposalDeferred,false);
  assert.equal(reviewed.entries.at(-1).data.approved,false);
  const reviewEntries=reviewed.entries.length;
  finishReview(true);
  await awaitingReview;
  assert.equal(reviewed.entries.length,reviewEntries);
  assert.equal(reviewed.entries.at(-1).data.phase,'PLAN');
  assert.equal(reviewed.entries.at(-1).data.proposalDeferred,false);
});

test('v6.0: missing idle detection warns once and leaves approval locked', async () => {
  const x=setup();
  await reachPlanning(x);
  x.setPlan('paused');
  x.ctx.isIdle=undefined;
  const timers=[];
  x.ctx.setTimeout=cb=>timers.push(cb);
  const path=await writeCanonicalPlan(x);
  assert.equal(timers.length,0);
  assert.equal(x.notifications.filter(n=>n.message.includes('Native OMP idle detection is unavailable')).length,1);
  assert.equal(x.entries.at(-1).data.planPath,path);
  assert.equal(x.entries.at(-1).data.proposalDeferred,true);
  assert.equal(x.getPlan(),'paused');
  assert.equal((await x.events.get('tool_call')({toolName:'write',input:{path:'src/app.go',content:'blocked'}},x.ctx)).block,true);
});

test('v5.14: resume old PLAN_MODE_BLOCKED session with saved plan directly into native review', async () => {
  const x=setup();
  await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Plan a feature',x.ctx);
  await completeRequirement(x);
  await runCompletedAgent(x,'forge-planner');
  await writeCanonicalPlan(x);
  const blocked={...x.entries.at(-1).data,phase:'PLAN_MODE_BLOCKED',active:false,blockedFrom:'PROPOSAL'};
  x.entries.push({type:'custom',customType:'dev.omp-forge.workflow.v1',data:blocked});
  x.setPlan('paused');
  await x.events.get('session_start')({},x.ctx);
  let opened=0;
  x.ctx.openPlanReview=async()=>{
    opened++;
    await x.events.get('plan_review_requested')({planContent:PLAN,planPath:blocked.planPath},x.ctx);
    return true;
  };
  await x.commands.get('forge').handler('resume current',x.ctx);
  assert.equal(opened,1);
  assert.equal(x.getPlan(),'active');
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  assert.equal(x.entries.at(-1).data.approved,false);
});

test('v5.18: QA BLOCKED keeps approved plan and pauses for evidence instead of automatic rework', async () => {
  const x = setup(); await advanceToReview(x);
  await x.events.get('plan_review_resolved')({choice:'execute'},x.ctx);
  x.setPlan('inactive'); await x.events.get('agent_start')({},x.ctx);
  await runCompletedAgent(x,'forge-executor'); await x.events.get('session_stop')({},x.ctx);
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
  await x.events.get('plan_review_resolved')({choice:'execute'},x.ctx);
  x.setPlan('inactive'); await x.events.get('agent_start')({},x.ctx);
  await runCompletedAgent(x,'forge-executor'); await x.events.get('session_stop')({},x.ctx);
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
  await x.events.get('plan_review_resolved')({choice:'execute'},x.ctx);
  x.setPlan('inactive'); await x.events.get('agent_start')({},x.ctx);
  await runCompletedAgent(x,'forge-executor'); await x.events.get('session_stop')({},x.ctx);
  x.ctx.cwd=tmp; // tmp is not a git repo
  const during=await x.tools.get('forge_qa_scope').execute('call',{},null,null,x.ctx);
  assert.equal(during.isError,undefined);
  assert.equal(during.details.available,false);
  assert.match(during.details.reason,/Git status\/diff inventory unavailable/);
});

test('v5.18: explicit rework after evidence block needs Plan Mode and retains approval on failure',async()=>{
  const x=setup(); await advanceToReview(x);
  await x.events.get('plan_review_resolved')({choice:'execute'},x.ctx);
  x.setPlan('inactive'); await x.events.get('agent_start')({},x.ctx);
  await runCompletedAgent(x,'forge-executor'); await x.events.get('session_stop')({},x.ctx);
  await runQaAgents(x);
  const blocked=structuredClone(SUBMISSION); blocked.codeQualityChecks[0].status='NOT_RUN';
  await x.tools.get('forge_qa_submit').execute('call',blocked,null,null,x.ctx);
  const approved=x.entries.at(-1).data.approvedPlanHash;
  x.ctx.sessionModes.set=async()=>({ok:false,message:'session is busy'});
  await x.commands.get('forge').handler('rework',x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'QA');
  assert.equal(x.entries.at(-1).data.approvedPlanHash,approved);
  x.ctx.sessionModes.set=async()=>({ok:true});
  await x.commands.get('forge').handler('rework',x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  assert.equal(x.entries.at(-1).data.approved,false);
  assert.equal(x.entries.at(-1).data.reworkCycles,1);
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
  await x.events.get('plan_review_resolved')({choice:'execute'},x.ctx);
  x.setPlan('inactive'); await x.events.get('agent_start')({},x.ctx);
  await runCompletedAgent(x,'forge-executor'); await x.events.get('session_stop')({},x.ctx);
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
  await x.events.get('plan_review_resolved')({choice:'execute'},x.ctx);
  x.setPlan('inactive'); await x.events.get('agent_start')({},x.ctx);
  await runCompletedAgent(x,'forge-executor'); await x.events.get('session_stop')({},x.ctx);
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

test('v5.20: native Plan Mode recovery asks and changes only OMP mode',async()=>{
  const x=setup(); await advanceToReview(x);
  const previous=x.entries.at(-1).data;
  x.entries.push({type:'custom',customType:'dev.omp-forge.workflow.v1',data:{...previous,phase:'REWORK_PLANNING',approved:false,planWritten:false,planPath:null,active:true}});
  x.setPlan('inactive');
  x.ctx.ui.select=async(_label,options)=>options[0];
  await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('recover',x.ctx);
  assert.equal(x.getPlan(),'active');
  assert.equal(x.entries.at(-1).data.phase,'REWORK_PLANNING', 'mode-only recovery leaves the historical entry untouched');
  assert.equal(x.entries.at(-1).data.approved,false);
  await x.commands.get('forge').handler('status',x.ctx);
  assert.match(x.notifications.at(-1).message,/Forge: PLAN/);
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

// v5.21: after OMP's native Plan Mode exits, a persistent footer status must
// identify the actual Forge Gate; the old transient editor widget is removed.
test('v5.21: native plan review exit restores Forge EXECUTION status in the footer', async () => {
  const x=setup();
  const footer=[]; const widgets=[];
  x.ctx.ui.setStatus=(key,value)=>footer.push({key,value});
  x.ctx.ui.setWidget=(key,value)=>widgets.push({key,value});
  await x.events.get('session_start')({},x.ctx);
  await advanceToReview(x);
  assert.equal(footer.at(-1).value,undefined,'approval overlay owns the UI');
  await x.events.get('plan_review_resolved')({choice:'execute'},x.ctx);
  assert.match(footer.at(-1).value,/Execution 3\/4/);
  assert.equal(widgets.at(-1).value,undefined,'legacy above-editor status was removed');
  x.setPlan('inactive');
  // Emulate the native terminal clearing the footer while leaving Plan Mode.
  footer.length=0;
  await x.events.get('agent_start')({},x.ctx);
  assert.match(footer.at(-1).value,/Execution 3\/4/);
  assert.equal(x.entries.at(-1).data.phase,'EXECUTE');
  footer.length=0;
  await x.events.get('agent_end')({},x.ctx);
  assert.match(footer.at(-1).value,/Execution 3\/4/);
});

test('v5.21: QA transition and session lifecycle refresh footer without changing approval state', async () => {
  const x=setup(); const statuses=[];
  x.ctx.ui.setStatus=(key,value)=>statuses.push({key,value});
  await x.events.get('session_start')({},x.ctx);
  await advanceToReview(x);
  await x.events.get('plan_review_resolved')({choice:'execute'},x.ctx);
  x.setPlan('inactive');
  await x.events.get('agent_start')({},x.ctx);
  await runCompletedAgent(x,'forge-executor');
  await x.events.get('session_stop')({},x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'QA');
  assert.equal(x.entries.at(-1).data.approved,true);
  assert.match(statuses.at(-1).value,/QA review 4\/4/);
  // A re-render must not append new checkpoints or advance the Gate.
  const n=x.entries.length;
  await x.events.get('agent_end')({},x.ctx);
  assert.equal(x.entries.length,n);
  assert.match(statuses.at(-1).value,/QA review 4\/4/);
});

test('v5.21: status widget fallback still works when OMP footer API is unavailable', async () => {
  const x=setup(); const widgets=[];
  x.ctx.ui.setWidget=(key,value)=>widgets.push({key,value});
  await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('A booking system',x.ctx);
  assert.match(widgets.at(-1).value[0],/Requirement/);
});


// Simulates a branch switch long after approval (no in-process handoff).
async function laterBranchSwitch(x, eventName='session_tree') {
  const realNow = Date.now;
  Date.now = () => realNow() + 60_000;
  try { await x.events.get(eventName)({},x.ctx); } finally { Date.now = realNow; }
}

test('v5.22: later branch switch without Forge entries shows recovery, not inactive', async () => {
  const x=setup({persistentSession:true}); await advanceToReview(x);
  await x.events.get('plan_review_resolved')({choice:'execute'},x.ctx);
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
  await x.events.get('plan_review_resolved')({choice:'execute'},x.ctx);
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

test('v5.23: approval-driven branch switch carries the fresh approval forward (no recovery loop)', async () => {
  const x=setup({persistentSession:true}); await advanceToReview(x);
  await x.events.get('plan_review_resolved')({choice:'execute'},x.ctx);
  const approved=x.entries.at(-1).data;
  const newBranch=[]; x.setBranch(newBranch);
  // the mock appends to `entries`; mirror the write onto the new branch like OMP would
  const before=x.entries.length;
  await x.events.get('session_tree')({},x.ctx);
  const carried=x.entries.at(-1).data;
  assert.equal(x.entries.length,before+1);
  assert.equal(carried.phase,'EXECUTE');
  assert.equal(carried.approved,true);
  assert.equal(carried.approvedPlanHash,approved.approvedPlanHash);
  assert.equal(carried.recoveryAudit.at(-1).reason,'plan-approval-branch-handoff');
  newBranch.push(x.entries.at(-1));
  await x.commands.get('forge').handler('status',x.ctx);
  assert.match(x.notifications.at(-1).message,/Forge: EXECUTE/);
  assert.doesNotMatch(x.notifications.at(-1).message,/RECOVERY_AVAILABLE/);
});

test('v5.23: approval handoff is single-use and survives an executionObserved write', async () => {
  const x=setup({persistentSession:true}); await advanceToReview(x);
  await x.events.get('plan_review_resolved')({choice:'execute'},x.ctx);
  await x.events.get('agent_start')({},x.ctx); // executionObserved on the approving branch
  // an event on the SAME branch must not consume the handoff
  await x.events.get('session_branch')({},x.ctx);
  x.setBranch([]); await x.events.get('session_tree')({},x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'EXECUTE');
  assert.equal(x.entries.at(-1).data.executionObserved,true);
  // consumed: a second empty branch falls back to human recovery
  x.setBranch([]); await x.events.get('session_tree')({},x.ctx);
  await x.commands.get('forge').handler('status',x.ctx);
  assert.match(x.notifications.at(-1).message,/RECOVERY_AVAILABLE/);
});

test('v5.23: handoff never overrides a tombstone or a different session', async () => {
  const x=setup({persistentSession:true}); await advanceToReview(x);
  await x.events.get('plan_review_resolved')({choice:'execute'},x.ctx);
  x.setBranch([{type:'custom',customType:'dev.omp-forge.workflow.v1',data:{active:false,version:9}}]);
  await x.events.get('session_tree')({},x.ctx);
  await x.commands.get('forge').handler('status',x.ctx);
  assert.match(x.notifications.at(-1).message,/Forge: inactive/);

  const y=setup({persistentSession:true}); await advanceToReview(y);
  await y.events.get('plan_review_resolved')({choice:'execute'},y.ctx);
  y.ctx.sessionManager.getSessionId=()=> 'another-session';
  y.setBranch([]); await y.events.get('session_switch')({},y.ctx);
  assert.notEqual(y.entries.at(-1).data.recoveryAudit?.at(-1)?.reason,'plan-approval-branch-handoff');
});

test('v5.23: refine/dismiss never arms a handoff', async () => {
  const x=setup({persistentSession:true}); await advanceToReview(x);
  await x.events.get('plan_review_resolved')({choice:'refine'},x.ctx);
  const n=x.entries.length;
  x.setBranch([]); await x.events.get('session_tree')({},x.ctx);
  assert.equal(x.entries.length,n);
});

test('v5.23: unresolved orphaned workflow pauses edits/shell/subagents and blocks Git', async () => {
  const x=setup({persistentSession:true}); await advanceToReview(x);
  await x.events.get('plan_review_resolved')({choice:'execute'},x.ctx);
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
  await x.events.get('plan_review_resolved')({choice:'execute'},x.ctx);
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
  assert.match(x.notifications.at(-1).message,/RECOVERY_AVAILABLE \| previousGate: REQUIREMENT/);
  x.ctx.ui.select=async (_t,o)=>o[0];
  await x.commands.get('forge').handler('recover',x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'REQUIREMENT');
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
  assert.match(offered[3],/older workflow: REQUIREMENT .*First workflow/);
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

// ---------------------------------------------------------------- v5.24
// OMP v19 "Approve and execute" = handleClearCommand(): NEW session, then
// session_switch{reason:'new', previousSessionFile}. Verified against
// @oh-my-pi/pi-coding-agent@19.0.1 interactive-mode.ts #approvePlan.

async function reviewWithId(x, reviewId='rev-1') {
  await advanceToReview(x);
  const slug=x.entries.at(-1).data.slug;
  await x.events.get('plan_review_requested')({reviewId, sessionId:x.ctx.sessionManager.getSessionId(), planContent:PLAN, planPath:`local://${slug}-plan.md`, planFilePath:`local://${slug}-plan.md`},x.ctx);
  return slug;
}
function switchToNewSession(x, {file}={}) {
  const previousSessionFile=x.ctx.sessionManager.getSessionFile();
  const newBranch=[];
  const newFile=file ?? previousSessionFile.replace(/\.jsonl$/,'-exec.jsonl');
  x.ctx.sessionManager={ getBranch:()=>newBranch, getEntries:()=>newBranch, getSessionId:()=> 'exec-'+Math.random().toString(36).slice(2), getSessionFile:()=>newFile };
  x.setBranch(newBranch);
  return {previousSessionFile, newBranch};
}

test('v5.24: order A — resolved(execute) then OMP new session: Forge follows as EXECUTING', async () => {
  const x=setup({persistentSession:true}); await reviewWithId(x);
  await x.events.get('plan_review_resolved')({reviewId:'rev-1',choice:'execute'},x.ctx);
  const approvedHash=x.entries.at(-1).data.approvedPlanHash;
  const {previousSessionFile,newBranch}=switchToNewSession(x);
  await x.events.get('session_switch')({reason:'new',previousSessionFile},x.ctx);
  const carried=x.entries.at(-1).data; newBranch.push(x.entries.at(-1));
  assert.equal(carried.phase,'EXECUTE');
  assert.equal(carried.approved,true);
  assert.equal(carried.approvedPlanHash,approvedHash);
  assert.equal(carried.recoveryAudit.at(-1).reason,'plan-approval-new-session-handoff');
  const gate=await x.events.get('before_agent_start')({},x.ctx);
  assert.equal(gate.message.customType,'forge-execution-gate-v5');
  await x.commands.get('forge').handler('status',x.ctx);
  assert.match(x.notifications.at(-1).message,/Forge: EXECUTE/);
});

test('v5.24: order B — new session before resolved: carried as AWAITING_APPROVAL, then approved by resolved', async () => {
  const x=setup({persistentSession:true}); await reviewWithId(x);
  const {previousSessionFile,newBranch}=switchToNewSession(x);
  await x.events.get('session_switch')({reason:'new',previousSessionFile},x.ctx);
  let w=x.entries.at(-1).data; newBranch.push(x.entries.at(-1));
  assert.equal(w.phase,'PLAN');
  assert.equal(w.approved,false);
  assert.equal(w.nativeApprovalPending.reviewId,'rev-1');
  assert.equal((await x.events.get('tool_call')({toolName:'write',input:{path:'lib/main.dart'}},x.ctx)).block,true);
  // a different review's result is ignored
  await x.events.get('plan_review_resolved')({reviewId:'other',choice:'execute'},x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  await x.events.get('plan_review_resolved')({reviewId:'rev-1',choice:'execute'},x.ctx);
  w=x.entries.at(-1).data;
  assert.equal(w.phase,'EXECUTE');
  assert.equal(w.approved,true);
  assert.equal(w.nativeApprovalPending,null);
});

test('v5.24: order B race — OMP approval mode_change entry promotes before resolved arrives', async () => {
  const x=setup({persistentSession:true}); const slug=await reviewWithId(x);
  const {previousSessionFile,newBranch}=switchToNewSession(x);
  await x.events.get('session_switch')({reason:'new',previousSessionFile},x.ctx);
  newBranch.push(x.entries.at(-1));
  newBranch.push({type:'mode_change',mode:'none',data:{approvedPlanFilePath:`local://${slug}-plan.md`}});
  const gate=await x.events.get('before_agent_start')({},x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'EXECUTE');
  assert.equal(x.entries.at(-1).data.recoveryAudit.at(-1).reason,'native-approval-mode-change-entry');
  assert.equal(gate.message.customType,'forge-execution-gate-v5');
});

test('v5.24: approval entry for a DIFFERENT plan file never promotes', async () => {
  const x=setup({persistentSession:true}); await reviewWithId(x);
  const {previousSessionFile,newBranch}=switchToNewSession(x);
  await x.events.get('session_switch')({reason:'new',previousSessionFile},x.ctx);
  newBranch.push(x.entries.at(-1));
  newBranch.push({type:'mode_change',mode:'none',data:{approvedPlanFilePath:'local://other-plan.md'}});
  await x.events.get('before_agent_start')({},x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
});

test('v5.24: plain /new (no open review, no approval) does not carry Forge', async () => {
  const x=setup({persistentSession:true}); await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('A feature request',x.ctx);
  const n=x.entries.length;
  const {previousSessionFile}=switchToNewSession(x);
  await x.events.get('session_switch')({reason:'new',previousSessionFile},x.ctx);
  assert.equal(x.entries.length,n);
});

test('v5.24: new session from an unrelated file or a refine does not carry', async () => {
  const x=setup({persistentSession:true}); await reviewWithId(x);
  await x.events.get('plan_review_resolved')({reviewId:'rev-1',choice:'execute'},x.ctx);
  const n=x.entries.length;
  switchToNewSession(x);
  await x.events.get('session_switch')({reason:'new',previousSessionFile:'/elsewhere/unrelated.jsonl'},x.ctx);
  assert.equal(x.entries.length,n);

  const y=setup({persistentSession:true}); await reviewWithId(y);
  await y.events.get('plan_review_resolved')({reviewId:'rev-1',choice:'refine'},y.ctx);
  const m=y.entries.length;
  const {previousSessionFile}=switchToNewSession(y);
  await y.events.get('session_switch')({reason:'new',previousSessionFile},y.ctx);
  assert.equal(y.entries.length,m);
});

test('v5.24: stale approval handoff (>60s) does not carry', async () => {
  const x=setup({persistentSession:true}); await reviewWithId(x);
  await x.events.get('plan_review_resolved')({reviewId:'rev-1',choice:'execute'},x.ctx);
  const n=x.entries.length;
  const {previousSessionFile}=switchToNewSession(x);
  const realNow=Date.now; Date.now=()=>realNow()+120_000;
  try { await x.events.get('session_switch')({reason:'new',previousSessionFile},x.ctx); } finally { Date.now=realNow; }
  assert.equal(x.entries.length,n);
});

test('v5.24: plan_review_requested records OMP planFilePath without changing the Forge write pin', async () => {
  const x=setup({persistentSession:true}); const slug=await reviewWithId(x);
  const w=x.entries.at(-1).data;
  assert.equal(w.nativePlanFilePath,`local://${slug}-plan.md`);
  assert.equal(w.planPath,`local://${slug}-plan.md`);
});

// ---------------------------------------------------------------- v6.1 single-pass requirement
const LOW_SUMMARY = {
  baseline: 'Goal: CRM contacts. Scope: create/list contacts. Non-goals: billing. Acceptance: contact saved and listed.',
  findings: [{severity:'MEDIUM', title:'Duplicate email handling unspecified', source:'forge-requirement'}, {severity:'LOW', title:'Sort order default'}],
  assumptions: ['Emails are unique per tenant'], relevantFiles: ['src/contacts.ts'],
};

async function runAgentWithText(x, agent, text) {
  const id=`task-${++agentCallSeq}`;
  await x.events.get('tool_call')({toolName:'task',toolCallId:id,input:{agent,task:'Analyze'}},x.ctx);
  await x.events.get('before_subagent_spawn')({agent},x.ctx);
  return x.events.get('tool_result')({toolName:'task',toolCallId:id,isError:false,content:[{type:'text',text}]},x.ctx);
}

test('v6.1: summary cannot silently drop the report\'s CRITICAL/HIGH findings', async () => {
  const x=setup(); await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Create a CRM',x.ctx);
  await runAgentWithText(x,'forge-requirement','- [HIGH][fact] Contacts table has no tenant column (src/db.ts:12)\n- [LOW][assumption] naming');
  const r=await submitSummary(x,LOW_SUMMARY);
  assert.equal(r.isError,true);
  assert.match(r.content[0].text,/the requirement report contains 0 CRITICAL and 1 HIGH label\(s\), but the summary lists no CRITICAL\/HIGH finding/);
  assert.equal(x.entries.at(-1).data.phase,'REQUIREMENT');
  assert.equal(x.entries.at(-1).data.requirementSummary ?? null,null);
  const ok=await submitSummary(x,{...LOW_SUMMARY, findings:[...LOW_SUMMARY.findings,{severity:'HIGH',title:'No tenant column'}]});
  assert.notEqual(ok.isError,true);
  assert.match(ok.content[0].text,/^Forge: requirement summary recorded \(1 CRITICAL\/HIGH, 0 open blocker\(s\)\) → Planning\./);
  assert.match(ok.content[0].text,/\[HIGH\] No tenant column/);
  const w=x.entries.at(-1).data;
  assert.equal(w.phase,'PLAN');
  assert.deepEqual(w.requirementSummary.specialistSeverities,{critical:0,high:1});
});

test('v6.1: summary is rejected before the report, with bad severity or a too-short baseline', async () => {
  const x=setup(); await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Create a CRM',x.ctx);
  let r=await submitSummary(x,LOW_SUMMARY);
  assert.equal(r.isError,true);
  assert.match(r.content[0].text,/requirement report missing: run forge-requirement once and await its report first\./);
  await runCompletedAgent(x,'forge-requirement');
  r=await submitSummary(x,{...LOW_SUMMARY, findings:[{severity:'URGENT', title:'x'}]});
  assert.equal(r.isError,true);
  assert.match(r.content[0].text,/Finding 1 needs severity CRITICAL\|HIGH\|MEDIUM\|LOW\./);
  r=await submitSummary(x,{...LOW_SUMMARY, baseline:'too short'});
  assert.equal(r.isError,true);
  assert.match(r.content[0].text,/Requirement summary needs a baseline/);
  assert.equal(x.entries.at(-1).data.phase,'REQUIREMENT');
  r=await submitSummary(x,LOW_SUMMARY);
  assert.notEqual(r.isError,true);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
});

test('v6.1: session_stop asks for the summary at most twice instead of stalling or blocking', async () => {
  const x=setup(); await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Create a CRM',x.ctx);
  await runCompletedAgent(x,'forge-requirement');
  for (let i=0;i<2;i++) {
    const stop=await x.events.get('session_stop')({},x.ctx);
    assert.equal(stop.continue,true);
    assert.match(stop.additionalContext,/^\[FORGE REQUIREMENT — report received\][\s\S]*forge_requirement_summary/);
  }
  assert.equal(await x.events.get('session_stop')({},x.ctx),undefined);
  const w=x.entries.at(-1).data;
  assert.equal(w.phase,'REQUIREMENT');
  assert.equal(w.active,true);
  assert.equal(w.agentRetries['REQUIREMENT:summary'],2);
  assert.notEqual((await submitSummary(x,LOW_SUMMARY)).isError,true);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
});

test('v6.1: unknown tools remain blocked in REQUIREMENT', async () => {
  const x=setup(); await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Create a CRM',x.ctx);
  assert.equal((await x.events.get('tool_call')({toolName:'mystery_tool',input:{}},x.ctx)).block,true);
  assert.equal((await x.events.get('tool_call')({toolName:'write',input:{path:'src/a.ts'}},x.ctx)).block,true);
});

test('v6.1: removed mode words are plain requirement text', async () => {
  const x=setup(); await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('quick Fix x',x.ctx);
  const w=x.entries.at(-1).data;
  assert.equal(w.phase,'REQUIREMENT');
  assert.equal(w.requirement,'quick Fix x');
  assert.equal('requirementMode' in w,false);
  assert.deepEqual(requiredAgentsFor(w),['forge-requirement']);
  assert.ok(x.notifications.some(n=>n.message==='Forge: REQUIREMENT (one forge-requirement pass + your review) → Planning → Approval → Execute → QA → Delivery'));
  assert.ok(!x.notifications.some(n=>/LOW RIGOR|requirement mode/i.test(n.message)));
});

test('v6.1: requirement synthesis survives native approval into execution', async () => {
  const x=setup(); await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Create a CRM',x.ctx);
  await completeRequirement(x,LOW_SUMMARY);
  await runCompletedAgent(x,'forge-planner');
  await writeCanonicalPlan(x);
  await x.events.get('plan_review_requested')({planContent:PLAN,planPath:`local://${x.entries.at(-1).data.slug}-plan.md`},x.ctx);
  await x.events.get('plan_review_resolved')({choice:'keep'},x.ctx);
  const w=x.entries.at(-1).data;
  assert.equal(w.phase,'EXECUTE'); assert.equal(w.approved,true);
  assert.equal(w.requirementSummary.baseline.startsWith('Goal: CRM'),true);
});

test('four persisted phases preserve explicit approval and read-only QA', async () => {
  const x=setup(); await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Create a CRM',x.ctx);
  await completeRequirement(x,LOW_SUMMARY);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  await runCompletedAgent(x,'forge-planner');
  await writeCanonicalPlan(x);
  await x.events.get('plan_review_requested')({reviewId:'four-gates',planContent:PLAN,planPath:`local://${x.entries.at(-1).data.slug}-plan.md`},x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  assert.equal(x.entries.at(-1).data.approved,false);
  assert.equal((await x.events.get('tool_call')({toolName:'write',input:{path:'src/a.ts'}},x.ctx)).block,true);
  await x.events.get('plan_review_resolved')({reviewId:'four-gates',choice:'keep'},x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'EXECUTE');
  x.setPlan('inactive'); await x.events.get('agent_start')({},x.ctx);
  await runCompletedAgent(x,'forge-executor');
  await x.events.get('session_stop')({},x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'QA');
  assert.equal((await x.events.get('tool_call')({toolName:'write',input:{path:'src/a.ts'}},x.ctx)).block,true);
  assert.ok(x.entries.filter(e=>e.customType==='dev.omp-forge.workflow.v1' && e.data).every(e=>['REQUIREMENT','PLAN','EXECUTE','QA'].includes(e.data.phase)));
});

test('native review cannot replace a completed planner report', async () => {
  const x=setup(); await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Create a CRM',x.ctx);
  await completeRequirement(x);
  await x.events.get('plan_review_requested')({reviewId:'no-planner',planContent:PLAN},x.ctx);
  assert.equal(x.entries.at(-1).data.planValid,false);
  await x.events.get('plan_review_resolved')({reviewId:'no-planner',choice:'execute'},x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'PLAN');
  assert.equal(x.entries.at(-1).data.approved,false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync, writeFileSync, copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import forgeExtension from '../forge/index.ts';
import {GATE_AGENTS, requiredAgentsFor, migrateLegacyRequirementState} from '../forge/core.mjs';

const tmp = mkdtempSync(join(tmpdir(),'omp-forge-tests-'));
process.env.FORGE_REPORT_DIR = tmp;
process.env.FORGE_CONFIG_PATH = join(tmp, 'test-forge-config.json');
process.env.PI_CODING_AGENT_DIR = join(tmp, 'agent-home');
mkdirSync(join(process.env.PI_CODING_AGENT_DIR, 'agents'), {recursive:true});
for (const name of ['forge-requirement','forge-critic','forge-architect','forge-qa-strategist','forge-planner','forge-executor','forge-qa','forge-code-reviewer','forge-delivery','my-planner','my-critic','my-qa','my-code-reviewer','my-executor']) {
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR,'agents',`${name}.md`),'---\nname: '+name+'\ndescription: Custom specialist\n---\nTest specialist\n');
}
writeFileSync(process.env.FORGE_CONFIG_PATH, JSON.stringify({autoStart:false, requirementMode:'thorough'})+'\n');
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
  assert.equal(x.entries.at(-1).data.phase,'PROPOSAL');
  assert.match(result.additionalContext,/FORGE PLAN SAVED/);
  return path;
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
  assert.match(x.sent[0].content,/GATE 1\/6: REQUIREMENT — discovery step 1\/3/);
  const expected = ['REQUIREMENT:COOKING','REQUIREMENT:CHALLENGE','PLANNING'];
  for (let i=0;i<3;i++) {
    const state = x.entries.at(-1).data;
    let transition;
    for (const agent of requiredAgentsFor(state)) transition=await runCompletedAgent(x,agent);
    const next = x.entries.at(-1).data;
    assert.equal(next.phase === 'REQUIREMENT' ? `REQUIREMENT:${next.requirementStep}` : next.phase, expected[i]);
    assert.match(transition.additionalContext, i === 2 ? /GATE 2\/6: PLANNING/ : /GATE 1\/6: REQUIREMENT/);
  }
  await runCompletedAgent(x,'forge-planner');
  await writeCanonicalPlan(x);
  await x.events.get('plan_review_requested')({planContent:PLAN,planPath:`local://${x.entries.at(-1).data.slug}-plan.md`},x.ctx);
  assert.equal(x.entries.at(-1).data.businessTopics.length,2);
  assert.equal(x.entries.at(-1).data.requirements.length,2);
  assert.equal(x.entries.at(-1).data.qualityGates.length,2);
}

test('global chain runs planning and after native approval starts execution then QA', async () => {
  const x=setup();
  await advanceToReview(x);
  await x.events.get('plan_review_resolved')({choice:'execute'},x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'EXECUTING');
  assert.equal(x.entries.at(-1).data.active,true);
  x.setPlan('inactive');
  assert.equal(await x.events.get('session_stop')({},x.ctx),undefined,'not yet observed execution');
  await x.events.get('agent_start')({},x.ctx);
  await runCompletedAgent(x,'forge-executor');
  const qa=await x.events.get('session_stop')({},x.ctx);
  assert.equal(qa.continue,true);
  assert.match(qa.additionalContext,/POST-EXECUTION QA REVIEW/);
  assert.match(qa.additionalContext,/BIZ-002: Approval/);
  assert.equal(x.entries.at(-1).data.phase,'QA_REVIEW');
  assert.equal((await x.events.get('tool_call')({toolName:'write',input:{path:'src/service.ts'}},x.ctx)).block,true);
  assert.equal((await x.events.get('tool_call')({toolName:'bash',input:{command:'rm -rf .'}},x.ctx)).block,true);
  assert.equal(await x.events.get('tool_call')({toolName:'bash',input:{command:'npm run lint'}},x.ctx),undefined);
  await runQaAgents(x);
  const result=await x.tools.get('forge_qa_submit').execute('call',SUBMISSION,null,null,x.ctx);
  assert.match(result.content[0].text,/GATE: PASS/);
  assert.equal(x.entries.at(-1).data.phase,'DELIVERY_PREP');
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
  assert.equal(x.entries.at(-1).data.phase,'REWORK_PLANNING');
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
  assert.equal(x.entries.at(-1).data.phase,'QA_EVIDENCE_PENDING');
  assert.equal(x.entries.at(-1).data.active,true);
  assert.equal(x.entries.at(-1).data.approved,true, 'approval must be retained for evidence-only blockers');
  assert.ok(x.entries.at(-1).data.approvedPlanHash);
});

test('dismissed plan review does not authorize execution', async () => {
  const x=setup(); await advanceToReview(x);
  await x.events.get('plan_review_resolved')({choice:undefined},x.ctx);
  assert.equal(x.entries.at(-1).data.approved,false);
  assert.equal(x.entries.at(-1).data.phase,'AWAITING_APPROVAL');
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
  for (const tool of ['read','grep','glob','task','ask']) assert.equal(await hook({toolName:tool,input:{}},x.ctx),undefined,tool);
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
  assert.equal(x.entries.at(-1).data.phase,'DELIVERY');
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
  assert.equal(x.entries.at(-1).data.phase,'REWORK_PLANNING');
  assert.equal(x.entries.at(-1).data.reworkCycles,1);
  assert.equal((await x.events.get('tool_call')({toolName:'edit',input:{path:'src/booking.ts'}},x.ctx)).block,true);
  assert.equal(await x.events.get('session_stop')({},x.ctx),undefined,'rework waits safely until native Plan Mode can be activated');
  x.setPlan('active');
  const rework=await x.events.get('session_stop')({},x.ctx);
  assert.equal(rework.continue,true);
  assert.match(rework.additionalContext,/QA FAILED: REWORK PLAN/);
  assert.match(rework.additionalContext,/qa-report.md/);
  assert.equal(x.getPlan(),'active');
  assert.equal(x.entries.at(-1).data.phase,'REWORK_PLANNING');
  await runCompletedAgent(x,'forge-planner');
  await writeCanonicalPlan(x,'local://forge-rework-v2-plan.md');
  await x.events.get('plan_review_requested')({planContent:PLAN,planPath:'local://forge-rework-v2-plan.md'},x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'AWAITING_APPROVAL');
  assert.equal(x.entries.at(-1).data.approved,false);
  // Refine is not approval; it loops to planning.
  await x.events.get('plan_review_resolved')({choice:'refine'},x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'PLANNING');
  assert.equal(x.entries.at(-1).data.approved,false);
  await runCompletedAgent(x,'forge-planner');
  await writeCanonicalPlan(x,'local://forge-rework-v2-plan.md');
  await x.events.get('plan_review_requested')({planContent:PLAN+'\n## Rework fix\n- Remove duplicate booking\n',planPath:'local://forge-rework-v2-plan.md'},x.ctx);
  await x.events.get('plan_review_resolved')({choice:'keep'},x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'EXECUTING');
  assert.equal(x.entries.at(-1).data.approved,true);
  assert.equal(x.entries.at(-1).data.reworkCycles,1);
});

test('delivery cannot be prepared before QA PASS', async () => {
  const x=setup(); await advanceToReview(x);
  const result=await x.tools.get('forge_delivery_submit').execute('call',{subject:'feat: add booking',body:'',highlights:[],changedFiles:[]},null,null,x.ctx);
  assert.equal(result.isError,true);
  assert.equal(x.entries.at(-1).data.phase,'AWAITING_APPROVAL');
});

test('required gate agents are enforced and wrong agent is blocked', async () => {
  const x=setup(); await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Create a CRM',x.ctx);
  const blocked=await x.events.get('before_subagent_spawn')({agent:'executor'},x.ctx);
  assert.equal(blocked.block,true);
  assert.match(blocked.reason,/forge-requirement/);
  let next=await x.events.get('session_stop')({},x.ctx);
  assert.equal(next.continue,true);
  assert.match(next.additionalContext,/forge-requirement/);
  next=await x.events.get('session_stop')({},x.ctx);
  assert.equal(next,undefined);
  assert.equal(x.entries.at(-1).data.phase,'AGENTS_BLOCKED');
  assert.equal(x.entries.at(-1).data.active,false);
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
  assert.equal(x.entries.at(-1).data.phase,'QA_REVIEW');
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
  assert.equal(x.entries.at(-1).data.requirementStep,'DISCOVERY');
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
  assert.equal(x.entries.at(-1).data.requirementStep,'DISCOVERY');
});

test('v5 invalid native plan review cannot authorize execution', async () => {
  const x=setup(); await advanceToReview(x);
  await x.events.get('plan_review_requested')({reviewId:'invalid-review',planContent:'# Plan\nNo test cases',planPath:'local://broken.md'},x.ctx);
  assert.equal(x.entries.at(-1).data.planValid,false);
  await x.events.get('plan_review_resolved')({choice:'execute'},x.ctx);
  assert.equal(x.entries.at(-1).data.approved,false);
  assert.equal(x.entries.at(-1).data.phase,'AWAITING_APPROVAL');
});

test('v5 disallows Git writes in a Forge subagent session', async () => {
  const x=setup();
  const sub={...x.ctx,agent:{kind:'sub',name:'forge-executor'}};
  const forbidden=await x.events.get('tool_call')({toolName:'bash',input:{command:'git commit -m done'}},sub);
  assert.equal(forbidden.block,true);
  const qa={...x.ctx,agent:{kind:'sub',name:'forge-qa'}};
  assert.equal((await x.events.get('tool_call')({toolName:'write',input:{path:'src/x.ts'}},qa)).block,true);
});


test('v5.1 regression: OMP Plan Mode inactive cannot deadlock read-only Discovery and required task', async () => {
  const x=setup(); await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Change debit card enum references',x.ctx);
  x.setPlan('inactive'); // OMP mode transition between turns/subagent entry
  for (const tool of ['read','grep','glob','ask','task']) {
    const outcome = await x.events.get('tool_call')({toolName:tool,input:{path:'src/operations.ts'}},x.ctx);
    assert.notEqual(outcome?.block,true,`${tool} must work even when plan is inactive`);
  }
  assert.equal((await x.events.get('tool_call')({toolName:'edit',input:{path:'src/operations.ts'}},x.ctx)).block,true);
  assert.equal((await x.events.get('tool_call')({toolName:'write',input:{path:'xd://propose'}},x.ctx)).block,true);
  await runCompletedAgent(x,'forge-requirement');
  const next=await x.events.get('session_stop')({},x.ctx);
  assert.equal(next.continue,true);
  assert.equal(x.entries.at(-1).data.phase,'REQUIREMENT');
  assert.equal(x.entries.at(-1).data.requirementStep,'COOKING');
});

test('v5.1 regression: temporarily paused Plan Mode is not a blocker for cooking and challenge', async () => {
  const x=setup(); await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Build booking workflow',x.ctx);
  x.setPlan('paused');
  await runCompletedAgent(x,'forge-requirement');
  await x.events.get('session_stop')({},x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'REQUIREMENT');
  assert.equal(x.entries.at(-1).data.requirementStep,'COOKING');
  for (const agent of requiredAgentsFor(x.entries.at(-1).data)) await runCompletedAgent(x,agent);
  const next=await x.events.get('session_stop')({},x.ctx);
  assert.equal(next.continue,true);
  assert.equal(x.entries.at(-1).data.phase,'REQUIREMENT');
  assert.equal(x.entries.at(-1).data.requirementStep,'CHALLENGE');
});

test('v5.4: Plan Mode resumed after requirement tasks, and proposal requires successful plan write', async () => {
  const x=setup(); await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Build booking workflow',x.ctx);
  for (const step of ['DISCOVERY','COOKING','CHALLENGE']) {
    x.setPlan('paused');
    assert.equal(x.entries.at(-1).data.requirementStep,step);
    for (const agent of requiredAgentsFor(x.entries.at(-1).data)) await runCompletedAgent(x,agent);
  }
  assert.equal(x.entries.at(-1).data.phase,'PLANNING');
  assert.equal(x.getPlan(),'active');
  const path=`local://${x.entries.at(-1).data.slug}-plan.md`;
  assert.equal((await x.events.get('tool_call')({toolName:'write',input:{path:'xd://propose'}},x.ctx)).block,true);
  await runCompletedAgent(x,'forge-planner');
  assert.equal(x.entries.at(-1).data.phase,'PLANNING');
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
  assert.equal(x.entries.at(-1).data.phase,'REWORK_PLANNING');
  for (const tool of ['read','grep','glob','ask']) assert.equal(await x.events.get('tool_call')({toolName:tool,input:{}},x.ctx),undefined);
  assert.equal((await x.events.get('tool_call')({toolName:'edit',input:{path:'src/change.ts'}},x.ctx)).block,true);
});


test('v5.1: QA prevents arbitrary shell and exec aliases, not just bash', async () => {
  const x=setup(); await advanceToReview(x);
  await x.events.get('plan_review_resolved')({choice:'execute'},x.ctx);
  x.setPlan('inactive'); await x.events.get('agent_start')({},x.ctx);
  await runCompletedAgent(x,'forge-executor'); await x.events.get('session_stop')({},x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'QA_REVIEW');
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
  assert.equal(x.entries.at(-1).data.requirementStep, 'DISCOVERY');
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

// v5.3 regression: the UI shows one REQUIREMENT gate, never three separate gates.
test('v5.3: one REQUIREMENT gate runs internal discovery cooking challenge with specialist results', async () => {
  const x = setup();
  const widgets = [];
  x.ctx.ui.setWidget = (id, lines) => widgets.push({ id, lines });
  await x.events.get('session_start')({}, x.ctx);
  await x.commands.get('forge').handler('Create a cross-platform booking flow', x.ctx);
  assert.equal(x.entries.at(-1).data.phase, 'REQUIREMENT');
  assert.equal(x.entries.at(-1).data.requirementStep, 'DISCOVERY');
  for (const [i, internalStep] of ['DISCOVERY', 'COOKING', 'CHALLENGE'].entries()) {
    const state = x.entries.at(-1).data;
    assert.equal(state.phase, 'REQUIREMENT');
    assert.equal(state.requirementStep, internalStep);
    const lastWidget = widgets.at(-1).lines;
    assert.equal(lastWidget.length, 1);
    assert.match(lastWidget[0], /Requirement/);
    assert.doesNotMatch(lastWidget[0], /DISCOVERY|COOKING|CHALLENGE|AWAITING APPROVAL|○/);
    let transition;
    for (const name of requiredAgentsFor(state)) transition = await runCompletedAgent(x, name);
    assert.match(transition.additionalContext, /GATE/);
    if (i < 2) assert.equal(x.entries.at(-1).data.phase, 'REQUIREMENT');
  }
  assert.equal(x.entries.at(-1).data.phase, 'PLANNING');
  assert.equal(x.getPlan(), 'active');
  assert.equal(x.entries.at(-1).data.agentCompletions.length, 7);
});

test('v5.3: legacy in-flight v5.2 cooking state restores as REQUIREMENT internal step', async () => {
  const x = setup();
  const old = {
    ...initialOld(), phase: 'COOKING', gateAgents: { DISCOVERY: ['forge-requirement'], COOKING: ['forge-requirement'] },
    gateAgentsSpawned: { COOKING: ['forge-requirement'] }, agentRetries: { COOKING: 1 },
  };
  x.entries.push({ type: 'custom', customType: 'dev.omp-forge.workflow.v1', data: old });
  await x.events.get('session_start')({}, x.ctx);
  const restored = x.ctx.sessionManager.getBranch().at(-1).data; // old entry is preserved; extension normalizes in memory
  assert.equal(restored.phase, 'COOKING');
  await x.commands.get('forge').handler('status', x.ctx);
  assert.match(x.notifications.at(-1).message, /REQUIREMENT/);
  const result = await x.events.get('before_subagent_spawn')({agent:'forge-critic'}, x.ctx);
  assert.notEqual(result?.block, true);
  assert.equal((await x.events.get('before_subagent_spawn')({agent:'forge-planner'}, x.ctx)).block, true);
});

function initialOld() {
  return {
    phase: 'DISCOVERY', active: true, slug: 'legacy-job', requirement: 'Legacy requirement',
    gateAgents: {}, agentRetries: {}, gateAgentsSpawned: {}, proposalRetries: 0,
  };
}

// v5.4: a QA/plan deadlock was caused by advancing only in session_stop.
test('v5.4: requirement stages advance immediately via task tool_result without session_stop or user prompts', async () => {
  const x=setup(); await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Analyze a feature change',x.ctx);
  const stages=[];
  for (const expected of ['COOKING','CHALLENGE']) {
    const state=x.entries.at(-1).data;
    let signal;
    for (const agent of requiredAgentsFor(state)) signal=await runCompletedAgent(x,agent);
    stages.push(x.entries.at(-1).data.requirementStep);
    assert.match(signal.additionalContext,new RegExp(expected.toLowerCase(),'i'));
  }
  for (const agent of requiredAgentsFor(x.entries.at(-1).data)) await runCompletedAgent(x,agent);
  assert.deepEqual(stages,['COOKING','CHALLENGE']);
  assert.equal(x.entries.at(-1).data.phase,'PLANNING');
  assert.equal(x.sent.length,1,'no synthetic user messages needed per step');
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
  for (let i=0;i<3;i++) for (const agent of requiredAgentsFor(x.entries.at(-1).data)) await runCompletedAgent(x,agent);
  await runCompletedAgent(x,'forge-planner');
  const id='write-failed';const path=`local://${x.entries.at(-1).data.slug}-plan.md`;
  await x.events.get('tool_call')({toolName:'write',toolCallId:id,input:{path}},x.ctx);
  await x.events.get('tool_result')({toolName:'write',toolCallId:id,isError:true,content:[{type:'text',text:'Disk failure'}]},x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'PLANNING');
  assert.equal(x.entries.at(-1).data.planWritten,false);
  assert.equal((await x.events.get('tool_call')({toolName:'write',input:{path:'xd://propose'}},x.ctx)).block,true);
});

test('v5.4: busy Plan Mode after specialist task defers planning until session settles', async () => {
  const x=setup();await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Design feature requirement',x.ctx);
  for (let i=0;i<2;i++) for (const agent of requiredAgentsFor(x.entries.at(-1).data)) await runCompletedAgent(x,agent);
  // In actual OMP mode transitions may return 'busy' during tool_result.
  x.setPlan('inactive');
  const origSet=x.ctx.sessionModes.set;
  let first=true;
  x.ctx.sessionModes.set=async (...args) => first ? (first=false,{ok:false,code:'busy',message:'turn running'}) : origSet(...args);
  let last;
  for (const agent of requiredAgentsFor(x.entries.at(-1).data)) last=await runCompletedAgent(x,agent);
  assert.equal(x.entries.at(-1).data.phase,'PLAN_MODE_PENDING');
  assert.match(last.additionalContext,/Do NOT write local:\/\//);
  assert.equal((await x.events.get('tool_call')({toolName:'write',input:{path:`local://${x.entries.at(-1).data.slug}-plan.md`}},x.ctx)).block,true);
  const timers=[];
  x.ctx.setTimeout=(cb,_ms)=>{timers.push(cb);};
  const continuation=await x.events.get('session_stop')({},x.ctx);
  assert.equal(continuation,undefined,'mode recovery is deferred until the turn is idle');
  assert.ok(timers.length>0);
  await timers.shift()();
  assert.equal(x.entries.at(-1).data.phase,'PLANNING');
  assert.equal(x.getPlan(),'active');
  assert.match(x.sent.at(-1).content,/GATE 2\/6: PLANNING/);
});

test('v5.4: restoring paused Plan Mode uses enter (not unsupported resume)', async () => {
  const x=setup();await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Design new feature',x.ctx);
  x.setPlan('paused');
  const calls=[];
  x.ctx.sessionModes.set=async arg=>{calls.push(arg);x.setPlan('active');return {ok:true};};
  for (let i=0;i<3;i++) for (const agent of requiredAgentsFor(x.entries.at(-1).data)) await runCompletedAgent(x,agent);
  assert.equal(x.entries.at(-1).data.phase,'PLANNING');
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
  assert.deepEqual(finalWidget.lines,['FORGE  ▰▰▰▱▱  Execution  3/5']);
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
    for (const step of ['DISCOVERY','COOKING','CHALLENGE']) {
      assert.equal(x.entries.at(-1).data.requirementStep,step);
      for (const agent of requiredAgentsFor(x.entries.at(-1).data)) await runCompletedAgent(x,agent);
    }
    await runCompletedAgent(x,'forge-planner');
    assert.equal(x.entries.at(-1).data.phase,'PLANNING');
    x.setPlan(mode);
    const path=`local://${x.entries.at(-1).data.slug}-plan.md`;
    const id=`plan-write-${mode}`;
    assert.equal(await x.events.get('tool_call')({toolName:'write',toolCallId:id,input:{path,content:PLAN}},x.ctx),undefined);
    assert.equal(x.entries.at(-1).data.phase,'PLANNING','cannot claim write succeeded before tool_result');
    await x.events.get('tool_result')({toolName:'write',toolCallId:id,isError:false,content:[{type:'text',text:`Wrote ${path}`}]},x.ctx);
    assert.equal(x.entries.at(-1).data.phase,'PROPOSAL');
    assert.equal(x.entries.at(-1).data.planPath,path);
    const proposal=await x.events.get('tool_call')({toolName:'write',input:{path:'xd://propose',content:x.entries.at(-1).data.slug}},x.ctx);
    if (mode==='active') assert.equal(proposal,undefined);
    else assert.match(proposal.reason,/deferred|temporarily paused/i);
  });
}

test('v5.6: PLANNING permits an alternate OMP-local plan filename then pins it', async () => {
  const x=setup();
  await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Plan a feature',x.ctx);
  for (let i=0;i<3;i++) for (const agent of requiredAgentsFor(x.entries.at(-1).data)) await runCompletedAgent(x,agent);
  await runCompletedAgent(x,'forge-planner');
  const path='local://nosess-occupation-ops-plan.md';
  assert.equal(await x.events.get('tool_call')({toolName:'write',toolCallId:'alt-plan',input:{path,content:PLAN}},x.ctx),undefined);
  await x.events.get('tool_result')({toolName:'write',toolCallId:'alt-plan',isError:false,content:[{type:'text',text:'wrote alternate local plan'}]},x.ctx);
  assert.equal(x.entries.at(-1).data.planPath,path);
  assert.equal(x.entries.at(-1).data.phase,'PROPOSAL');
  assert.equal((await x.events.get('tool_call')({toolName:'write',input:{path:`local://${x.entries.at(-1).data.slug}-plan.md`,content:PLAN}},x.ctx)).block,true,'different plan cannot be modified after pinning');
  assert.equal(await x.events.get('tool_call')({toolName:'write',input:{path,content:PLAN}},x.ctx),undefined);
});

test('v5.6: planning sandbox exception remains narrow and source writes still blocked', async () => {
  const x=setup();
  await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Plan a feature',x.ctx);
  for (let i=0;i<3;i++) for (const agent of requiredAgentsFor(x.entries.at(-1).data)) await runCompletedAgent(x,agent);
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
  for (let i=0;i<3;i++) for (const agent of requiredAgentsFor(x.entries.at(-1).data)) await runCompletedAgent(x,agent);
  await runCompletedAgent(x,'forge-planner');
  const path=`local://${x.entries.at(-1).data.slug}-plan.md`;
  assert.equal(await x.events.get('tool_call')({toolName:'write',toolCallId:'bad-plan',input:{path,content:PLAN}},x.ctx),undefined);
  await x.events.get('tool_result')({toolName:'write',toolCallId:'bad-plan',isError:true,content:[{type:'text',text:'native OMP rejected write'}]},x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'PLANNING');
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
  assert.equal(state.phase,'REWORK_PLANNING');
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
  assert.deepEqual(state.gateSkills.requirement,['security-review']);
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
  assert.deepEqual(x.entries.at(-1).data.gateSkills.qa,['go-testing']);
  writeFileSync(path,'---\ndescription: Go testing standards\n---\nRun go test race detector.\n');
  // Simulate QA state to inspect gate lock without advancing unrelated phases.
  const current=x.entries.at(-1).data;
  const altered={...current,phase:'QA_REVIEW'};
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
    assert.deepEqual(requiredAgentsFor({...state,phase:'PLANNING'}),['forge-planner']);
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
  for (const step of ['DISCOVERY','COOKING','CHALLENGE']) {
    for (const agent of requiredAgentsFor(x.entries.at(-1).data)) await runCompletedAgent(x,agent);
  }
  await runCompletedAgent(x,'forge-planner');
  assert.equal(x.entries.at(-1).data.phase,'PLANNING');
  const slug=x.entries.at(-1).data.slug;
  const path=`local://${slug}-plan.md`;
  // Simulate a real file successfully written by native OMP, but Forge misses
  // its tool_result event: no planWritten or PROPOSAL transition.
  assert.equal(x.entries.at(-1).data.planWritten,false);
  assert.equal(await x.events.get('tool_call')({toolName:'write',input:{path:'xd://propose',content:slug}},x.ctx),undefined);
  // The actual OMP native device verifies that the artifact exists BEFORE
  // emitting plan_review_requested. This mock stands for that native event.
  await x.events.get('plan_review_requested')({planContent:PLAN,planPath:path},x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'AWAITING_APPROVAL');
  assert.equal(x.entries.at(-1).data.planWritten,true);
  assert.equal(x.entries.at(-1).data.planValid,true);
  assert.equal(x.entries.at(-1).data.approved,false);
  await x.events.get('plan_review_resolved')({choice:'execute'},x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'EXECUTING');
});

test('v5.13: native plan proposal bypasses only Forge stale state, not human approval or QA contract', async () => {
  const x=setup();
  await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Plan a feature',x.ctx);
  for (const step of ['DISCOVERY','COOKING','CHALLENGE']) {
    for (const agent of requiredAgentsFor(x.entries.at(-1).data)) await runCompletedAgent(x,agent);
  }
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
  assert.notEqual(x.entries.at(-1).data.phase,'EXECUTING');
});

test('v5.14: paused native Plan Mode after writing plan resumes only after idle and opens native review', async () => {
  const x=setup();
  await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Plan a feature',x.ctx);
  for (let i=0;i<3;i++) for (const agent of requiredAgentsFor(x.entries.at(-1).data)) await runCompletedAgent(x,agent);
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
  assert.equal(x.entries.at(-1).data.phase,'PROPOSAL');
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
  assert.equal(timers.length,1,'transient busy gets another bounded retry');
  let opened=0;
  x.ctx.openPlanReview=async()=>{
    opened++;
    await x.events.get('plan_review_requested')({planContent:PLAN,planPath:path},x.ctx);
    return true;
  };
  await timers.shift()();
  assert.equal(opened,1);
  assert.equal(x.getPlan(),'active');
  assert.equal(x.entries.at(-1).data.phase,'AWAITING_APPROVAL');
  assert.equal(x.entries.at(-1).data.approved,false,'no approval may occur without user action');
});

test('v5.14: proposal with stale write telemetry does not loop when mode paused', async () => {
  const x=setup();
  await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Plan a feature',x.ctx);
  for(let i=0;i<3;i++) for(const agent of requiredAgentsFor(x.entries.at(-1).data)) await runCompletedAgent(x,agent);
  await runCompletedAgent(x,'forge-planner');
  assert.equal(x.entries.at(-1).data.phase,'PLANNING');
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
  assert.equal(x.entries.at(-1).data.phase,'AWAITING_APPROVAL');
  assert.equal(x.entries.at(-1).data.approved,false);
});

test('v5.14: permanent Plan Mode refusal never unlocks implementation or silently approves', async () => {
  const x=setup();
  await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Plan a feature',x.ctx);
  for (let i=0;i<3;i++) for (const agent of requiredAgentsFor(x.entries.at(-1).data)) await runCompletedAgent(x,agent);
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
  assert.notEqual(x.entries.at(-1).data.phase,'EXECUTING');
  assert.equal((await x.events.get('tool_call')({toolName:'write',input:{path:'src/app.go',content:'not approved'}},x.ctx)).block,true);
});

test('v5.14: resume old PLAN_MODE_BLOCKED session with saved plan directly into native review', async () => {
  const x=setup();
  await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('Plan a feature',x.ctx);
  for (let i=0;i<3;i++) for(const agent of requiredAgentsFor(x.entries.at(-1).data)) await runCompletedAgent(x,agent);
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
  assert.equal(x.entries.at(-1).data.phase,'AWAITING_APPROVAL');
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
  assert.equal(state.phase,'QA_EVIDENCE_PENDING');
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
  assert.equal(x.entries.at(-1).data.phase,'QA_EVIDENCE_PENDING','resume alone must not replay writes or approval');
  await x.commands.get('forge').handler('qa',x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'QA_REVIEW');
  assert.equal(x.entries.at(-1).data.approvedPlanHash,before);
  assert.deepEqual(x.entries.at(-1).data.gateAgents.QA_REVIEW, []);
  assert.match(x.sent.at(-1).content,/forge_qa_scope/);
  await runQaAgents(x);
  const result=await x.tools.get('forge_qa_submit').execute('call',SUBMISSION,null,null,x.ctx);
  assert.match(result.content[0].text,/GATE: PASS/);
  assert.equal(x.entries.at(-1).data.phase,'DELIVERY_PREP');
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
  assert.equal(x.entries.at(-1).data.phase,'QA_EVIDENCE_PENDING');
  assert.equal(x.entries.at(-1).data.approvedPlanHash,approved);
  x.ctx.sessionModes.set=async()=>({ok:true});
  await x.commands.get('forge').handler('rework',x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'REWORK_PLANNING');
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
  assert.equal(x.entries.at(-1).data.phase,'AWAITING_APPROVAL');
  assert.equal(x.entries.at(-1).data.approved,false);
  assert.ok(x.entries.at(-1).data.recoveryAudit?.length);
  assert.equal((await x.events.get('tool_call')({toolName:'write',input:{path:'src/file.ts',content:'x'}},x.ctx)).block,true);
});

test('v5.20: decline popup leaves current checkpoint unchanged',async()=>{
  const x=setup(); await advanceToReview(x);
  const previous=x.entries.at(-1).data;
  x.entries.push({type:'custom',customType:'dev.omp-forge.workflow.v1',data:{...previous,phase:'PROPOSAL',planWritten:false,active:true}});
  x.ctx.ui.select=async(_label,options)=>options[1];
  await x.events.get('session_start')({},x.ctx);
  const n=x.entries.length;
  await x.commands.get('forge').handler('recover',x.ctx);
  assert.equal(x.entries.length,n);
  assert.equal(x.entries.at(-1).data.phase,'PROPOSAL');
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
  assert.equal(x.entries.at(-1).data.phase,'REWORK_PLANNING');
  assert.equal(x.entries.at(-1).data.approved,false);
});

test('v5.20: automatic recovery popup is scheduled on loading an inconsistent session',async()=>{
  const x=setup(); await advanceToReview(x);
  const previous=x.entries.at(-1).data;
  x.entries.push({type:'custom',customType:'dev.omp-forge.workflow.v1',data:{...previous,phase:'PROPOSAL',planWritten:false,active:true}});
  const callbacks=[];
  const labels=[];
  x.ctx.setTimeout=callback=>callbacks.push(callback);
  x.ctx.ui.select=async(label,options)=>{labels.push(label); return options[1]};
  await x.events.get('session_start')({},x.ctx);
  assert.ok(callbacks.length>0);
  await callbacks.shift()();
  assert.match(labels.at(-1),/State inconsistency/);
  assert.equal(x.entries.at(-1).data.phase,'PROPOSAL');
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
  assert.match(footer.at(-1).value,/Execution 3\/5/);
  assert.equal(widgets.at(-1).value,undefined,'legacy above-editor status was removed');
  x.setPlan('inactive');
  // Emulate the native terminal clearing the footer while leaving Plan Mode.
  footer.length=0;
  await x.events.get('agent_start')({},x.ctx);
  assert.match(footer.at(-1).value,/Execution 3\/5/);
  assert.equal(x.entries.at(-1).data.phase,'EXECUTING');
  footer.length=0;
  await x.events.get('agent_end')({},x.ctx);
  assert.match(footer.at(-1).value,/Execution 3\/5/);
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
  assert.equal(x.entries.at(-1).data.phase,'QA_REVIEW');
  assert.equal(x.entries.at(-1).data.approved,true);
  assert.match(statuses.at(-1).value,/QA review 4\/5/);
  // A re-render must not append new checkpoints or advance the Gate.
  const n=x.entries.length;
  await x.events.get('agent_end')({},x.ctx);
  assert.equal(x.entries.length,n);
  assert.match(statuses.at(-1).value,/QA review 4\/5/);
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
  assert.equal(x.entries.at(-1).data.phase,'EXECUTING');
  x.setBranch([]);
  await laterBranchSwitch(x);
  await x.commands.get('forge').handler('status',x.ctx);
  const last=x.notifications.at(-1).message;
  assert.match(last,/RECOVERY_AVAILABLE/);
  assert.match(last,/EXECUTING/);
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
  assert.equal(current.phase,'PLANNING');
  assert.equal(current.approved,false);
  assert.equal(current.planValid,false);
  assert.equal(current.approvedPlanHash,null);
  assert.equal(current.recoveryAudit.at(-1).priorApprovalRevoked,true);
  assert.equal((await x.events.get('tool_call')({toolName:'write',input:{path:'lib/main.dart'}},x.ctx)).block,true);
  await x.commands.get('forge').handler('status',x.ctx);
  assert.match(x.notifications.at(-1).message,/Forge: PLANNING/);
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
  assert.match(x.notifications.at(-1).message,/QA_EVIDENCE_PENDING/);
  x.ctx.ui.select=async (_title,opts)=>opts[0];
  await x.commands.get('forge').handler('recover',x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'PLANNING');
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
  assert.equal(carried.phase,'EXECUTING');
  assert.equal(carried.approved,true);
  assert.equal(carried.approvedPlanHash,approved.approvedPlanHash);
  assert.equal(carried.recoveryAudit.at(-1).reason,'plan-approval-branch-handoff');
  newBranch.push(x.entries.at(-1));
  await x.commands.get('forge').handler('status',x.ctx);
  assert.match(x.notifications.at(-1).message,/Forge: EXECUTING/);
  assert.doesNotMatch(x.notifications.at(-1).message,/RECOVERY_AVAILABLE/);
});

test('v5.23: approval handoff is single-use and survives an executionObserved write', async () => {
  const x=setup({persistentSession:true}); await advanceToReview(x);
  await x.events.get('plan_review_resolved')({choice:'execute'},x.ctx);
  await x.events.get('agent_start')({},x.ctx); // executionObserved on the approving branch
  // an event on the SAME branch must not consume the handoff
  await x.events.get('session_branch')({},x.ctx);
  x.setBranch([]); await x.events.get('session_tree')({},x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'EXECUTING');
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
  assert.match(x.notifications.at(-1).message,/RECOVERY_AVAILABLE \| previousGate: AGENTS_BLOCKED/);
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
  assert.equal(carried.phase,'EXECUTING');
  assert.equal(carried.approved,true);
  assert.equal(carried.approvedPlanHash,approvedHash);
  assert.equal(carried.recoveryAudit.at(-1).reason,'plan-approval-new-session-handoff');
  const gate=await x.events.get('before_agent_start')({},x.ctx);
  assert.equal(gate.message.customType,'forge-execution-gate-v5');
  await x.commands.get('forge').handler('status',x.ctx);
  assert.match(x.notifications.at(-1).message,/Forge: EXECUTING/);
});

test('v5.24: order B — new session before resolved: carried as AWAITING_APPROVAL, then approved by resolved', async () => {
  const x=setup({persistentSession:true}); await reviewWithId(x);
  const {previousSessionFile,newBranch}=switchToNewSession(x);
  await x.events.get('session_switch')({reason:'new',previousSessionFile},x.ctx);
  let w=x.entries.at(-1).data; newBranch.push(x.entries.at(-1));
  assert.equal(w.phase,'AWAITING_APPROVAL');
  assert.equal(w.approved,false);
  assert.equal(w.nativeApprovalPending.reviewId,'rev-1');
  assert.equal((await x.events.get('tool_call')({toolName:'write',input:{path:'lib/main.dart'}},x.ctx)).block,true);
  // a different review's result is ignored
  await x.events.get('plan_review_resolved')({reviewId:'other',choice:'execute'},x.ctx);
  assert.equal(x.entries.at(-1).data.phase,'AWAITING_APPROVAL');
  await x.events.get('plan_review_resolved')({reviewId:'rev-1',choice:'execute'},x.ctx);
  w=x.entries.at(-1).data;
  assert.equal(w.phase,'EXECUTING');
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
  assert.equal(x.entries.at(-1).data.phase,'EXECUTING');
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
  assert.equal(x.entries.at(-1).data.phase,'AWAITING_APPROVAL');
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

// ---------------------------------------------------------------- v5.25 fast requirement
const LOW_SUMMARY = {
  baseline: 'Goal: CRM contacts. Scope: create/list contacts. Non-goals: billing. Acceptance: contact saved and listed.',
  findings: [{severity:'MEDIUM', title:'Duplicate email handling unspecified', source:'forge-critic'}, {severity:'LOW', title:'Sort order default'}],
  assumptions: ['Emails are unique per tenant'], relevantFiles: ['src/contacts.ts'],
};
const summaryTool = (x, params) => x.tools.get('forge_requirement_summary').execute('sum-'+(++agentCallSeq), params, undefined, undefined, x.ctx);
async function runStepAgents(x) {
  let transition, n = 0;
  for (const agent of requiredAgentsFor(x.entries.at(-1).data)) { transition = await runCompletedAgent(x, agent); n++; }
  return { transition, n };
}

test('v5.26: fast mode — orchestrator intake, 4 in parallel, summary, challenge ALWAYS runs (6 subagents)', async () => {
  const x=setup(); await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('--fast Create a CRM',x.ctx);
  let w=x.entries.at(-1).data;
  assert.equal(w.requirementMode,'fast'); assert.equal(w.requirementStep,'COOKING');
  assert.match(x.sent.at(-1).content,/ONE task call \(parallel batch\)/);
  assert.match(x.sent.at(-1).content,/starting point, not a fence/);
  assert.doesNotMatch(x.sent.at(-1).content,/<= 12 bullets|read only those files/);
  const c=await runStepAgents(x);
  assert.equal(c.n,4);
  assert.match(c.transition.additionalContext,/forge_requirement_summary/);
  const res=await summaryTool(x,LOW_SUMMARY);           // no HIGH findings at all
  w=x.entries.at(-1).data;
  assert.equal(w.requirementStep,'CHALLENGE');           // still challenged
  assert.match(res.content[0].text,/challenge the WHOLE synthesis|WHOLE synthesis/);
  assert.match(res.content[0].text,/Duplicate email handling unspecified/);
  const ch=await runStepAgents(x);
  assert.equal(ch.n,2);
  assert.equal(x.entries.at(-1).data.phase,'PLANNING');
  assert.match(ch.transition.additionalContext,/GATE 2\/6: PLANNING/);
  assert.match(ch.transition.additionalContext,/Requirement baseline/);
});

test('v5.26: HIGH finding is listed as a priority item in the challenge', async () => {
  const x=setup(); await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('--fast Create a CRM',x.ctx);
  await runStepAgents(x);
  const res=await summaryTool(x,{...LOW_SUMMARY, findings:[{severity:'HIGH', title:'Tenant isolation conflicts with shared contact list'}]});
  assert.equal(x.entries.at(-1).data.requirementStep,'CHALLENGE');
  assert.match(res.content[0].text,/Priority items[\s\S]*Tenant isolation conflicts/);
  assert.deepEqual(requiredAgentsFor(x.entries.at(-1).data),['forge-critic','forge-architect']);
});

async function runAgentWithText(x, agent, text) {
  const id=`task-${++agentCallSeq}`;
  await x.events.get('tool_call')({toolName:'task',toolCallId:id,input:{agent,task:'Analyze'}},x.ctx);
  await x.events.get('before_subagent_spawn')({agent},x.ctx);
  return x.events.get('tool_result')({toolName:'task',toolCallId:id,isError:false,content:[{type:'text',text}]},x.ctx);
}

test('v5.26: summary cannot silently drop specialists\' CRITICAL/HIGH findings', async () => {
  for (const flag of ['quick','--fast']) {
    const x=setup(); await x.events.get('session_start')({},x.ctx);
    await x.commands.get('forge').handler(`${flag} Create a CRM`,x.ctx);
    const agents=requiredAgentsFor(x.entries.at(-1).data);
    await runAgentWithText(x,agents[0],'- [HIGH][fact] Contacts table has no tenant column (src/db.ts:12)');
    for (const a of agents.slice(1)) await runAgentWithText(x,a,'- [LOW][assumption] naming');
    const r=await summaryTool(x,LOW_SUMMARY);
    assert.equal(r.isError,true,flag);
    assert.match(r.content[0].text,/1 HIGH/);
    assert.equal(x.entries.at(-1).data.requirementSummary ?? null,null);
    const ok=await summaryTool(x,{...LOW_SUMMARY, findings:[...LOW_SUMMARY.findings,{severity:'HIGH',title:'No tenant column'}]});
    assert.notEqual(ok.isError,true);
    assert.equal(x.entries.at(-1).data.requirementStep,'CHALLENGE');
  }
});

test('v5.26: default mode is thorough; thorough challenge runs critic + architect in one parallel batch', async () => {
  const {DEFAULT_REQUIREMENT_MODE}=await import('../forge/core.mjs');
  assert.equal(DEFAULT_REQUIREMENT_MODE,'thorough');
  const x=setup(); await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('A thorough run',x.ctx);
  assert.equal(x.entries.at(-1).data.requirementStep,'DISCOVERY');
  assert.match(x.sent.at(-1).content,/Relevant files/);
  let t; for (let i=0;i<2;i++) { const r=await runStepAgents(x); t=r.transition; }
  assert.equal(x.entries.at(-1).data.requirementStep,'CHALLENGE');
  assert.match(t.additionalContext,/ONE parallel task batch/);
  assert.doesNotMatch(t.additionalContext,/separately/);
});

test('v5.26: quick start warns that it is low rigor', async () => {
  const x=setup(); await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('quick Rename a label',x.ctx);
  const n=x.notifications.find(m=>/LOW RIGOR/.test(m.message));
  assert.ok(n); assert.equal(n.level,'warning');
});

test('v5.25: open blocker escalates even without HIGH findings', async () => {
  const x=setup(); await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('--fast Create a CRM',x.ctx);
  await runStepAgents(x);
  await summaryTool(x,{...LOW_SUMMARY, blockers:['Which auth provider?']});
  assert.equal(x.entries.at(-1).data.requirementStep,'CHALLENGE');
});

test('v5.25: quick mode runs only analyst + QA strategist', async () => {
  const x=setup(); await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('quick Add CSV export',x.ctx);
  const w=x.entries.at(-1).data;
  assert.equal(w.requirementMode,'quick');
  assert.equal(w.requirement,'Add CSV export');
  assert.deepEqual(requiredAgentsFor(w),['forge-requirement','forge-qa-strategist']);
  const {n}=await runStepAgents(x);
  assert.equal(n,2);
  await summaryTool(x,LOW_SUMMARY);
  assert.equal(x.entries.at(-1).data.phase,'PLANNING');
});

test('v5.25: summary is rejected before specialists finish, twice, in thorough mode, or with bad severity', async () => {
  const x=setup(); await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('--fast Create a CRM',x.ctx);
  let r=await summaryTool(x,LOW_SUMMARY);
  assert.equal(r.isError,true); assert.match(r.content[0].text,/specialist reports missing/);
  await runStepAgents(x);
  r=await summaryTool(x,{...LOW_SUMMARY, findings:[{severity:'URGENT', title:'x'}]});
  assert.equal(r.isError,true);
  assert.equal(x.entries.at(-1).data.phase,'REQUIREMENT');
  await summaryTool(x,LOW_SUMMARY);
  r=await summaryTool(x,LOW_SUMMARY);
  assert.equal(r.isError,true);

  const y=setup(); await y.events.get('session_start')({},y.ctx);
  await y.commands.get('forge').handler('A thorough run',y.ctx); // test config default = thorough
  assert.equal(y.entries.at(-1).data.requirementStep,'DISCOVERY');
  r=await summaryTool(y,LOW_SUMMARY);
  assert.equal(r.isError,true); assert.match(r.content[0].text,/thorough/);
});

test('v5.25: session_stop nudges for the summary instead of stalling', async () => {
  const x=setup(); await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('--fast Create a CRM',x.ctx);
  await runStepAgents(x);
  const stop=await x.events.get('session_stop')({},x.ctx);
  assert.equal(stop.continue,true);
  assert.match(stop.additionalContext,/forge_requirement_summary/);
  assert.equal(x.entries.at(-1).data.phase,'REQUIREMENT');
});

test('v5.25: unknown tools remain blocked in REQUIREMENT; summary tool only in REQUIREMENT', async () => {
  const x=setup(); await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('--fast Create a CRM',x.ctx);
  assert.equal((await x.events.get('tool_call')({toolName:'mystery_tool',input:{}},x.ctx)).block,true);
  assert.equal((await x.events.get('tool_call')({toolName:'write',input:{path:'src/a.ts'}},x.ctx)).block,true);
});

test('v5.25: /forge mode shows and persists the default; new runs use it', async () => {
  const x=setup(); await x.events.get('session_start')({},x.ctx);
  try {
    await x.commands.get('forge').handler('mode quick',x.ctx);
    assert.equal(JSON.parse(readFileSync(process.env.FORGE_CONFIG_PATH,'utf8')).requirementMode,'quick');
    await x.commands.get('forge').handler('Plain requirement text',x.ctx);
    assert.equal(x.entries.at(-1).data.requirementMode,'quick');
    await x.commands.get('forge').handler('mode',x.ctx);
    assert.match(x.notifications.at(-1).message,/requirement mode: quick/);
  } finally {
    await x.commands.get('forge').handler('off',x.ctx);
    await x.commands.get('forge').handler('mode thorough',x.ctx);
  }
});

test('v5.26: fast mode reaches native approval and execution like thorough', async () => {
  const x=setup(); await x.events.get('session_start')({},x.ctx);
  await x.commands.get('forge').handler('--fast Create a CRM',x.ctx);
  await runStepAgents(x);
  await summaryTool(x,LOW_SUMMARY);
  await runStepAgents(x); // challenge always runs in fast mode
  await runCompletedAgent(x,'forge-planner');
  await writeCanonicalPlan(x);
  await x.events.get('plan_review_requested')({planContent:PLAN,planPath:`local://${x.entries.at(-1).data.slug}-plan.md`},x.ctx);
  await x.events.get('plan_review_resolved')({choice:'keep'},x.ctx);
  const w=x.entries.at(-1).data;
  assert.equal(w.phase,'EXECUTING'); assert.equal(w.approved,true);
  assert.equal(w.requirementSummary.baseline.startsWith('Goal: CRM'),true);
});

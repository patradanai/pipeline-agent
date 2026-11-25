import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initialState, nextPhase, phaseInstruction, parseCommand, isAutoEligible,
} from '../forge/core.mjs';

test('requirement is required and retained', () => {
  assert.throws(() => initialState('  '));
  assert.equal(initialState('  Build a CRM  ', 'forge-test').requirement, 'Build a CRM');
});
test('chain advances in order without user commands', () => {
  const phases = ['PLAN'];
  let next;
  while ((next = nextPhase(phases.at(-1)))) phases.push(next);
  assert.deepEqual(phases, ['PLAN','EXECUTE','QA']);
});
test('each phase has domain-independent instructions', () => {
  const s = initialState('A cross-platform note-taking app', 'forge-test');
  assert.equal(s.phase, 'PLAN');
  const prompt = phaseInstruction(s);
  assert.match(prompt, /OMP FORGE — GLOBAL REQUIREMENT HARNESS/);
  assert.match(prompt, /Do not edit the project/);
  assert.match(prompt, /\[GATE 1\/3: PLAN — Forge plan mode\]/);
  assert.match(prompt, /parallel `scout` subagents/);
  assert.doesNotMatch(prompt, /forge-requirement|forge-planner|forge-critic|forge-architect|forge-qa-strategist/);
  assert.match(phaseInstruction({ ...s, planWritten:true }), /\[GATE 1\/3: FORGE PLAN APPROVAL\][\s\S]*forge_plan_propose/);
  assert.doesNotMatch(prompt, /xd:\/\/propose|Plan Review overlay/);
  assert.match(phaseInstruction({ ...s, planWritten:true, planValid:true }), /awaiting explicit operator approval/);
  const exec = phaseInstruction({ ...s, phase:'EXECUTE', approved:true });
  assert.match(exec, /Execute it yourself/);
  assert.doesNotMatch(exec, /forge-executor/);
  assert.match(phaseInstruction({ ...s, phase:'QA' }), /forge-code-reviewer/);
  const delivery = phaseInstruction({ ...s, phase:'QA', qaStatus:'PASS' });
  assert.match(delivery, /Prepare delivery yourself/);
  assert.doesNotMatch(delivery, /forge-delivery/);
});
test('instructions open with the bound gate skills', () => {
  const s = initialState('x', undefined, null, {planning:['forge-plan-gate','go-testing']});
  assert.ok(phaseInstruction(s).startsWith('Load and follow the forge-plan-gate, go-testing skills.'));
});
test('legacy requirement gate key and aliases map to planning', async () => {
  const {cloneGateSkills,normalizeSkillGate}=await import('../forge/core.mjs');
  const skills = cloneGateSkills({requirement:['a'], qa:[]});
  assert.equal(Object.hasOwn(skills,'requirement'), false);
  assert.deepEqual(skills.qa, []);
  for (const alias of ['requirement','requirements','req','cook']) assert.equal(normalizeSkillGate(alias),'planning');
});
test('auto routing excludes commands, images and active workflows', () => {
  assert.equal(isAutoEligible('Build a CRM', 'interactive', false), true);
  assert.equal(isAutoEligible('/model', 'interactive', false), false);
  assert.equal(isAutoEligible('Build a CRM', 'rpc', false), false);
  assert.equal(isAutoEligible('Build a CRM', 'interactive', true), false);
  assert.equal(isAutoEligible('Build a CRM', 'interactive', false, true), false);
});
test('command parser', () => {
  assert.deepEqual(parseCommand('auto on'), {type:'auto', enabled:true});
  assert.deepEqual(parseCommand('auto off'), {type:'auto', enabled:false});
  assert.deepEqual(parseCommand('status'), {type:'status'});
  assert.deepEqual(parseCommand('resume'), {type:'resume'});
  assert.deepEqual(parseCommand('off'), {type:'cancel'});
  assert.deepEqual(parseCommand('Build a CRM'), {type:'start',requirement:'Build a CRM'});
  // Removed mode commands are ordinary requirement text now.
  assert.deepEqual(parseCommand('quick Fix x'), {type:'start',requirement:'quick Fix x'});
  assert.deepEqual(parseCommand('thorough Redesign billing'), {type:'start',requirement:'thorough Redesign billing'});
  assert.deepEqual(parseCommand('--fast Build CRM'), {type:'start',requirement:'--fast Build CRM'});
  assert.deepEqual(parseCommand('mode'), {type:'start',requirement:'mode'});
});

import {
  extractBusinessTopics, extractRequirementTraceability, extractBusinessTestCases, extractCodeQualityGates, validatePlanContract, evaluateQaReport, renderQaReport,
  isAllowedQaCommand, qaInstruction,
} from '../forge/core.mjs';

const plan = `# Plan\n## Context\nDiners order by QR and can be refunded once.\n## Approach\n1. Add order and refund handlers (REQ-001, REQ-002).\n- Open decisions: none\n- Migration & rollback: not applicable — no schema change\n## Verification\n- go test: TC-001 and TC-002 pass\n## Assumptions & contingencies\n- none\n## Business Topics\n- BIZ-001: QR Ordering\n- BIZ-002: Payment and Refund\n## Requirement Traceability\n- REQ-001 | BIZ-001 | Place order | Accepted\n- REQ-002 | BIZ-002 | Refund once | One refund\n## Business Test Cases\n- TC-001 | BIZ-001 | REQ-001 | Place order | Accepted | go test\n- TC-002 | BIZ-002 | REQ-002 | Refund once | One refund | go test\n## Code Quality Gates\n- QG-001: Automated tests\n- QG-002: Static analysis\n`;

test('extracts stable BIZ IDs only from Business Topics section', () => {
  assert.deepEqual(extractBusinessTopics(plan), [
    {id:'BIZ-001',name:'QR Ordering'},
    {id:'BIZ-002',name:'Payment and Refund'},
  ]);
  assert.deepEqual(extractBusinessTopics('# Plan\n- BIZ-999: incidental'), []);
  assert.deepEqual(extractRequirementTraceability(plan).map(r=>[r.id,r.topicId]), [['REQ-001','BIZ-001'],['REQ-002','BIZ-002']]);
  assert.equal(extractCodeQualityGates(plan).length,2);
  assert.equal(extractBusinessTestCases(plan).length,2);
  assert.equal(validatePlanContract(plan).valid,true);
});

const goodSubmission = {
  topicResults: [
    {topicId:'BIZ-001', tests:[{testId:'TC-001',requirementIds:['REQ-001'],scenario:'Place order',expected:'Accepted',actual:'Accepted',status:'PASS',evidence:'go test ./... passed; orders_test.go:42',severity:'HIGH',fileRefs:['orders_test.go:42']}]},
    {topicId:'BIZ-002', tests:[{testId:'TC-002',requirementIds:['REQ-002'],scenario:'Refund once',expected:'One refund',actual:'One refund',status:'PASS',evidence:'payment_test.go:17 passed',severity:'CRITICAL'}]},
  ],
  codeQualityChecks:[{gateId:'QG-001',name:'go test',status:'PASS',evidence:'go test ./... exited 0'},{gateId:'QG-002',name:'go vet',status:'PASS',evidence:'go vet ./... exited 0'}],
  codeReview:{status:'PASS',evidence:'Reviewed handlers.go:10-88 and service.go:20-160',findings:[]},
  reviewedChanges:['handlers.go','service.go'],
};

test('QA gate passes only with evidence and complete business topic coverage', () => {
  const topics = extractBusinessTopics(plan);
  const result = evaluateQaReport(goodSubmission, topics, extractRequirementTraceability(plan),extractCodeQualityGates(plan),extractBusinessTestCases(plan));
  assert.equal(result.status,'PASS');
  assert.equal(result.counts.businessTopics,2);
  assert.match(renderQaReport(result,{slug:'forge-test'}), /### BIZ-002 — Payment and Refund/);
  assert.match(qaInstruction({...initialState('test','forge-test'),businessTopics:topics,requirements:extractRequirementTraceability(plan),qualityGates:extractCodeQualityGates(plan)}),/forge_qa_submit/);
});

test('QA gate blocks missing business topic and unsupported PASS claims', () => {
  const topics = extractBusinessTopics(plan);
  const partial = structuredClone(goodSubmission);
  partial.topicResults.pop();
  partial.topicResults[0].tests[0].evidence='';
  const result = evaluateQaReport(partial, topics, extractRequirementTraceability(plan),extractCodeQualityGates(plan),extractBusinessTestCases(plan));
  assert.equal(result.status,'BLOCKED');
  assert.equal(result.topics[0].tests[0].status,'BLOCKED');
  assert.equal(result.topics[1].tests[0].status,'BLOCKED');
  assert.ok(result.problems.some(p=>p.includes('TC-002: missing')));
  assert.ok(result.formatErrors.some(p=>p.includes('TC-001: PASS needs evidence')));
});

test('QA gate fails on failing business case or high code review finding', () => {
  const topics = extractBusinessTopics(plan);
  const fail = structuredClone(goodSubmission);
  fail.topicResults[1].tests[0].status='FAIL';
  assert.equal(evaluateQaReport(fail,topics,extractRequirementTraceability(plan),extractCodeQualityGates(plan),extractBusinessTestCases(plan)).status,'FAIL');
  const high = structuredClone(goodSubmission);
  high.codeReview.findings.push({id:'CR-001',title:'SQL injection',severity:'HIGH',evidence:'unsafe interpolation'});
  assert.equal(evaluateQaReport(high,topics,extractRequirementTraceability(plan),extractCodeQualityGates(plan),extractBusinessTestCases(plan)).status,'FAIL');
});

test('QA gate blocks when plan has no business topic IDs', () => {
  assert.equal(evaluateQaReport(goodSubmission, [], []).status,'BLOCKED');
});

test('QA command policy allows read-only chains and test runners with arguments, rejects mutation', () => {
  for (const cmd of ['go test ./...', 'go vet ./...', 'git diff --check','npm run lint','pnpm test','flutter test',
    'git diff; echo x', 'go test ./internal/x -run \'A|B\' -count=1', 'npm test 2>&1 | tail -20', 'git -C sub status --short',
    'cd apps/api && go test ./...', 'npx tsc --noEmit', 'node --experimental-strip-types --test dist/a.test.mjs']) assert.equal(isAllowedQaCommand(cmd),true,cmd);
  for (const cmd of ['rm -rf .','go test ./... && rm -rf .','npm run deploy','python -c "print(1)"','git diff > out.txt',
    'npm run build', 'npx eslint --fix .', 'npx tsc', 'echo $(rm -rf x)', 'go test ./...\nrm -rf x', 'go test ./... | tee out.txt', 'git clean -fd']) assert.equal(isAllowedQaCommand(cmd),false,cmd);
  assert.equal(isAllowedQaCommand('npm run build', ['npm run build']), true, 'a command written in the approved plan runs verbatim');
});

test('QA uses the plan mapping and text for each TC, whatever the submission claims', () => {
  const partial = structuredClone(goodSubmission);
  partial.topicResults[1].tests[0].requirementIds=['REQ-001'];
  partial.topicResults[1].tests[0].scenario='Something else';
  const report=evaluateQaReport(partial,extractBusinessTopics(plan),extractRequirementTraceability(plan),extractCodeQualityGates(plan),extractBusinessTestCases(plan));
  assert.equal(report.status,'PASS');
  assert.deepEqual(report.topics[1].tests[0].requirementIds,['REQ-002']);
  assert.equal(report.topics[1].tests[0].scenario,'Refund once');
});

test('QA gate blocks a missing planned code quality gate', () => {
  const partial = structuredClone(goodSubmission);
  partial.codeQualityChecks.pop();
  const report=evaluateQaReport(partial,extractBusinessTopics(plan),extractRequirementTraceability(plan),extractCodeQualityGates(plan),extractBusinessTestCases(plan));
  assert.equal(report.status,'BLOCKED');
  assert.ok(report.problems.some(p=>p.includes('QG-002')));
});

import { buildCommitMessage, renderDeliveryReport, isProhibitedGitCommand, reworkInstruction, deliveryInstruction } from '../forge/core.mjs';

test('Git guard blocks direct/wrapped commits and publish scripts without blocking read-only status', () => {
  const blocked = [
    'git add .', 'git commit -am "done"', 'git -C /app push origin main',
    '/usr/bin/git commit --amend', 'git -c user.name=bot commit -m foo',
    'sh -c "git tag v1.0"', 'gh pr merge 1', 'npm run release', 'pnpm publish',
    'npx semantic-release', 'python -c "subprocess.run([\'git\',\'commit\'])"',
  ];
  for (const command of blocked) assert.equal(isProhibitedGitCommand(command),true,command);
  for (const command of ['git status','git diff --stat','git diff --check','go test ./...', 'npm test']) {
    assert.equal(isProhibitedGitCommand(command),false,command);
  }
});

test('commit message must be a valid copy-ready Conventional Commit, never a shell command', () => {
  const message=buildCommitMessage('fix(auth): prevent duplicate tokens','- Add token validation\n- Verify errors');
  assert.equal(message, 'fix(auth): prevent duplicate tokens\n\n- Add token validation\n- Verify errors\n');
  assert.throws(()=>buildCommitMessage('Fixed stuff'),/Conventional Commits/);
  assert.throws(()=>buildCommitMessage('feat: '+'x'.repeat(100)),/72 characters/);
  assert.match(renderDeliveryReport({slug:'forge-test',generatedAt:'now',commitMessage:message,highlights:['Fixed token race'],changedFiles:['auth.go']}),/MANUAL COMMIT/);
});

test('rework and delivery prompts never authorize Git writes', () => {
  const state=initialState('Manage bookings','forge-test');
  const rework=reworkInstruction({...state, qaStatus:'FAIL', reworkCycles:1, qaReportPath:'/tmp/qa-report.md'});
  assert.match(rework,/Re-plan in Forge plan mode yourself; there is no planner agent/);
  assert.match(rework,/Do NOT auto-approve or implement/);
  const delivery=deliveryInstruction({...state, qaStatus:'PASS'});
  assert.match(delivery,/Prepare delivery yourself/);
  assert.match(delivery,/do not stage, commit, push/i);
  assert.deepEqual(parseCommand('commit-msg'),{type:'delivery'});
  assert.deepEqual(parseCommand('rework'),{type:'rework'});
});
test('rework planning uses a separate revision path and preserves it through Refine', () => {
  const base = {
    ...initialState('Manage bookings', 'forge-test'),
    phase: 'PLAN',
    reworkBaseHash: 'sha256-old',
    reworkBasePlanPath: 'local://forge-test-plan.md',
    reworkCycles: 1,
    qaStatus: 'FAIL',
  };
  const firstPrompt = reworkInstruction(base);
  assert.match(firstPrompt, /Save a revised plan to local:\/\/forge-test-rework-1-plan\.md/);
  assert.doesNotMatch(firstPrompt, /Save a revised plan to local:\/\/forge-test-plan\.md/);
  const legacyPrompt = phaseInstruction({
    ...base, reworkBasePlanPath: null, planPath: 'local://forge-test-plan.md',
  });
  assert.match(legacyPrompt, /keep editing the same rework revision at local:\/\/forge-test-rework-1-plan\.md/);


  const refinedPrompt = phaseInstruction({
    ...base, planPath: 'local://forge-test-rework-1-plan.md',
  });
  assert.match(refinedPrompt, /QA FAILED: REWORK PLAN/);
  assert.match(refinedPrompt, /keep editing the same rework revision at local:\/\/forge-test-rework-1-plan\.md/);
});


test('global gate contract identifies exact agent ownership', async () => {
  const {GATE_AGENTS,missingGateAgents,missingGateAgentsFor}=await import('../forge/core.mjs');
  assert.deepEqual({...GATE_AGENTS},{PLAN:['forge-plan-critic'],EXECUTE:[],QA:['forge-code-reviewer']});
  assert.deepEqual(missingGateAgents('EXECUTE',[]),[]);
  assert.deepEqual(missingGateAgents('QA',[]),['forge-code-reviewer']);
  const state=initialState('Build feature','forge-test');
  assert.deepEqual(missingGateAgentsFor(state),[]); // plan review off: PLAN needs no agent
  assert.deepEqual(missingGateAgentsFor({...state,planReview:true,gateAgents:{PLAN:[]}}),['forge-plan-critic']);
  assert.deepEqual(missingGateAgentsFor({...state,phase:'EXECUTE',approved:true}),[]);
  assert.deepEqual(missingGateAgentsFor({...state,phase:'QA',gateAgents:{QA:[]}}),['forge-code-reviewer']);
  assert.deepEqual(missingGateAgentsFor({...state,phase:'QA',gateAgents:{QA:['forge-code-reviewer']}}),[]);
  assert.deepEqual(missingGateAgentsFor({...state,phase:'QA',qaStatus:'PASS',gateAgents:{QA:[]}}),[]);
});

test('v5 rejects plan without exact parseable Test Case IDs', () => {
  const invalid = plan.replace('## Business Test Cases\n- TC-001 | BIZ-001 | REQ-001 | Place order | Accepted | go test\n- TC-002 | BIZ-002 | REQ-002 | Refund once | One refund | go test\n','');
  const validation=validatePlanContract(invalid);
  assert.equal(validation.valid,false);
  assert.ok(validation.issues.some(x=>x.includes('Business Test Cases')));
});

test('v5 blocks QA when TC-999 replaces planned TC-001', () => {
  const input=structuredClone(goodSubmission);
  input.topicResults[0].tests[0].testId='TC-999';
  const report=evaluateQaReport(input,extractBusinessTopics(plan),extractRequirementTraceability(plan),extractCodeQualityGates(plan),extractBusinessTestCases(plan));
  assert.equal(report.status,'BLOCKED');
  assert.ok(report.formatErrors.some(x=>x.includes('TC-001: missing')));
  assert.ok(report.formatErrors.some(x=>x.includes('TC-999: not an approved test case')));
});

test('v5 accepts a submission that omits the plan-owned TC fields', () => {
  const input=structuredClone(goodSubmission);
  for (const group of input.topicResults) for (const t of group.tests) { delete t.scenario; delete t.expected; delete t.requirementIds; }
  const report=evaluateQaReport(input,extractBusinessTopics(plan),extractRequirementTraceability(plan),extractCodeQualityGates(plan),extractBusinessTestCases(plan));
  assert.equal(report.status,'PASS');
  assert.equal(report.topics[0].tests[0].expected,'Accepted');
});

test('v5 blocks duplicate submitted planned tests', () => {
  const input=structuredClone(goodSubmission);
  input.topicResults[1].tests.push(structuredClone(input.topicResults[1].tests[0]));
  const report=evaluateQaReport(input,extractBusinessTopics(plan),extractRequirementTraceability(plan),extractCodeQualityGates(plan),extractBusinessTestCases(plan));
  assert.equal(report.status,'BLOCKED');
  assert.ok(report.formatErrors.some(x=>x.includes('TC-002: submitted more than once')));
});

test('v5 plan contract detects test linked to another business topic', () => {
  const invalid = plan.replace('TC-001 | BIZ-001 | REQ-001','TC-001 | BIZ-002 | REQ-001');
  const result=validatePlanContract(invalid);
  assert.equal(result.valid,false);
  assert.ok(result.issues.some(x=>x.includes('wrong business topic')));
});

// ---------------------------------------------------------------- v6.2
import { migrateLegacyRequirementState } from '../forge/core.mjs';
test('legacy phases migrate without inventing gate evidence', () => {
  for (const phase of ['REQUIREMENT','DISCOVERY','COOKING','CHALLENGE']) {
    const legacy={active:true,phase,approved:true,approvedPlanHash:'h',planValid:true,planWritten:true,gateAgents:{COOKING:['forge-critic'],REQUIREMENT:['forge-requirement']},requirement:'x'};
    const m=migrateLegacyRequirementState(legacy);
    assert.equal(m.phase,'PLAN');
    assert.equal(m.approved,false);
    assert.equal(m.approvedPlanHash,null);
    assert.equal(m.planValid,false);
    assert.equal(m.planWritten,false);
    assert.deepEqual(m.gateAgents,{});
  }
  for (const [legacy, phase] of [['PLANNING','PLAN'],['EXECUTING','EXECUTE'],['QA_REVIEW','QA'],['DELIVERY_PREP','QA']]) {
    const m=migrateLegacyRequirementState({active:true,phase:legacy});
    assert.equal(m.phase,phase);
    assert.notEqual(m.approved,true);
    assert.notEqual(m.qaStatus,'PASS');
  }
  const planning={active:true,phase:'PLAN'};
  assert.equal(migrateLegacyRequirementState(planning),planning);
});

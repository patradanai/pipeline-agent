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
  const phases = ['REQUIREMENT'];
  let next;
  while ((next = nextPhase(phases.at(-1)))) phases.push(next);
  assert.deepEqual(phases, ['REQUIREMENT','PLANNING','PROPOSAL']);
});
test('each phase has domain-independent instructions', () => {
  const s = initialState('A cross-platform note-taking app', 'forge-test');
  for (const phase of ['REQUIREMENT','PLANNING','PROPOSAL']) {
    const prompt = phaseInstruction({ ...s, phase });
    assert.match(prompt, /OMP FORGE — GLOBAL REQUIREMENT HARNESS/);
    assert.match(prompt, /Do not edit the project/);
  }
  assert.match(phaseInstruction({ ...s, phase:'REQUIREMENT', requirementStep:'COOKING' }), /four INSTALLED, NAMED global task agents/);
  assert.match(phaseInstruction({ ...s, phase:'PROPOSAL' }), /xd:\/\/propose/);
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
});

import {
  extractBusinessTopics, extractRequirementTraceability, extractBusinessTestCases, extractCodeQualityGates, validatePlanContract, evaluateQaReport, renderQaReport,
  isAllowedQaCommand, qaInstruction,
} from '../forge/core.mjs';

const plan = `# Plan\n## Business Topics\n- BIZ-001: QR Ordering\n- BIZ-002: Payment and Refund\n## Requirement Traceability\n- REQ-001 | BIZ-001 | Place order | Accepted\n- REQ-002 | BIZ-002 | Refund once | One refund\n## Business Test Cases\n- TC-001 | BIZ-001 | REQ-001 | Place order | Accepted | go test\n- TC-002 | BIZ-002 | REQ-002 | Refund once | One refund | go test\n## Code Quality Gates\n- QG-001: Automated tests\n- QG-002: Static analysis\n`;

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
  assert.ok(result.problems.some(p=>p.includes('no business test cases')));
});

test('QA gate fails on failing business case or high code review finding', () => {
  const topics = extractBusinessTopics(plan);
  const fail = structuredClone(goodSubmission);
  fail.topicResults[1].tests[0].status='FAIL';
  assert.equal(evaluateQaReport(fail,topics,extractRequirementTraceability(plan),extractCodeQualityGates(plan)).status,'FAIL');
  const high = structuredClone(goodSubmission);
  high.codeReview.findings.push({id:'CR-001',title:'SQL injection',severity:'HIGH',evidence:'unsafe interpolation'});
  assert.equal(evaluateQaReport(high,topics,extractRequirementTraceability(plan),extractCodeQualityGates(plan)).status,'FAIL');
});

test('QA gate blocks when plan has no business topic IDs', () => {
  assert.equal(evaluateQaReport(goodSubmission, [], []).status,'BLOCKED');
});

test('QA command allowlist rejects mutating shell and allows tests', () => {
  for (const cmd of ['go test ./...', 'go vet ./...', 'git diff --check','npm run lint','pnpm test','flutter test']) assert.equal(isAllowedQaCommand(cmd),true,cmd);
  for (const cmd of ['rm -rf .','go test ./... && rm -rf .','git diff; echo x','npm run deploy','python -c "print(1)"','git diff > out.txt']) assert.equal(isAllowedQaCommand(cmd),false,cmd);
});

test('QA gate blocks untested mapped requirement even if other checks pass', () => {
  const partial = structuredClone(goodSubmission);
  partial.topicResults[1].tests[0].requirementIds=['REQ-001'];
  const report=evaluateQaReport(partial,extractBusinessTopics(plan),extractRequirementTraceability(plan),extractCodeQualityGates(plan),extractBusinessTestCases(plan));
  assert.equal(report.status,'BLOCKED');
  assert.ok(report.problems.some(p=>p.includes('REQ-002: no test case mapped')));
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
  assert.match(reworkInstruction({...state, qaStatus:'FAIL', reworkCycles:1, qaReportPath:'/tmp/qa-report.md'}),/fresh|new approval/i);
  assert.match(deliveryInstruction({...state, qaStatus:'PASS'}),/do not stage, commit, push/i);
  assert.deepEqual(parseCommand('commit-msg'),{type:'delivery'});
  assert.deepEqual(parseCommand('rework'),{type:'rework'});
});

test('global gate contract identifies exact agent ownership', async () => {
  const {GATE_AGENTS,REQUIREMENT_STEP_AGENTS,missingGateAgents}=await import('../forge/core.mjs');
  assert.equal(REQUIREMENT_STEP_AGENTS.COOKING.length,4);
  assert.deepEqual(missingGateAgents('QA_REVIEW',['forge-qa']),['forge-code-reviewer']);
  assert.deepEqual(missingGateAgents('DELIVERY_PREP',['forge-delivery']),[]);
  assert.deepEqual(missingGateAgents('AWAITING_APPROVAL',[]),[]);
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
  assert.ok(report.problems.some(x=>x.includes('TC-001: required planned test case')));
  assert.ok(report.problems.some(x=>x.includes('TC-999: unplanned test')));
});

test('v5 blocks QA if planned test mapping or expected scenario changes', () => {
  const input=structuredClone(goodSubmission);
  input.topicResults[0].tests[0].scenario='Change something else';
  const report=evaluateQaReport(input,extractBusinessTopics(plan),extractRequirementTraceability(plan),extractCodeQualityGates(plan),extractBusinessTestCases(plan));
  assert.equal(report.status,'BLOCKED');
  assert.ok(report.problems.some(x=>x.includes('scenario/expected differs')));
});

test('v5 blocks duplicate submitted planned tests', () => {
  const input=structuredClone(goodSubmission);
  input.topicResults[1].tests.push(structuredClone(input.topicResults[1].tests[0]));
  const report=evaluateQaReport(input,extractBusinessTopics(plan),extractRequirementTraceability(plan),extractCodeQualityGates(plan),extractBusinessTestCases(plan));
  assert.equal(report.status,'BLOCKED');
  assert.ok(report.problems.some(x=>x.includes('duplicate submitted')));
});

test('v5 plan contract detects test linked to another business topic', () => {
  const invalid = plan.replace('TC-001 | BIZ-001 | REQ-001','TC-001 | BIZ-002 | REQ-001');
  const result=validatePlanContract(invalid);
  assert.equal(result.valid,false);
  assert.ok(result.issues.some(x=>x.includes('wrong business topic')));
});

// ---------------------------------------------------------------- v5.25
import { parseCommand as pc525, shouldEscalateRequirement, normalizeRequirementSummary, afterRequirementStep, firstRequirementStep, requiredAgentsFor as req525, initialState as init525 } from '../forge/core.mjs';
test('v5.25: mode prefixes parse without eating ordinary requirement text', () => {
  assert.deepEqual(pc525('quick Add CSV export'), {type:'start', requirement:'Add CSV export', mode:'quick'});
  assert.deepEqual(pc525('thorough Redesign billing'), {type:'start', requirement:'Redesign billing', mode:'thorough'});
  assert.deepEqual(pc525('--fast Build CRM'), {type:'start', requirement:'Build CRM', mode:'fast'});
  assert.deepEqual(pc525('fast food ordering app'), {type:'start', requirement:'fast food ordering app'});
  assert.deepEqual(pc525('mode'), {type:'mode'});
  assert.deepEqual(pc525('mode quick'), {type:'mode', mode:'quick'});
  assert.equal(pc525('mode turbo').type, 'modeInvalid');
});
test('v5.25: escalation rule', () => {
  assert.equal(shouldEscalateRequirement({findings:[{severity:'MEDIUM'}],blockers:[]}), false);
  assert.equal(shouldEscalateRequirement({findings:[{severity:'high'}]}), true);
  assert.equal(shouldEscalateRequirement({findings:[],blockers:['x']}), true);
  assert.equal(shouldEscalateRequirement({findings:[],escalate:true}), true);
  assert.equal(shouldEscalateRequirement(null), true);
});
test('v5.25: summary normalization caps and validates', () => {
  assert.throws(()=>normalizeRequirementSummary({baseline:'short',findings:[]}),/baseline/);
  const s=normalizeRequirementSummary({baseline:'Goal and scope and acceptance criteria here',findings:Array.from({length:60},(_,i)=>({severity:'low',title:'t'+i}))});
  assert.equal(s.findings.length,40); assert.equal(s.findings[0].severity,'LOW'); assert.equal(s.findings[0].id,'F-001');
});
test('v5.25: step graph per mode; legacy state stays thorough', () => {
  assert.equal(firstRequirementStep('fast'),'COOKING');
  assert.equal(firstRequirementStep('thorough'),'DISCOVERY');
  const legacy={phase:'REQUIREMENT',requirementStep:'COOKING',requirement:'x'};
  assert.deepEqual(afterRequirementStep(legacy),{step:'CHALLENGE'});
  assert.deepEqual(req525({...legacy,requirementStep:'DISCOVERY'}),['forge-requirement']);
  const fast={...legacy,requirementMode:'fast'};
  assert.deepEqual(afterRequirementStep(fast),{summary:true});
  assert.deepEqual(afterRequirementStep({...fast,requirementSummary:{escalate:false}}),{step:'CHALLENGE'}); // v5.26: always
  assert.deepEqual(afterRequirementStep({...legacy,requirementMode:'quick',requirementSummary:{escalate:false}}),{phase:'PLANNING'});
  assert.deepEqual(afterRequirementStep({...fast,requirementSummary:{escalate:true}}),{step:'CHALLENGE'});
  assert.deepEqual(req525({...fast,requirementStep:'DISCOVERY'}),[]);
  assert.equal(init525('Req').requirementStep,'DISCOVERY');
  assert.equal(init525('Req',undefined,null,null,{},'quick').requirementStep,'COOKING');
});

import { countReportedSeverities } from '../forge/core.mjs';
test('v5.26: severity label counting is word-bounded', () => {
  assert.deepEqual(countReportedSeverities('[HIGH] a; CRITICAL b; highway; HIGHLY'), {critical:1, high:1});
});

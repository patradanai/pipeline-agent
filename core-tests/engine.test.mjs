import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, normalizeAgentName } from '../core/engine.mjs';
import { PHASES, requiredAgentsFor, phaseInstruction } from '../core/core.mjs';
import { PLAN, SUBMISSION, FAIL_SUBMISSION } from './fixtures.mjs';
import { approvedExecutionState, assertDeliverySubmittable, qaReportTransition, reworkTransition, steerTransition } from '../core/transitions.mjs';

const REVIEWER = 'forge-code-reviewer';

function harness(config = {}, initial = null) {
  const saved = {};
  const engine = createEngine({ platform: 'claude-code', config, profile: { agentRef: n => `forge:${n}` }, deps: {
    snapshotWorkingTree: () => ({ available: true, hash: 'h', root: '/r' }),
    inspectWorkspaceScope: () => ({ available: true, files: ['a.ts'] }),
    savePlan: (_s, c) => { saved.plan = c; return '/data/plan.md'; },
    saveQaReport: (_s, md) => { saved.qa = md; return '/data/qa.md'; },
    saveDelivery: (_s, md, msg) => { saved.delivery = msg; return { deliveryPath: '/data/d.md', commitMessagePath: '/data/c.txt' }; },
  } });
  let state = initial;
  const h = ev => { const r = engine.handle(state, ev); state = r.state; return r.out; };
  const main = { kind: 'main', agent: null };
  return {
    saved, get state() { return state; },
    cmd: text => h({ type: 'command', text }),
    pre: (tool, input = {}, extra = {}) => h({ type: 'tool.pre', tool, input, actor: main, permissionMode: 'plan', ...extra }),
    post: (tool, input = {}, output = '', extra = {}) => h({ type: 'tool.post', tool, input, output, actor: main, ...extra }),
    fail: (tool, input = {}) => h({ type: 'tool.fail', tool, input, actor: main }),
    stop: () => h({ type: 'turn.end' }),
    agent(name, report = 'Report: [LOW][fact] fine (file.ts:1)') {
      const input = { subagent_type: `forge:${name}`, prompt: 'x' };
      const p = this.pre('agent', input);
      assert.notEqual(p.decision, 'deny', `${name} denied: ${p.reason}`);
      h({ type: 'agent.stop', agent: `forge:${name}`, agentId: `id-${name}-${Math.random()}`, report });
      return this.post('agent', input, ''); // background-style result: no report text here
    },
    agentStop: ev => h({ type: 'agent.stop', ...ev }),
    prompt: () => h({ type: 'prompt' }),
    runGate() { let o; for (const a of requiredAgentsFor(state)) o = this.agent(a); return o; },
  };
}

async function toApproval(x) {
  x.cmd('Build a booking system');
  assert.equal(x.state.phase, 'PLAN');
  assert.equal(x.pre('plan.submit', { plan: PLAN }).decision, undefined);
  assert.equal(x.state.phase, 'PLAN');
  assert.equal(x.state.planWritten, true);
  assert.equal(x.state.planValid, true);
  assert.equal(x.state.approved, false);
}

/** Approve, let the main agent implement, settle the turn: QA review starts. */
async function toQa(x) {
  await toApproval(x);
  x.post('plan.submit', { plan: PLAN });
  assert.equal(x.pre('write', { file_path: 'src/a.ts' }).decision, undefined);
  x.stop();
  assert.equal(x.state.phase, 'QA');
}

test('agent names: plugin-scoped and bare are equivalent', () => {
  assert.equal(normalizeAgentName(`forge:${REVIEWER}`), REVIEWER);
  assert.equal(normalizeAgentName(REVIEWER), REVIEWER);
});

test('three persisted phases; only QA review requires the reviewer agent', () => {
  assert.deepEqual(PHASES, ['PLAN', 'EXECUTE', 'QA']);
  assert.deepEqual(requiredAgentsFor({ phase: 'PLAN' }), []);
  assert.deepEqual(requiredAgentsFor({ phase: 'EXECUTE' }), []);
  assert.deepEqual(requiredAgentsFor({ phase: 'QA' }), [REVIEWER]);
  assert.deepEqual(requiredAgentsFor({ phase: 'QA', qaStatus: 'PASS' }), []);
});

test('no workflow → engine never interferes, not even with git', () => {
  const x = harness();
  assert.equal(x.pre('bash', { command: 'git push' }).decision, undefined);
  assert.equal(x.pre('write', { file_path: 'a' }).decision, undefined);
});

test('happy path: plan → native approval → main agent executes → QA with reviewer → delivery', async () => {
  const x = harness();
  const start = x.cmd('Build a booking system');
  assert.match(start.message, /Gates: plan/);
  assert.equal(x.state.phase, 'PLAN');
  assert.match(start.context, /GATE 1\/3: PLAN — Forge plan mode[\s\S]*Explore subagents[\s\S]*ExitPlanMode/);
  assert.doesNotMatch(start.context, /forge-requirement|forge-planner/);
  // the main agent explores; writes stay blocked before approval
  assert.equal(x.pre('agent', { subagent_type: 'Explore' }).decision, undefined);
  assert.equal(x.pre('write', { file_path: 'src/a.ts' }).decision, 'deny');
  // not in plan mode → denied
  assert.match(x.pre('plan.submit', { plan: PLAN }, { permissionMode: 'default' }).reason, /plan mode/);
  // invalid contract → denied with issues, still PLAN
  assert.match(x.pre('plan.submit', { plan: '# empty' }).reason, /plan contract is invalid/);
  assert.equal(x.state.phase, 'PLAN');
  // valid → awaiting native approval, plan stored, no agent required
  assert.equal(x.pre('plan.submit', { plan: PLAN }).decision, undefined);
  assert.equal(x.state.phase, 'PLAN'); assert.equal(x.state.approved, false); assert.equal(x.saved.plan, PLAN);
  assert.equal(x.pre('write', { file_path: 'src/a.ts' }).decision, 'deny');
  // native approval
  const appr = x.post('plan.submit', { plan: PLAN });
  assert.equal(x.state.phase, 'EXECUTE'); assert.equal(x.state.approved, true);
  assert.match(appr.context, /APPROVED EXECUTION[\s\S]*Execute it yourself/);
  assert.match(appr.message, /EXECUTE 2\/3/);
  // the main agent implements itself
  assert.equal(x.pre('write', { file_path: 'src/a.ts' }).decision, undefined);
  assert.equal(x.state.executionObserved, true);
  // stop → QA
  const toQaOut = x.stop();
  assert.equal(x.state.phase, 'QA'); assert.match(toQaOut.continueReason, /POST-EXECUTION QA REVIEW[\s\S]*forge:forge-code-reviewer/);
  assert.match(toQaOut.message, /QA 3\/3/);
  assert.equal(x.pre('write', { file_path: 'src/a.ts' }).decision, 'deny');
  assert.equal(x.pre('bash', { command: 'npm test' }).decision, undefined);
  assert.match(x.post('forge.qa_scope', {}).context, /a\.ts/);
  // a PASS code review needs the independent reviewer
  assert.match(x.pre('forge.qa_submit', SUBMISSION).reason, /Independent reviewer forge-code-reviewer must run before a PASS code review/);
  assert.equal(x.pre('forge.delivery_submit', { subject: 'feat(booking): add approvals' }).decision, 'deny');
  // the reviewer's report reaches the main agent on its next event (here: the Agent tool result)
  assert.match(x.runGate().context, /forge:forge-code-reviewer reported\. Merge its findings/);
  assert.equal(x.pre('forge.qa_submit', SUBMISSION).decision, undefined);
  const qa = x.post('forge.qa_submit', SUBMISSION);
  assert.equal(x.state.phase, 'QA'); assert.equal(x.state.qaStatus, 'PASS'); assert.match(qa.context, /QA GATE: PASS[\s\S]*Prepare delivery yourself/);
  // delivery: no further agent
  assert.deepEqual(requiredAgentsFor(x.state), []);
  assert.equal(x.pre('agent', { subagent_type: `forge:${REVIEWER}` }).decision, 'deny');
  assert.match(x.pre('forge.delivery_submit', { subject: 'bad subject' }).reason, /Conventional Commits/);
  assert.equal(x.pre('forge.delivery_submit', { subject: 'feat(booking): add approvals', body: '- approvals' }).decision, undefined);
  const d = x.post('forge.delivery_submit', { subject: 'feat(booking): add approvals', body: '- approvals' });
  assert.equal(x.state.phase, 'QA'); assert.equal(x.state.active, false);
  assert.match(d.context, /feat\(booking\): add approvals/);
});

test('rejected plan (tool failure) keeps execution unauthorized', async () => {
  const x = harness(); await toApproval(x);
  assert.match(x.fail('plan.submit', { plan: PLAN }).context, /NOT approved/);
  assert.equal(x.state.phase, 'PLAN'); assert.equal(x.state.approved, false);
  assert.equal(x.pre('write', { file_path: 'a.ts' }).decision, 'deny');
});

test('plan edited in the approval dialog into an invalid plan does not authorize execution', async () => {
  const x = harness(); await toApproval(x);
  const out = x.post('plan.submit', { plan: '# I deleted everything' });
  assert.equal(x.state.approved, false); assert.equal(x.state.phase, 'PLAN');
  assert.match(out.context, /NOT authorized/);
});

test('/forge approve is the human fallback only for a valid awaiting plan', async () => {
  const x = harness();
  x.cmd('Build a booking system');
  assert.match(x.cmd('approve').message, /Nothing to approve/);
  const y = harness(); await toApproval(y);
  assert.match(y.cmd('approve').message, /approved by you/);
  assert.equal(y.state.phase, 'EXECUTE');
});

test('QA FAIL shows the summary table and waits; /forge rework then requires a NEW different plan and new approval', async () => {
  const x = harness(); await toQa(x);
  x.runGate();
  const qa = x.post('forge.qa_submit', FAIL_SUBMISSION);
  assert.equal(x.state.phase, 'PLAN'); assert.equal(x.state.approved, false); assert.equal(x.state.qaStatus, 'FAIL');
  assert.equal(x.state.reworkDecisionPending, true);
  assert.match(qa.context, /### Forge QA ❌ FAIL[\s\S]*\| ❌ \| TC-001 \|[\s\S]*Show the user the QA summary table[\s\S]*\/forge-rework/);
  assert.doesNotMatch(qa.context, /REWORK PLAN/);
  // no fix plan, no nudge, no resubmission before the human decides
  assert.match(x.pre('plan.submit', { plan: PLAN + '\n## QA Rework Changes\n- fix 500\n' }).reason, /waiting for the user's decision/);
  assert.equal(x.pre('forge.qa_submit', FAIL_SUBMISSION).decision, 'deny');
  assert.equal(x.stop().continueReason, undefined);
  const go = x.cmd('rework');
  assert.equal(x.state.reworkDecisionPending, false);
  assert.match(go.context, /REWORK PLAN[\s\S]*there is no planner agent/);
  assert.match(x.pre('plan.submit', { plan: PLAN }).reason, /identical to the previously approved plan/);
  assert.equal(x.pre('plan.submit', { plan: PLAN + '\n## QA Rework Changes\n- fix 500\n' }).decision, undefined);
  assert.equal(x.state.phase, 'PLAN'); assert.equal(x.state.approved, false);
});
test('re-entering rework preserves the approved plan as a read-only base', () => {
  const first = reworkTransition({
    phase: 'QA', qaStatus: 'FAIL', approvedPlanHash: 'sha256-old',
    planPath: 'local://forge-plan.md', reworkCycles: 0,
  });
  const retried = reworkTransition(first);
  assert.equal(first.reworkBaseHash, 'sha256-old');
  assert.equal(retried, first);
  assert.equal(retried.reworkBasePlanPath, 'local://forge-plan.md');
  assert.equal(retried.planPath, null);
});

test('A FAIL → B approved → BLOCKED rework pairs the current approved hash and path', () => {
  const a = {
    active: true, phase: 'QA', approved: true, planValid: true, planWritten: true,
    requirement: 'Build bookings', slug: 'bookings', approvedPlanHash: 'sha256-A',
    planPath: 'local://plan-A.md', reworkCycles: 0,
  };
  const failed = qaReportTransition(a, { status: 'FAIL' }, { reportPath: 'local://qa-A.md' });
  assert.equal(failed.reworkBaseHash, 'sha256-A');
  assert.equal(failed.reworkBasePlanPath, 'local://plan-A.md');
  const b = approvedExecutionState({
    ...failed, approvedPlanHash: 'sha256-B', planPath: 'local://plan-B.md',
    planWritten: true, planValid: true,
  });
  assert.equal(b.reworkBaseHash, null);
  assert.equal(b.reworkBasePlanPath, null);
  const blocked = qaReportTransition({ ...b, phase: 'QA' }, { status: 'BLOCKED' }, { reportPath: 'local://qa-B.md' });
  const rework = reworkTransition(blocked);
  assert.equal(rework.reworkBaseHash, 'sha256-B');
  assert.equal(rework.reworkBasePlanPath, 'local://plan-B.md');
  assert.equal(rework.planPath, null);
  assert.equal(rework.approvedPlanHash, null);
  assert.equal(rework.reworkCycles, 2);
  const instruction = phaseInstruction(rework);
  assert.ok(instruction.includes('Previous approved plan: local://plan-B.md'));
  assert.ok(!instruction.includes('local://plan-A.md'));
});

test('rework with a pending unapproved proposal preserves the actual base and proposal', () => {
  const failed = qaReportTransition({
    active: true, phase: 'QA', approved: true, planValid: true, planWritten: true,
    requirement: 'Build bookings', slug: 'bookings', approvedPlanHash: 'sha256-A',
    planPath: 'local://plan-A.md', reworkCycles: 0,
  }, { status: 'FAIL' });
  const proposed = {
    ...failed, planPath: 'local://plan-B.md', approvedPlanHash: 'sha256-unapproved-B',
    planWritten: true, planValid: true, reviewRequested: true,
    gateAgents: { PLAN: [] }, agentRetries: { PLAN: 1 },
  };
  const restored = JSON.parse(JSON.stringify(proposed));
  const rework = reworkTransition(restored);
  assert.equal(rework, restored);
  assert.equal(rework.reworkBaseHash, 'sha256-A');
  assert.equal(rework.reworkBasePlanPath, 'local://plan-A.md');
  assert.equal(rework.approvedPlanHash, 'sha256-unapproved-B');
  assert.equal(rework.planPath, 'local://plan-B.md');
  assert.equal(rework.approved, false);
  assert.match(phaseInstruction(rework), /awaiting explicit operator approval/);
});

test('more than 20 steering prompts survive JSON restore verbatim in phaseInstruction', () => {
  const directives = [
    '  Never execute without explicit human plan approval.\nKeep this authorization boundary.  ',
    ...Array.from({ length: 24 }, (_, i) => `Steering ${i + 2}: retain requirement ${i + 2}.`),
  ];
  for (const phase of ['PLAN', 'EXECUTE', 'QA']) {
    let state = {
      active: true, phase, requirement: 'Build bookings', slug: 'bookings',
      approved: phase === 'EXECUTE' || phase === 'QA', approvedPlanHash: 'sha256-A',
      planPath: 'local://plan-A.md', reworkCycles: 0,
    };
    for (const text of directives) {
      state = JSON.parse(JSON.stringify(steerTransition(state, text, { at: '2026-01-01T00:00:00.000Z' })));
    }
    assert.equal(state.phase, 'PLAN', phase);
    assert.equal(state.requirementSteering.length, directives.length, phase);
    assert.deepEqual(state.requirementSteering.map(entry => entry.text), directives, phase);
    assert.deepEqual(state.requirementSteering.map(entry => entry.revision), directives.map((_, i) => i + 1), phase);
    const instruction = phaseInstruction(state);
    for (const text of directives) assert.ok(instruction.includes(text), `${phase}: missing ${text}`);
    assert.match(instruction, /Requirement steering — prompts from the user/, phase);
  }
});

test('QA status controls delivery without inferring PASS from phase', () => {
  const base = {
    active: true, phase: 'QA', approved: true, planValid: true,
    approvedPlanHash: 'approved-hash', planPath: 'local://forge-plan.md',
    gateAgents: { QA: [] }, reworkCycles: 0,
  };
  const blocked = qaReportTransition(base, { status: 'BLOCKED' });
  assert.equal(blocked.phase, 'QA');
  assert.equal(blocked.qaStatus, 'BLOCKED');
  assert.equal(blocked.approved, true);
  assert.equal(blocked.qaEvidencePending, true);
  assert.throws(() => assertDeliverySubmittable(blocked), /PASS QA gate/);
  assert.throws(() => assertDeliverySubmittable({ ...base, qaStatus: null }), /PASS QA gate/);

  const failed = qaReportTransition(base, { status: 'FAIL' });
  assert.equal(failed.phase, 'PLAN');
  assert.equal(failed.approved, false);
  assert.equal(failed.approvedPlanHash, null);
  assert.equal(failed.reworkBaseHash, 'approved-hash');
  assert.equal(failed.reworkBasePlanPath, 'local://forge-plan.md');
  assert.throws(() => assertDeliverySubmittable(failed), /PASS QA gate/);
});

test('QA FAIL rework prompt lists only the non-PASS items and revises the previous plan', () => {
  const base = {
    active: true, phase: 'QA', approved: true, planValid: true, requirement: 'Build bookings', slug: 'bookings',
    approvedPlanHash: 'approved-hash', planPath: 'local://forge-plan.md', reworkCycles: 0,
  };
  const report = {
    status: 'FAIL',
    topics: [{ id: 'BIZ-001', tests: [
      { testId: 'TC-001', requirementIds: ['REQ-001'], status: 'PASS', actual: 'booking created', fileRefs: [] },
      { testId: 'TC-002', requirementIds: ['REQ-002'], status: 'FAIL', actual: 'double booking\n accepted', fileRefs: ['src/book.ts'] },
    ] }],
    qualityChecks: [{ gateId: 'QG-001', name: 'unit tests', status: 'PASS' }, { gateId: 'QG-002', name: 'typecheck', status: 'FAIL' }],
    codeReview: { findings: [{ id: 'CR-1', title: 'race on slot lock', severity: 'HIGH', fileRefs: ['src/lock.ts'] }, { id: 'CR-2', title: 'naming', severity: 'LOW', fileRefs: [] }] },
    problems: [],
  };
  const rework = JSON.parse(JSON.stringify(qaReportTransition(base, report, { reportPath: '/data/qa.md' })));
  const instruction = phaseInstruction(rework);
  assert.match(instruction, /Fix scope \(non-PASS items from the QA report; fix only these\):\n- TC-002 FAIL \(BIZ-001,REQ-002\): double booking accepted \[src\/book\.ts\]\n- QG-002 FAIL: typecheck\n- CR-1 HIGH: race on slot lock \[src\/lock\.ts\]\n\n/);
  assert.doesNotMatch(instruction, /TC-001 PASS|QG-001 PASS|CR-2/);
  assert.match(instruction, /targeted lookup only/);
  assert.match(instruction, /from the previous approved plan's full text, not from scratch/);
  assert.equal(qaReportTransition(base, { ...report, status: 'PASS' }).qaOpenItems, null);

  const fixing = approvedExecutionState({ ...rework, approvedPlanHash: 'fix-hash', planPath: 'local://bookings-rework-1-plan.md', planWritten: true, planValid: true });
  const execution = phaseInstruction(fixing);
  assert.match(execution, /one item per remediation step/);
  assert.match(execution, /QA REWORK cycle #1: [^\n]*Implement only the remediation steps[\s\S]*- TC-002 FAIL \(BIZ-001,REQ-002\): double booking accepted \[src\/book\.ts\]/);
  const firstRun = phaseInstruction({ ...base, phase: 'EXECUTE' });
  assert.match(firstRun, /one item per plan step/);
  assert.doesNotMatch(firstRun, /QA REWORK/);
});


test('guards: git writes, publish MCP, .git, research agents, reviewer only in QA, specialist read-only', async () => {
  const x = harness(); x.cmd('Build a booking system');
  assert.match(x.pre('bash', { command: 'git commit -am x' }).reason, /Git writes must be manual/);
  assert.equal(x.pre('other', {}, { rawTool: 'mcp__github__create_pull_request' }).decision, 'deny');
  assert.equal(x.pre('agent', { subagent_type: 'Explore' }).decision, undefined);
  assert.equal(x.pre('agent', { subagent_type: `forge:${REVIEWER}` }).decision, 'deny');
  const sub = { kind: 'sub', agent: `forge:${REVIEWER}` };
  for (const tool of ['edit', 'write', 'bash']) {
    assert.match(x.pre(tool, { file_path: 'a', command: 'ls' }, { actor: sub }).reason, /Forge specialist is read-only/, tool);
  }
  assert.equal(x.pre('bash', { command: 'git status --short' }).decision, undefined); // safe discovery
  assert.equal(x.pre('bash', { command: 'rm -rf src' }).decision, 'deny');
  assert.equal(x.pre('other', {}, { rawTool: 'mcp__x__y' }).decision, 'deny'); // fail-closed pre-approval
  const y = harness(); await toApproval(y); y.post('plan.submit', { plan: PLAN });
  assert.equal(y.state.phase, 'EXECUTE');
  assert.equal(y.pre('agent', { subagent_type: `forge:${REVIEWER}` }).decision, 'deny');
  assert.equal(y.pre('agent', { subagent_type: 'Explore' }).decision, undefined);
  assert.equal(y.pre('write', { file_path: 'a' }, { actor: { kind: 'sub', agent: `forge:${REVIEWER}` } }).decision, 'deny');
});

test('empty subagent report: subagent is asked once, then main is told to re-run', async () => {
  const x = harness(); await toQa(x);
  x.pre('agent', { subagent_type: `forge:${REVIEWER}` });
  assert.match(x.agentStop({ agent: `forge:${REVIEWER}`, agentId: 'a1', report: '' }).continueReason, /final message/);
  assert.equal(x.agentStop({ agent: `forge:${REVIEWER}`, agentId: 'a1', report: '' }).continueReason, undefined);
  assert.match(x.prompt().context, /finished without a report/);
  assert.equal(x.state.phase, 'QA');
  assert.deepEqual(x.state.gateAgents.QA ?? [], []);
});

test('background agents: spawn result has no report; completion arrives later and is delivered on the next main event', async () => {
  const x = harness(); await toQa(x);
  const input = { subagent_type: `forge:${REVIEWER}` };
  x.pre('agent', input);
  assert.equal(x.post('agent', input, 'Backgrounded agent').context, undefined); // no false "no report"
  assert.equal(x.stop().continueReason, undefined); // still running → never ask to re-run
  x.agentStop({ agent: `forge:${REVIEWER}`, agentId: 'bg1', report: 'No findings' });
  const next = x.prompt();
  assert.match(next.context, /forge:forge-code-reviewer reported\. Merge its findings/);
  assert.equal(x.state.pendingContext, null);
});

test('report delivered through a handback tool counts even if the final message is short', async () => {
  const x = harness(); await toQa(x);
  x.pre('agent', { subagent_type: `forge:${REVIEWER}` });
  const sub = { kind: 'sub', agent: `forge:${REVIEWER}`, agentId: 'h1' };
  assert.equal(x.pre('coord', {}, { actor: sub, rawTool: 'SubagentHandback', inputText: '- CR-001 [HIGH] missing tenant id (a.ts:3)' }).decision, undefined);
  x.agentStop({ agent: `forge:${REVIEWER}`, agentId: 'h1', report: '' });
  assert.deepEqual(x.state.gateAgents.QA, [REVIEWER]);
  assert.match(x.state.agentCompletions.at(-1).resultPreview, /CR-001/);
});

test('coordination tools are allowed before approval (main and subagents)', () => {
  const x = harness(); x.cmd('Build a booking system');
  assert.equal(x.pre('coord', {}, { rawTool: 'SendMessage' }).decision, undefined);
  assert.equal(x.pre('coord', {}, { rawTool: 'TaskStop', actor: { kind: 'sub', agent: 'Explore', agentId: 'c' } }).decision, undefined);
});

test('Stop delivers a queued gate instruction instead of ending the turn', async () => {
  const x = harness(); await toQa(x);
  x.pre('agent', { subagent_type: `forge:${REVIEWER}` });
  x.agentStop({ agent: `forge:${REVIEWER}`, agentId: 'q1', report: 'ok' });
  assert.match(x.stop().continueReason, /reported\. Merge its findings/);
});

test('Stop nudges are capped (no infinite loops)', async () => {
  const x = harness(); await toQa(x);
  assert.match(x.stop().continueReason, /Forge QA is incomplete/);
  assert.ok(x.stop().continueReason);
  assert.equal(x.stop().continueReason, undefined);
  // after QA PASS: the delivery nudge, also capped
  const y = harness(); await toQa(y);
  y.runGate(); y.prompt();
  y.post('forge.qa_submit', SUBMISSION);
  assert.equal(y.state.qaStatus, 'PASS');
  assert.match(y.stop().continueReason, /Forge delivery is incomplete: call forge_delivery_submit once/);
  assert.ok(y.stop().continueReason);
  assert.equal(y.stop().continueReason, undefined);
});

test('/forge off writes a tombstone; afterwards the session is unguarded', () => {
  const x = harness(); x.cmd('Build a booking system');
  x.cmd('off');
  assert.equal(x.state.active, false); assert.equal(typeof x.state.cancelledSlug, 'string');
  assert.equal(x.pre('write', { file_path: 'a' }).decision, undefined);
});

test('legacy v6.0 requirement-gate state with requirementStep restores as PLAN without approval', () => {
  const legacy = { active: true, version: 8, phase: 'REQUIREMENT', requirement: 'Build CRM', slug: 'forge-old', approved: true,
    requirementStep: 'COOKING', requirementMode: 'thorough', agentRetries: { 'REQUIREMENT:COOKING': 2 },
    gateAgents: { 'REQUIREMENT:DISCOVERY': ['forge-requirement'] }, requirementSummary: { baseline: 'old fast-mode summary text here', findings: [] } };
  const x = harness({}, legacy);
  x.prompt(); // any event normalizes the restored state
  assert.equal(x.state.phase, 'PLAN');
  assert.equal(x.state.approved, false);
  assert.deepEqual(requiredAgentsFor(x.state), []);
  assert.deepEqual(x.state.gateAgents, {});
  assert.equal(x.pre('write', { file_path: 'src/a.ts' }).decision, 'deny');
  assert.equal(x.pre('plan.submit', { plan: PLAN }).decision, undefined);
  assert.equal(x.state.planValid, true);
});

test('plan written to the host plan file (no inline plan) is validated and approved', () => {
  const files = { '/home/u/.claude/plans/p.md': PLAN };
  const engine = createEngine({ platform: 'claude-code', deps: { readPlanFile: p => files[p] ?? '' } });
  let st = null; const h = ev => { const r = engine.handle(st, ev); st = r.state; return r.out; };
  const main = { kind: 'main' };
  h({ type: 'command', text: 'Build a booking system' });
  assert.equal(st.phase, 'PLAN');
  assert.equal(h({ type: 'tool.pre', tool: 'plan.write', input: { file_path: '/home/u/.claude/plans/p.md' }, planFile: '/home/u/.claude/plans/p.md', actor: main }).decision, undefined);
  assert.equal(h({ type: 'tool.pre', tool: 'plan.submit', input: {}, actor: main, permissionMode: 'plan' }).decision, undefined);
  assert.equal(st.phase, 'PLAN'); assert.equal(st.approved, false);
  h({ type: 'tool.post', tool: 'plan.submit', input: {}, actor: main });
  assert.equal(st.phase, 'EXECUTE');
  assert.equal(h({ type: 'tool.pre', tool: 'plan.write', input: {}, planFile: '/x/plans/p.md', actor: main }).decision, 'deny'); // not after approval
});

test('token guard: a specialist cannot be re-run while running or after it reported (rigor unchanged)', async () => {
  const x = harness(); await toQa(x);
  const input = { subagent_type: `forge:${REVIEWER}` };
  assert.equal(x.pre('agent', input).decision, undefined);
  assert.match(x.pre('agent', input).reason, /still running/);
  x.agentStop({ agent: `forge:${REVIEWER}`, agentId: 'r1', report: 'No findings' });
  // one counted pass per gate: a second run after the report is refused
  assert.match(x.pre('agent', input).reason, /already reported for QA/);
  assert.equal(x.state.phase, 'QA');
});

test('a run that never stops does not block forever', async () => {
  const x = harness(); await toQa(x);
  x.pre('agent', { subagent_type: `forge:${REVIEWER}` });
  const real = Date.now; Date.now = () => real() + 31 * 60 * 1000;
  try { assert.equal(x.pre('agent', { subagent_type: `forge:${REVIEWER}` }).decision, undefined); } finally { Date.now = real; }
});

test('a nudged subagent (empty report) stays marked as running', async () => {
  const x = harness(); await toQa(x);
  x.pre('agent', { subagent_type: `forge:${REVIEWER}` });
  x.agentStop({ agent: `forge:${REVIEWER}`, agentId: 'n1', report: '' });
  assert.match(x.pre('agent', { subagent_type: `forge:${REVIEWER}` }).reason, /still running/);
});

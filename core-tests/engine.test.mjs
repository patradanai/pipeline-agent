import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, normalizeAgentName } from '../core/engine.mjs';
import { PHASES, requiredAgentsFor, phaseInstruction } from '../core/core.mjs';
import { PLAN, SUBMISSION, FAIL_SUBMISSION } from './fixtures.mjs';
import { approvedExecutionState, assertDeliverySubmittable, qaReportTransition, reworkTransition, steerTransition } from '../core/transitions.mjs';

const SUMMARY = { baseline: 'Goal: bookings with approvals. Scope: create + approve. Acceptance: both flows work.', findings: [{ severity: 'LOW', title: 'naming' }] };

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
    summarize(summary = SUMMARY) {
      const p = this.pre('forge.requirement_summary', summary);
      assert.equal(p.decision, undefined, `summary denied: ${p.reason}`);
      return this.post('forge.requirement_summary', summary);
    },
  };
}

async function toApproval(x) {
  x.cmd('Build a booking system');
  x.runGate(); x.summarize();
  assert.equal(x.state.phase, 'PLAN');
  x.runGate();
  assert.equal(x.pre('plan.submit', { plan: PLAN }).decision, undefined);
  assert.equal(x.state.phase, 'PLAN');
  assert.equal(x.state.planWritten, true);
  assert.equal(x.state.planValid, true);
  assert.equal(x.state.approved, false);
}

test('agent names: plugin-scoped and bare are equivalent', () => {
  assert.equal(normalizeAgentName('forge:forge-planner'), 'forge-planner');
  assert.equal(normalizeAgentName('forge-planner'), 'forge-planner');
});

test('four persisted phases route QA PASS to delivery without a fifth phase', () => {
  assert.deepEqual(PHASES, ['REQUIREMENT', 'PLAN', 'EXECUTE', 'QA']);
  assert.deepEqual(requiredAgentsFor({ phase: 'QA' }), ['forge-qa', 'forge-code-reviewer']);
  assert.deepEqual(requiredAgentsFor({ phase: 'QA', qaStatus: 'PASS' }), ['forge-delivery']);
});

test('no workflow → engine never interferes, not even with git', () => {
  const x = harness();
  assert.equal(x.pre('bash', { command: 'git push' }).decision, undefined);
  assert.equal(x.pre('write', { file_path: 'a' }).decision, undefined);
});

test('happy path: one requirement pass + summary → planning → native approval → execute → QA PASS → delivery', async () => {
  const x = harness();
  const start = x.cmd('Build a booking system');
  assert.doesNotMatch(start.message, /thorough/);
  assert.match(start.context, /GATE 1\/4: REQUIREMENT[\s\S]*forge:forge-requirement/);
  assert.deepEqual(requiredAgentsFor(x.state), ['forge-requirement']);
  // planning cannot be skipped: the summary needs the report first
  assert.match(x.pre('forge.requirement_summary', SUMMARY).reason, /requirement report missing/);
  assert.match(x.runGate().context, /^\[FORGE REQUIREMENT — report received\]/);
  assert.equal(x.state.phase, 'REQUIREMENT');
  const planning = x.summarize({ ...SUMMARY, blockers: ['approver role undecided'] });
  assert.equal(x.state.phase, 'PLAN');
  assert.match(planning.context, /requirement summary recorded/i);
  assert.match(planning.context, /GATE 2\/4: PLAN[\s\S]*approver role undecided[\s\S]*ExitPlanMode/);
  // plan before planner → denied
  assert.match(x.pre('plan.submit', { plan: PLAN }).reason, /forge:forge-planner/);
  assert.match(x.runGate().context, /PLANNER REPORT RECEIVED/);
  // not in plan mode → denied
  assert.match(x.pre('plan.submit', { plan: PLAN }, { permissionMode: 'default' }).reason, /plan mode/);
  // invalid contract → denied with issues, still PLANNING
  assert.match(x.pre('plan.submit', { plan: '# empty' }).reason, /plan contract is invalid/);
  assert.equal(x.state.phase, 'PLAN');
  // valid → awaiting native approval, plan stored
  assert.equal(x.pre('plan.submit', { plan: PLAN }).decision, undefined);
  assert.equal(x.state.phase, 'PLAN'); assert.equal(x.state.approved, false); assert.equal(x.saved.plan, PLAN);
  // writes still blocked while awaiting approval
  assert.equal(x.pre('write', { file_path: 'src/a.ts' }).decision, 'deny');
  // native approval
  const appr = x.post('plan.submit', { plan: PLAN });
  assert.equal(x.state.phase, 'EXECUTE'); assert.equal(x.state.approved, true);
  assert.match(appr.context, /APPROVED EXECUTION/);
  // first main action marks execution observed; executor spawned
  x.agent('forge-executor', 'Changed booking.ts');
  // stop → QA
  const toQa = x.stop();
  assert.equal(x.state.phase, 'QA'); assert.match(toQa.continueReason, /POST-EXECUTION QA REVIEW/);
  assert.equal(x.pre('write', { file_path: 'src/a.ts' }).decision, 'deny');
  assert.equal(x.pre('bash', { command: 'npm test' }).decision, undefined);
  assert.match(x.post('forge.qa_scope', {}).context, /a\.ts/);
  assert.equal(x.pre('forge.delivery_submit', { subject: 'feat(booking): add approvals' }).decision, 'deny');
  x.runGate();
  assert.equal(x.pre('forge.qa_submit', SUBMISSION).decision, undefined);
  const qa = x.post('forge.qa_submit', SUBMISSION);
  assert.equal(x.state.phase, 'QA'); assert.equal(x.state.qaStatus, 'PASS'); assert.match(qa.context, /QA GATE: PASS/);
  assert.equal(x.pre('forge.delivery_submit', { subject: 'feat(booking): add approvals' }).decision, 'deny');
  x.runGate();
  assert.match(x.pre('forge.delivery_submit', { subject: 'bad subject' }).reason, /Conventional Commits/);
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
  await toApproval(harness()); // independent
  const y = harness(); await toApproval(y);
  assert.match(y.cmd('approve').message, /approved by you/);
  assert.equal(y.state.phase, 'EXECUTE');
});

test('QA FAIL → rework requires a NEW different plan and new approval', async () => {
  const x = harness(); await toApproval(x);
  x.post('plan.submit', { plan: PLAN });
  x.agent('forge-executor', 'done'); x.stop(); x.runGate();
  const qa = x.post('forge.qa_submit', FAIL_SUBMISSION);
  assert.equal(x.state.phase, 'PLAN'); assert.equal(x.state.approved, false); assert.equal(x.state.qaStatus, 'FAIL');
  assert.match(qa.context, /REWORK PLAN/);
  x.runGate();
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
    gateAgents: { PLAN: ['forge-planner'] }, agentRetries: { PLAN: 1 },
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
  for (const phase of ['REQUIREMENT', 'PLAN', 'EXECUTE', 'QA']) {
    let state = {
      active: true, phase, requirement: 'Build bookings', slug: 'bookings',
      approved: phase === 'EXECUTE' || phase === 'QA', approvedPlanHash: 'sha256-A',
      planPath: 'local://plan-A.md', reworkCycles: 0,
    };
    for (const text of directives) {
      state = JSON.parse(JSON.stringify(steerTransition(state, text, { at: '2026-01-01T00:00:00.000Z' })));
    }
    assert.equal(state.requirementSteering.length, directives.length, phase);
    assert.deepEqual(state.requirementSteering.map(entry => entry.text), directives, phase);
    assert.deepEqual(state.requirementSteering.map(entry => entry.revision), directives.map((_, i) => i + 1), phase);
    const instruction = phaseInstruction(state);
    for (const text of directives) assert.ok(instruction.includes(text), `${phase}: missing ${text}`);
    assert.match(instruction, /every (?:requirement )?steering prompt verbatim/, phase);
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


test('guards: git writes, publish MCP, .git, wrong agent, specialist writes, executor shell', async () => {
  const x = harness(); x.cmd('Build a booking system');
  assert.match(x.pre('bash', { command: 'git commit -am x' }).reason, /Git writes must be manual/);
  assert.equal(x.pre('other', {}, { rawTool: 'mcp__github__create_pull_request' }).decision, 'deny');
  assert.equal(x.pre('agent', { subagent_type: 'forge:forge-executor' }).decision, 'deny');
  assert.equal(x.pre('agent', { subagent_type: 'Explore' }).decision, undefined);
  const sub = { kind: 'sub', agent: 'forge:forge-planner' };
  assert.equal(x.pre('edit', { file_path: 'a' }, { actor: sub }).decision, 'deny');
  const exec = { kind: 'sub', agent: 'forge:forge-executor' };
  assert.equal(x.pre('bash', { command: 'ls' }, { actor: exec }).decision, 'deny');
  assert.equal(x.pre('write', { file_path: 'a' }, { actor: exec }).decision, 'deny'); // not EXECUTING yet
  assert.equal(x.pre('bash', { command: 'git status --short' }).decision, undefined); // safe discovery
  assert.equal(x.pre('bash', { command: 'rm -rf src' }).decision, 'deny');
  assert.equal(x.pre('other', {}, { rawTool: 'mcp__x__y' }).decision, 'deny'); // fail-closed pre-approval
});

test('empty subagent report: subagent is asked once, then main is told to re-run', () => {
  const x = harness(); x.cmd('Build a booking system');
  x.pre('agent', { subagent_type: 'forge:forge-requirement' });
  assert.match(x.agentStop({ agent: 'forge:forge-requirement', agentId: 'a1', report: '' }).continueReason, /final message/);
  assert.equal(x.agentStop({ agent: 'forge:forge-requirement', agentId: 'a1', report: '' }).continueReason, undefined);
  assert.match(x.prompt().context, /finished without a report/);
  assert.equal(x.state.phase, 'REQUIREMENT');
  assert.deepEqual(x.state.gateAgents.REQUIREMENT ?? [], []);
});

test('background agents: spawn result has no report; completion arrives later and is delivered on the next main event', () => {
  const x = harness(); x.cmd('Build a booking system');
  const input = { subagent_type: 'forge:forge-requirement' };
  x.pre('agent', input);
  assert.equal(x.post('agent', input, 'Backgrounded agent').context, undefined); // no false "no report"
  assert.equal(x.stop().continueReason, undefined); // still running → never ask to re-run
  x.agentStop({ agent: 'forge:forge-requirement', agentId: 'bg1', report: 'Baseline: …' });
  assert.equal(x.state.requirementSummaryRequested, true);
  const next = x.prompt();
  assert.match(next.context, /FORGE REQUIREMENT — report received/);
  assert.equal(x.state.pendingContext, null);
});

test('report delivered through a handback tool counts even if the final message is short', () => {
  const x = harness(); x.cmd('Build a booking system');
  x.pre('agent', { subagent_type: 'forge:forge-requirement' });
  const sub = { kind: 'sub', agent: 'forge:forge-requirement', agentId: 'h1' };
  assert.equal(x.pre('coord', {}, { actor: sub, rawTool: 'SubagentHandback', inputText: '- [HIGH][fact] missing tenant id' }).decision, undefined);
  x.agentStop({ agent: 'forge:forge-requirement', agentId: 'h1', report: '' });
  assert.deepEqual(x.state.gateAgents.REQUIREMENT, ['forge-requirement']);
  assert.equal(x.state.agentCompletions.at(-1).reportedSeverities.high, 1);
});

test('coordination tools are allowed before approval (main and subagents)', () => {
  const x = harness(); x.cmd('Build a booking system');
  assert.equal(x.pre('coord', {}, { rawTool: 'SendMessage' }).decision, undefined);
  assert.equal(x.pre('coord', {}, { rawTool: 'TaskStop', actor: { kind: 'sub', agent: 'forge:forge-planner', agentId: 'c' } }).decision, undefined);
});

test('Stop delivers a queued gate instruction instead of ending the turn', () => {
  const x = harness(); x.cmd('Build a booking system');
  x.pre('agent', { subagent_type: 'forge:forge-requirement' });
  x.agentStop({ agent: 'forge:forge-requirement', agentId: 'q1', report: 'ok' });
  assert.match(x.stop().continueReason, /FORGE REQUIREMENT — report received/);
});

test('summary cross-check: a report\'s CRITICAL/HIGH cannot vanish from the summary', () => {
  const x = harness(); x.cmd('Build CRM');
  x.agent('forge-requirement', '- [HIGH][fact] no tenant column\n- [CRITICAL][assumption] PII export');
  assert.match(x.pre('forge.requirement_summary', SUMMARY).reason, /1 CRITICAL and 1 HIGH label\(s\), but the summary lists no CRITICAL\/HIGH finding/);
  assert.match(x.post('forge.requirement_summary', SUMMARY).context, /rejected/);
  assert.equal(x.state.phase, 'REQUIREMENT');
  assert.match(x.pre('forge.requirement_summary', { ...SUMMARY, baseline: 'short' }).reason, /needs a baseline/);
  assert.match(x.pre('forge.requirement_summary', { ...SUMMARY, findings: [{ severity: 'URGENT', title: 'x' }] }).reason, /Finding 1 needs severity CRITICAL\|HIGH\|MEDIUM\|LOW/);
  const ok = { ...SUMMARY, findings: [{ severity: 'HIGH', title: 'No tenant column' }] };
  assert.match(x.summarize(ok).context, /recorded \(1 CRITICAL\/HIGH, 0 open blocker\(s\)\)/);
  assert.deepEqual(x.state.requirementSummary.specialistSeverities, { critical: 1, high: 1 });
  // a second summary is refused: the gate already moved on
  assert.match(x.pre('forge.requirement_summary', ok).reason, /no Forge REQUIREMENT gate is active/);
});

test('Stop nudges are capped (no infinite loops)', () => {
  const x = harness(); x.cmd('Build a booking system');
  assert.match(x.stop().continueReason, /forge:forge-requirement has not reported\. Invoke it once/);
  assert.ok(x.stop().continueReason);
  assert.equal(x.stop().continueReason, undefined);
  // after the report: the summary is asked for, also capped
  const y = harness(); y.cmd('Build a booking system');
  y.agent('forge-requirement');
  assert.match(y.stop().continueReason, /FORGE REQUIREMENT — report received/); // no queued text left (delivered on Agent post) → nudge 1
  assert.match(y.stop().continueReason, /FORGE REQUIREMENT — report received/);
  assert.equal(y.stop().continueReason, undefined);
});

test('/forge off writes a tombstone; afterwards the session is unguarded', () => {
  const x = harness(); x.cmd('Build a booking system');
  x.cmd('off');
  assert.equal(x.state.active, false); assert.equal(typeof x.state.cancelledSlug, 'string');
  assert.equal(x.pre('write', { file_path: 'a' }).decision, undefined);
});

test('former mode words are plain requirement text', () => {
  const x = harness(); x.cmd('quick Fix the login bug');
  assert.equal(x.state.phase, 'REQUIREMENT'); assert.equal(x.state.requirement, 'quick Fix the login bug');
  assert.deepEqual(requiredAgentsFor(x.state), ['forge-requirement']);
  const y = harness(); y.cmd('mode');
  assert.equal(y.state.requirement, 'mode');
});

test('legacy v6.0 state with requirementStep still completes the requirement gate', () => {
  const legacy = { active: true, version: 8, phase: 'REQUIREMENT', requirement: 'Build CRM', slug: 'forge-old',
    requirementStep: 'COOKING', requirementMode: 'thorough', agentRetries: { 'REQUIREMENT:COOKING': 2 },
    gateAgents: { 'REQUIREMENT:DISCOVERY': ['forge-requirement'] }, requirementSummary: { baseline: 'old fast-mode summary text here', findings: [] } };
  const x = harness({}, legacy);
  assert.deepEqual(requiredAgentsFor(x.state), ['forge-requirement']);
  x.agent('forge-requirement');
  assert.deepEqual(x.state.gateAgents.REQUIREMENT, ['forge-requirement']);
  x.summarize();
  assert.equal(x.state.phase, 'PLAN');
  assert.equal(x.state.requirementSummary.baseline, SUMMARY.baseline);
});

test('plan written to the host plan file (no inline plan) is validated and approved', () => {
  const files = { '/home/u/.claude/plans/p.md': PLAN };
  const engine = createEngine({ platform: 'claude-code', deps: { readPlanFile: p => files[p] ?? '' } });
  let st = null; const h = ev => { const r = engine.handle(st, ev); st = r.state; return r.out; };
  const main = { kind: 'main' };
  h({ type: 'command', text: 'Build a booking system' });
  const runGate = () => { for (const a of requiredAgentsFor(st)) {
    h({ type: 'tool.pre', tool: 'agent', input: { subagent_type: `forge:${a}` }, actor: main });
    h({ type: 'agent.stop', agent: `forge:${a}`, agentId: a, report: 'ok' });
  } };
  runGate();
  h({ type: 'tool.post', tool: 'forge.requirement_summary', input: SUMMARY, actor: main });
  assert.equal(st.phase, 'PLAN');
  runGate();
  assert.equal(h({ type: 'tool.pre', tool: 'plan.write', input: { file_path: '/home/u/.claude/plans/p.md' }, planFile: '/home/u/.claude/plans/p.md', actor: main }).decision, undefined);
  assert.equal(h({ type: 'tool.pre', tool: 'plan.submit', input: {}, actor: main, permissionMode: 'plan' }).decision, undefined);
  assert.equal(st.phase, 'PLAN'); assert.equal(st.approved, false);
  h({ type: 'tool.post', tool: 'plan.submit', input: {}, actor: main });
  assert.equal(st.phase, 'EXECUTE');
  assert.equal(h({ type: 'tool.pre', tool: 'plan.write', input: {}, planFile: '/x/plans/p.md', actor: main }).decision, 'deny'); // not after approval
});

test('token guard: a specialist cannot be re-run while running or after it reported (rigor unchanged)', () => {
  const x = harness(); x.cmd('Build a booking system');
  const input = { subagent_type: 'forge:forge-requirement' };
  assert.equal(x.pre('agent', input).decision, undefined);
  assert.match(x.pre('agent', input).reason, /still running/);
  x.agentStop({ agent: 'forge:forge-requirement', agentId: 'r1', report: 'baseline' });
  // one counted pass per gate: a second run after the report is refused
  assert.match(x.pre('agent', input).reason, /already reported for REQUIREMENT/);
  assert.equal(x.state.phase, 'REQUIREMENT');
});

test('a run that never stops does not block forever', () => {
  const x = harness(); x.cmd('Build a booking system');
  x.pre('agent', { subagent_type: 'forge:forge-requirement' });
  const real = Date.now; Date.now = () => real() + 31 * 60 * 1000;
  try { assert.equal(x.pre('agent', { subagent_type: 'forge:forge-requirement' }).decision, undefined); } finally { Date.now = real; }
});

test('a nudged subagent (empty report) stays marked as running', () => {
  const x = harness(); x.cmd('Build a booking system');
  x.pre('agent', { subagent_type: 'forge:forge-requirement' });
  x.agentStop({ agent: 'forge:forge-requirement', agentId: 'n1', report: '' });
  assert.match(x.pre('agent', { subagent_type: 'forge:forge-requirement' }).reason, /still running/);
});

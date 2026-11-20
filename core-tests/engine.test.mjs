import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, normalizeAgentName } from '../core/engine.mjs';
import { requiredAgentsFor } from '../core/core.mjs';
import { PLAN, SUBMISSION, FAIL_SUBMISSION } from './fixtures.mjs';

function harness(config = {}) {
  const saved = {};
  const engine = createEngine({ platform: 'claude-code', config, profile: { agentRef: n => `forge:${n}` }, deps: {
    snapshotWorkingTree: () => ({ available: true, hash: 'h', root: '/r' }),
    inspectWorkspaceScope: () => ({ available: true, files: ['a.ts'] }),
    savePlan: (_s, c) => { saved.plan = c; return '/data/plan.md'; },
    saveQaReport: (_s, md) => { saved.qa = md; return '/data/qa.md'; },
    saveDelivery: (_s, md, msg) => { saved.delivery = msg; return { deliveryPath: '/data/d.md', commitMessagePath: '/data/c.txt' }; },
  } });
  let state = null;
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
  for (let i = 0; i < 3; i++) x.runGate();
  assert.equal(x.state.phase, 'PLANNING');
  x.runGate();
  assert.equal(x.pre('plan.submit', { plan: PLAN }).decision, undefined);
  assert.equal(x.state.phase, 'AWAITING_APPROVAL');
}

test('agent names: plugin-scoped and bare are equivalent', () => {
  assert.equal(normalizeAgentName('forge:forge-planner'), 'forge-planner');
  assert.equal(normalizeAgentName('forge-planner'), 'forge-planner');
});

test('no workflow → engine never interferes, not even with git', () => {
  const x = harness();
  assert.equal(x.pre('bash', { command: 'git push' }).decision, undefined);
  assert.equal(x.pre('write', { file_path: 'a' }).decision, undefined);
});

test('thorough happy path: requirement ×3 → planning → native approval → execute → QA PASS → delivery', async () => {
  const x = harness();
  const start = x.cmd('Build a booking system');
  assert.equal(x.state.requirementMode, 'thorough');
  assert.match(start.context, /discovery step 1\/3/);
  assert.match(x.runGate().context, /cooking step 2\/3/);
  assert.match(x.runGate().context, /challenge step 3\/3[\s\S]*ONE parallel task batch/);
  assert.match(x.runGate().context, /GATE 2\/6: PLANNING[\s\S]*ExitPlanMode/);
  // plan before planner → denied
  assert.match(x.pre('plan.submit', { plan: PLAN }).reason, /forge:forge-planner/);
  assert.match(x.runGate().context, /PLANNER REPORT RECEIVED/);
  // not in plan mode → denied
  assert.match(x.pre('plan.submit', { plan: PLAN }, { permissionMode: 'default' }).reason, /plan mode/);
  // invalid contract → denied with issues, still PLANNING
  assert.match(x.pre('plan.submit', { plan: '# empty' }).reason, /plan contract is invalid/);
  assert.equal(x.state.phase, 'PLANNING');
  // valid → awaiting native approval, plan stored
  assert.equal(x.pre('plan.submit', { plan: PLAN }).decision, undefined);
  assert.equal(x.state.phase, 'AWAITING_APPROVAL'); assert.equal(x.saved.plan, PLAN);
  // writes still blocked while awaiting approval
  assert.equal(x.pre('write', { file_path: 'src/a.ts' }).decision, 'deny');
  // native approval
  const appr = x.post('plan.submit', { plan: PLAN });
  assert.equal(x.state.phase, 'EXECUTING'); assert.equal(x.state.approved, true);
  assert.match(appr.context, /APPROVED EXECUTION/);
  // first main action marks execution observed; executor spawned
  x.agent('forge-executor', 'Changed booking.ts');
  // stop → QA
  const toQa = x.stop();
  assert.equal(x.state.phase, 'QA_REVIEW'); assert.match(toQa.continueReason, /POST-EXECUTION QA REVIEW/);
  assert.equal(x.pre('write', { file_path: 'src/a.ts' }).decision, 'deny');
  assert.equal(x.pre('bash', { command: 'npm test' }).decision, undefined);
  assert.match(x.post('forge.qa_scope', {}).context, /a\.ts/);
  x.runGate();
  assert.equal(x.pre('forge.qa_submit', SUBMISSION).decision, undefined);
  const qa = x.post('forge.qa_submit', SUBMISSION);
  assert.equal(x.state.phase, 'DELIVERY_PREP'); assert.match(qa.context, /QA GATE: PASS/);
  x.runGate();
  assert.match(x.pre('forge.delivery_submit', { subject: 'bad subject' }).reason, /Conventional Commits/);
  const d = x.post('forge.delivery_submit', { subject: 'feat(booking): add approvals', body: '- approvals' });
  assert.equal(x.state.phase, 'DELIVERY'); assert.equal(x.state.active, false);
  assert.match(d.context, /feat\(booking\): add approvals/);
});

test('rejected plan (tool failure) keeps execution unauthorized', async () => {
  const x = harness(); await toApproval(x);
  assert.match(x.fail('plan.submit', { plan: PLAN }).context, /NOT approved/);
  assert.equal(x.state.phase, 'AWAITING_APPROVAL'); assert.equal(x.state.approved, false);
  assert.equal(x.pre('write', { file_path: 'a.ts' }).decision, 'deny');
});

test('plan edited in the approval dialog into an invalid plan does not authorize execution', async () => {
  const x = harness(); await toApproval(x);
  const out = x.post('plan.submit', { plan: '# I deleted everything' });
  assert.equal(x.state.approved, false); assert.equal(x.state.phase, 'PLANNING');
  assert.match(out.context, /NOT authorized/);
});

test('/forge approve is the human fallback only for a valid awaiting plan', async () => {
  const x = harness();
  x.cmd('Build a booking system');
  assert.match(x.cmd('approve').message, /Nothing to approve/);
  await toApproval(harness()); // independent
  const y = harness(); await toApproval(y);
  assert.match(y.cmd('approve').message, /approved by you/);
  assert.equal(y.state.phase, 'EXECUTING');
});

test('QA FAIL → rework requires a NEW different plan and new approval', async () => {
  const x = harness(); await toApproval(x);
  x.post('plan.submit', { plan: PLAN });
  x.agent('forge-executor', 'done'); x.stop(); x.runGate();
  const qa = x.post('forge.qa_submit', FAIL_SUBMISSION);
  assert.equal(x.state.phase, 'REWORK_PLANNING'); assert.equal(x.state.approved, false);
  assert.match(qa.context, /REWORK PLAN/);
  x.runGate();
  assert.match(x.pre('plan.submit', { plan: PLAN }).reason, /identical to the previously approved plan/);
  assert.equal(x.pre('plan.submit', { plan: PLAN + '\n## QA Rework Changes\n- fix 500\n' }).decision, undefined);
  assert.equal(x.state.phase, 'AWAITING_APPROVAL');
});

test('guards: git writes, publish MCP, .git, wrong agent, specialist writes, executor shell', async () => {
  const x = harness(); x.cmd('Build a booking system');
  assert.match(x.pre('bash', { command: 'git commit -am x' }).reason, /Git writes must be manual/);
  assert.equal(x.pre('other', {}, { rawTool: 'mcp__github__create_pull_request' }).decision, 'deny');
  assert.equal(x.pre('agent', { subagent_type: 'forge:forge-executor' }).decision, 'deny');
  assert.equal(x.pre('agent', { subagent_type: 'Explore' }).decision, undefined);
  const sub = { kind: 'sub', agent: 'forge:forge-critic' };
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
  assert.equal(x.state.requirementStep, 'DISCOVERY');
});

test('background agents: spawn result has no report; completion arrives later and is delivered on the next main event', () => {
  const x = harness(); x.cmd('Build a booking system');
  const input = { subagent_type: 'forge:forge-requirement' };
  x.pre('agent', input);
  assert.equal(x.post('agent', input, 'Backgrounded agent').context, undefined); // no false "no report"
  assert.equal(x.stop().continueReason, undefined); // still running → never ask to re-run
  x.agentStop({ agent: 'forge:forge-requirement', agentId: 'bg1', report: 'Baseline: …' });
  assert.equal(x.state.requirementStep, 'COOKING');
  const next = x.prompt();
  assert.match(next.context, /cooking step 2\/3/);
  assert.equal(x.state.pendingContext, null);
});

test('report delivered through a handback tool counts even if the final message is short', () => {
  const x = harness(); x.cmd('Build a booking system');
  x.pre('agent', { subagent_type: 'forge:forge-requirement' });
  const sub = { kind: 'sub', agent: 'forge:forge-requirement', agentId: 'h1' };
  assert.equal(x.pre('coord', {}, { actor: sub, rawTool: 'SubagentHandback', inputText: '- [HIGH][fact] missing tenant id' }).decision, undefined);
  x.agentStop({ agent: 'forge:forge-requirement', agentId: 'h1', report: '' });
  assert.equal(x.state.requirementStep, 'COOKING');
  assert.equal(x.state.agentCompletions.at(-1).reportedSeverities.high, 1);
});

test('coordination tools are allowed before approval (main and subagents)', () => {
  const x = harness(); x.cmd('Build a booking system');
  assert.equal(x.pre('coord', {}, { rawTool: 'SendMessage' }).decision, undefined);
  assert.equal(x.pre('coord', {}, { rawTool: 'TaskStop', actor: { kind: 'sub', agent: 'forge:forge-critic', agentId: 'c' } }).decision, undefined);
});

test('Stop delivers a queued gate instruction instead of ending the turn', () => {
  const x = harness(); x.cmd('Build a booking system');
  x.pre('agent', { subagent_type: 'forge:forge-requirement' });
  x.agentStop({ agent: 'forge:forge-requirement', agentId: 'q1', report: 'ok' });
  assert.match(x.stop().continueReason, /cooking step 2\/3/);
});

test('fast mode uses the summary tool and always challenges; cross-check holds', () => {
  const x = harness();
  x.cmd('--fast Build CRM');
  assert.equal(x.state.requirementStep, 'COOKING');
  const agents = requiredAgentsFor(x.state);
  x.agent(agents[0], '- [HIGH][fact] no tenant column');
  for (const a of agents.slice(1)) x.agent(a);
  const low = { baseline: 'Goal and scope and acceptance criteria here', findings: [{ severity: 'LOW', title: 'naming' }] };
  assert.match(x.pre('forge.requirement_summary', low).reason, /1 HIGH/);
  const ok = { ...low, findings: [{ severity: 'HIGH', title: 'No tenant column' }] };
  assert.equal(x.pre('forge.requirement_summary', ok).decision, undefined);
  assert.match(x.post('forge.requirement_summary', ok).context, /challenge/);
  assert.equal(x.state.requirementStep, 'CHALLENGE');
});

test('Stop nudges are capped (no infinite loops)', () => {
  const x = harness(); x.cmd('Build a booking system');
  assert.ok(x.stop().continueReason); assert.ok(x.stop().continueReason);
  assert.equal(x.stop().continueReason, undefined);
});

test('/forge off writes a tombstone; afterwards the session is unguarded', () => {
  const x = harness(); x.cmd('Build a booking system');
  x.cmd('off');
  assert.equal(x.state.active, false); assert.equal(typeof x.state.cancelledSlug, 'string');
  assert.equal(x.pre('write', { file_path: 'a' }).decision, undefined);
});

test('mode command returns a config update; config default applies to new runs', () => {
  assert.deepEqual(harness().cmd('mode fast').configUpdate, { requirementMode: 'fast' });
  const x = harness({ requirementMode: 'fast' }); x.cmd('Build');
  assert.equal(x.state.requirementMode, 'fast');
});

test('plan written to the host plan file (no inline plan) is validated and approved', () => {
  const files = { '/home/u/.claude/plans/p.md': PLAN };
  const engine = createEngine({ platform: 'claude-code', deps: { readPlanFile: p => files[p] ?? '' } });
  let st = null; const h = ev => { const r = engine.handle(st, ev); st = r.state; return r.out; };
  const main = { kind: 'main' };
  h({ type: 'command', text: 'Build a booking system' });
  for (let g = 0; g < 4; g++) for (const a of requiredAgentsFor(st)) {
    h({ type: 'tool.pre', tool: 'agent', input: { subagent_type: `forge:${a}` }, actor: main });
    h({ type: 'agent.stop', agent: `forge:${a}`, agentId: a + g, report: 'ok' });
  }
  assert.equal(st.phase, 'PLANNING');
  assert.equal(h({ type: 'tool.pre', tool: 'plan.write', input: { file_path: '/home/u/.claude/plans/p.md' }, planFile: '/home/u/.claude/plans/p.md', actor: main }).decision, undefined);
  assert.equal(h({ type: 'tool.pre', tool: 'plan.submit', input: {}, actor: main, permissionMode: 'plan' }).decision, undefined);
  assert.equal(st.phase, 'AWAITING_APPROVAL');
  h({ type: 'tool.post', tool: 'plan.submit', input: {}, actor: main });
  assert.equal(st.phase, 'EXECUTING');
  assert.equal(h({ type: 'tool.pre', tool: 'plan.write', input: {}, planFile: '/x/plans/p.md', actor: main }).decision, 'deny'); // not after approval
});

test('token guard: a specialist cannot be re-run while running or after it reported (rigor unchanged)', () => {
  const x = harness(); x.cmd('Build a booking system');
  const input = { subagent_type: 'forge:forge-requirement' };
  assert.equal(x.pre('agent', input).decision, undefined);
  assert.match(x.pre('agent', input).reason, /still running/);
  x.agentStop({ agent: 'forge:forge-requirement', agentId: 'r1', report: 'baseline' });
  // gate advanced to COOKING: forge-requirement is required again there (new gate) → allowed once
  assert.equal(x.pre('agent', input).decision, undefined);
  x.agentStop({ agent: 'forge:forge-requirement', agentId: 'r2', report: 'cooking analysis' });
  assert.match(x.pre('agent', input).reason, /already reported/);
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

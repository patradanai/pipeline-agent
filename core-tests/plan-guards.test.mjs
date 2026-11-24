import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../core/engine.mjs';
import { validatePlanContract, extractHighFindings } from '../core/core.mjs';
import { PLAN, SUBMISSION } from './fixtures.mjs';

const issuesOf = plan => validatePlanContract(plan).issues;
const withDecisions = lines => PLAN.replace('- Open decisions: none', lines);

test('plan contract enforces Context, Approach, Verification and Assumptions & contingencies', () => {
  assert.deepEqual(issuesOf(PLAN), []);
  assert.deepEqual(issuesOf(PLAN.replace('## Assumptions & contingencies', '## Assumptions and contingencies')), []);
  const issues = issuesOf(PLAN.replace('## Verification\n- node test: TC-001 and TC-002 pass\n', ''));
  assert.deepEqual(issues, ['Missing ## Verification section.']);
  // a ### subheading inside Approach does not end the section
  assert.deepEqual(issuesOf(PLAN.replace('## Approach\n', '## Approach\n### Step 1\n')), []);
});

test('Approach must settle every open decision with a default and never leave a BLOCKER', () => {
  assert.match(issuesOf(PLAN.replace('- Open decisions: none\n', '')).join('\n'), /needs an "Open decisions:" line/);
  assert.match(issuesOf(withDecisions('- Open decisions:')).join('\n'), /"Open decisions:" is empty/);
  assert.match(issuesOf(withDecisions('- Open decisions: refund window')).join('\n'), /"refund window" needs "default: …"/);
  assert.match(issuesOf(withDecisions('- Open decisions: refund approver — BLOCKER')).join('\n'), /is a BLOCKER/);
  assert.deepEqual(issuesOf(withDecisions('- Open decisions:\n  - refund window (default: 14 days)\n  - currency (default: THB)')), []);
  assert.match(issuesOf(withDecisions('- Open decisions:\n  - refund window (default: 14 days)\n  - currency')).join('\n'), /"currency" needs "default: …"/);
  // heading-style label: bullets at the same indent belong to it, until a blank line
  const headingStyle = PLAN.replace('- Open decisions: none\n', 'Open decisions:\n- refund window (default: 14 days)\n\n');
  assert.deepEqual(issuesOf(headingStyle), []);
  // a value on the label line does not swallow the following Approach steps
  const steps = PLAN.replace('- Open decisions: none\n', 'Open decisions: none\n- 2. Add the refund endpoint (REQ-002)\n');
  assert.deepEqual(issuesOf(steps), []);
});

test('Approach must state migration and rollback, or why it does not apply', () => {
  const without = PLAN.replace('- Migration & rollback: not applicable — no data or API change\n', '');
  assert.match(issuesOf(without).join('\n'), /needs a "Migration & rollback:" line/);
  assert.match(issuesOf(PLAN.replace('not applicable — no data or API change', '')).join('\n'), /"Migration & rollback:" is empty/);
  assert.deepEqual(issuesOf(PLAN.replace('- Migration & rollback: not applicable — no data or API change',
    '- **Migration and rollback:**\n  - add column refunds.reason (nullable)\n  - rollback: drop the column')), []);
});

test('only CRITICAL/HIGH finding lines with a CR/PC id count as high findings', () => {
  const report = [
    '- CR-001 [HIGH] a.ts:3 — null deref — guard it',
    '- **PC-002** (CRITICAL) Approach — no rollback',
    '- CR-003 [LOW] a.ts:9 — naming; a HIGH risk only if reused',
    'No other CRITICAL or HIGH findings.',
    '| CR-004 | HIGH | b.ts:1 |',
  ].join('\n');
  assert.deepEqual(extractHighFindings(report), ['CR-001', 'PC-002', 'CR-004']);
  assert.deepEqual(extractHighFindings('No findings. Checked for CRITICAL and HIGH issues.'), []);
});

function qaHarness() {
  const engine = createEngine({ platform: 'claude-code', profile: { agentRef: n => `forge:${n}` }, deps: {
    snapshotWorkingTree: () => ({ available: true, hash: 'h', root: '/r' }), savePlan: () => '/data/plan.md', saveQaReport: () => '/data/qa.md',
  } });
  let state = null;
  const h = ev => { const r = engine.handle(state, ev); state = r.state; return r.out; };
  const main = { kind: 'main' };
  const pre = (tool, input) => h({ type: 'tool.pre', tool, input, actor: main, permissionMode: 'plan' });
  h({ type: 'command', text: 'Build a booking system' });
  pre('plan.submit', { plan: PLAN });
  h({ type: 'tool.post', tool: 'plan.submit', input: { plan: PLAN }, actor: main });
  pre('write', { file_path: 'src/a.ts' });
  h({ type: 'turn.end' });
  assert.equal(state.phase, 'QA');
  pre('agent', { subagent_type: 'forge:forge-code-reviewer' });
  h({ type: 'agent.stop', agent: 'forge:forge-code-reviewer', agentId: 'r1', report: '- CR-001 [HIGH] src/a.ts:12 — role check missing — require manager\n- CR-002 [LOW] src/a.ts:3 — naming' });
  return { pre, post: (tool, input) => h({ type: 'tool.post', tool, input, actor: main }), get state() { return state; } };
}
const withFindings = findings => ({ ...SUBMISSION, codeReview: { ...SUBMISSION.codeReview, findings } });

test('QA submission cannot drop or silently downgrade a reviewer CRITICAL/HIGH finding', () => {
  const x = qaHarness();
  assert.deepEqual(x.state.agentCompletions.at(-1).highFindings, ['CR-001']);
  assert.match(x.pre('forge.qa_submit', SUBMISSION).reason, /forge-code-reviewer reported CRITICAL\/HIGH finding\(s\) CR-001/);
  const downgraded = withFindings([{ id: 'CR-001', title: 'Role check', severity: 'LOW', evidence: 'fine' }]);
  assert.equal(x.pre('forge.qa_submit', downgraded).decision, 'deny');
  const kept = withFindings([{ id: 'CR-001', title: 'Role check', severity: 'HIGH', evidence: 'src/a.ts:12 has no role check' }]);
  assert.equal(x.pre('forge.qa_submit', kept).decision, undefined);
  assert.match(x.post('forge.qa_submit', kept).context, /QA GATE: FAIL/); // a kept HIGH finding fails the gate
});

test('an explicitly disputed reviewer finding is accepted and the gate can pass', () => {
  const x = qaHarness();
  const disputed = withFindings([{ id: 'CR-001', title: 'Role check', severity: 'MEDIUM', evidence: 'Disputed: middleware enforces the role at src/auth.ts:40' }]);
  assert.equal(x.pre('forge.qa_submit', disputed).decision, undefined);
  assert.match(x.post('forge.qa_submit', disputed).context, /QA GATE: PASS/);
});

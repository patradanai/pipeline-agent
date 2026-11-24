import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptInstruction, OMP_ONLY_PATTERN } from '../core/platform.mjs';
import { initialState, phaseInstruction, executionInstruction, qaInstruction, reworkInstruction, deliveryInstruction } from '../core/core.mjs';

function allRenderings() {
  const s = initialState('Build a CRM', 'forge-abc');
  const steering = [{ revision: 1, phase: 'EXECUTE', text: 'Also export contacts', at: '2026-01-01T00:00:00.000Z' }];
  return [
    ['PLAN', phaseInstruction(s)],
    ['PLAN:review-on', phaseInstruction({ ...s, planReview: true })],
    ['PLAN:steered-delta', phaseInstruction({ ...s, requirementSteering: steering, planPath: 'local://forge-abc-plan.md' })],
    ['PLAN:written', phaseInstruction({ ...s, planWritten: true, planValid: false, planPath: 'local://forge-abc-plan.md' })],
    ['AWAITING', phaseInstruction({ ...s, planWritten: true, planValid: true, approved: false })],
    ['EXEC', executionInstruction({ ...s, phase: 'EXECUTE' })],
    ['EXEC:qa-rework', executionInstruction({ ...s, phase: 'EXECUTE', reworkCycles: 1, reworkReason: 'QA_FAIL', qaOpenItems: [{ id: 'TC-002', status: 'FAIL', scope: 'BIZ-001,REQ-002', detail: 'double booking', fileRefs: ['src/book.ts'] }] })],
    ['QA', qaInstruction({ ...s, phase: 'QA' })],
    ['REWORK', reworkInstruction({ ...s, phase: 'PLAN', qaStatus: 'FAIL', reworkCycles: 1, reworkBaseHash: 'h', reworkBasePlanPath: 'local://forge-abc-plan.md' })],
    ['REWORK:steering', reworkInstruction({ ...s, phase: 'PLAN', reworkReason: 'STEERING', reworkCycles: 1, reworkBaseHash: 'h', reworkBasePlanPath: 'local://forge-abc-plan.md', requirementSteering: steering })],
    ['DELIVERY', deliveryInstruction({ ...s, phase: 'QA', qaStatus: 'PASS' })],
  ];
}

test('Claude Code wording never leaks OMP-only concepts (every gate instruction)', () => {
  for (const [name, text] of allRenderings()) {
    const cc = adaptInstruction(text, 'claude-code');
    assert.doesNotMatch(cc, OMP_ONLY_PATTERN, `${name} leaks: ${cc.match(OMP_ONLY_PATTERN)?.[0]}`);
  }
});

test('planning and rework tell Claude Code to use ExitPlanMode', () => {
  const r = Object.fromEntries(allRenderings());
  assert.match(adaptInstruction(r.PLAN, 'claude-code'), /ExitPlanMode/);
  assert.match(adaptInstruction(r.PLAN, 'claude-code'), /parallel Explore subagents via the Agent tool/);
  assert.match(adaptInstruction(r.PLAN, 'claude-code'), /AskUserQuestion/);
  assert.match(adaptInstruction(r.REWORK, 'claude-code'), /ExitPlanMode/);
  assert.match(adaptInstruction(r['PLAN:written'], 'claude-code'), /GATE 1\/3: NATIVE PLAN APPROVAL[\s\S]*ExitPlanMode/);
});

test('OMP wording is passed through unchanged', () => {
  for (const [, text] of allRenderings()) assert.equal(adaptInstruction(text, 'omp'), text);
  assert.throws(() => adaptInstruction('x', 'vscode'), /Unknown Forge platform/);
});

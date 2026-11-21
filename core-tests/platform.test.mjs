import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptInstruction, OMP_ONLY_PATTERN } from '../core/platform.mjs';
import { initialState, phaseInstruction, requirementSummaryInstruction, executionInstruction, qaInstruction, reworkInstruction, deliveryInstruction } from '../core/core.mjs';

const SUMMARY = { baseline: 'Goal: CRM contacts. Scope: create/list. Acceptance: both work.', findings: [{ id: 'F-001', severity: 'HIGH', title: 'No tenant column', source: 'forge-requirement' }], blockers: [], assumptions: [], relevantFiles: [] };

function allRenderings() {
  const s = initialState('Build a CRM', 'forge-abc');
  return [
    ['REQUIREMENT', phaseInstruction(s)],
    ['REQUIREMENT:summary', requirementSummaryInstruction(s)],
    ['PLANNING', phaseInstruction({ ...s, phase: 'PLANNING', requirementSummary: null })],
    ['PLANNING:synthesis', phaseInstruction({ ...s, phase: 'PLANNING', requirementSummary: SUMMARY })],
    ['PROPOSAL', phaseInstruction({ ...s, phase: 'PROPOSAL' })],
    ['AWAITING', phaseInstruction({ ...s, phase: 'AWAITING_APPROVAL' })],
    ['EXEC', executionInstruction({ ...s, phase: 'EXECUTING' })],
    ['QA', qaInstruction({ ...s, phase: 'QA_REVIEW' })],
    ['REWORK', reworkInstruction({ ...s, phase: 'REWORK_PLANNING', qaStatus: 'FAIL', reworkCycles: 1 })],
    ['DELIVERY', deliveryInstruction({ ...s, phase: 'DELIVERY_PREP' })],
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
  assert.match(adaptInstruction(r.PLANNING, 'claude-code'), /ExitPlanMode/);
  assert.match(adaptInstruction(r.REWORK, 'claude-code'), /ExitPlanMode/);
  assert.match(adaptInstruction(r.PROPOSAL, 'claude-code'), /ExitPlanMode/);
});

test('OMP wording is passed through unchanged', () => {
  for (const [, text] of allRenderings()) assert.equal(adaptInstruction(text, 'omp'), text);
  assert.throws(() => adaptInstruction('x', 'vscode'), /Unknown Forge platform/);
});

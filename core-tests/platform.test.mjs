import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptInstruction, OMP_ONLY_PATTERN } from '../core/platform.mjs';
import { initialState, phaseInstruction, executionInstruction, qaInstruction, reworkInstruction, deliveryInstruction } from '../core/core.mjs';

function allRenderings() {
  const out = [];
  for (const mode of ['thorough', 'fast', 'quick']) {
    const s = initialState('Build a CRM', 'forge-abc', null, null, {}, mode);
    for (const step of ['DISCOVERY', 'COOKING', 'CHALLENGE']) out.push([`${mode}:${step}`, phaseInstruction({ ...s, requirementStep: step })]);
    out.push([`${mode}:PLANNING`, phaseInstruction({ ...s, phase: 'PLANNING', requirementSummary: null })]);
    out.push([`${mode}:PROPOSAL`, phaseInstruction({ ...s, phase: 'PROPOSAL' })]);
    out.push([`${mode}:AWAITING`, phaseInstruction({ ...s, phase: 'AWAITING_APPROVAL' })]);
    out.push([`${mode}:EXEC`, executionInstruction({ ...s, phase: 'EXECUTING' })]);
    out.push([`${mode}:QA`, qaInstruction({ ...s, phase: 'QA_REVIEW' })]);
    out.push([`${mode}:REWORK`, reworkInstruction({ ...s, phase: 'REWORK_PLANNING', qaStatus: 'FAIL', reworkCycles: 1 })]);
    out.push([`${mode}:DELIVERY`, deliveryInstruction({ ...s, phase: 'DELIVERY_PREP' })]);
  }
  return out;
}

test('Claude Code wording never leaks OMP-only concepts (every gate, every mode)', () => {
  for (const [name, text] of allRenderings()) {
    const cc = adaptInstruction(text, 'claude-code');
    assert.doesNotMatch(cc, OMP_ONLY_PATTERN, `${name} leaks: ${cc.match(OMP_ONLY_PATTERN)?.[0]}`);
  }
});

test('planning and rework tell Claude Code to use ExitPlanMode', () => {
  const r = Object.fromEntries(allRenderings());
  assert.match(adaptInstruction(r['thorough:PLANNING'], 'claude-code'), /ExitPlanMode/);
  assert.match(adaptInstruction(r['thorough:REWORK'], 'claude-code'), /ExitPlanMode/);
  assert.match(adaptInstruction(r['thorough:PROPOSAL'], 'claude-code'), /ExitPlanMode/);
});

test('OMP wording is passed through unchanged', () => {
  for (const [, text] of allRenderings()) assert.equal(adaptInstruction(text, 'omp'), text);
  assert.throws(() => adaptInstruction('x', 'vscode'), /Unknown Forge platform/);
});

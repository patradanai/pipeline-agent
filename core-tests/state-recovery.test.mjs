import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryProposal, applyRecoveryProposal } from '../core/state-recovery.mjs';

const rework = {
  active: true, phase: 'REWORK_PLANNING', approved: true, planValid: true,
  planWritten: true, approvedPlanHash: 'new-hash', planPath: 'local://new-plan.md',
  qaStatus: 'FAIL',
};

test('recovery rejects a stale suggestion even when its key and target still match', () => {
  const proposal = recoveryProposal(rework);
  const changed = { ...rework, approvedPlanHash: 'other-hash', planPath: 'local://other-plan.md' };
  assert.equal(recoveryProposal(changed).key, proposal.key);
  assert.equal(recoveryProposal(changed).target, proposal.target);
  assert.throws(() => applyRecoveryProposal(changed, proposal), /suggestion expired/);
});

test('equivalent checkpoint objects accept a suggestion despite different key order', () => {
  const proposal = recoveryProposal({ ...rework, details: { b: 2, a: 1 } });
  const equivalent = { details: { a: 1, b: 2 }, ...rework };
  const result = applyRecoveryProposal(equivalent, proposal);
  assert.equal(result.approved, false);
  assert.equal(result.approvedPlanHash, null);
  assert.equal(result.reworkBaseHash, 'new-hash');
  assert.equal(result.reworkBasePlanPath, 'local://new-plan.md');
  assert.equal(result.qaStatus, 'FAIL');
});

test('existing rework base hash and path stay paired instead of mixing plan generations', () => {
  const state = { ...rework, reworkBaseHash: 'base-hash', reworkBasePlanPath: 'local://base-plan.md' };
  const result = applyRecoveryProposal(state, recoveryProposal(state));
  assert.equal(result.reworkBaseHash, 'base-hash');
  assert.equal(result.reworkBasePlanPath, 'local://base-plan.md');
  assert.equal(result.approved, false);
  assert.equal(result.planPath, null);
});

test('partial rework base remains partial rather than borrowing a different plan field', () => {
  for (const base of [
    { reworkBaseHash: 'base-hash' },
    { reworkBasePlanPath: 'local://base-plan.md' },
  ]) {
    const state = { ...rework, ...base };
    const result = applyRecoveryProposal(state, recoveryProposal(state));
    assert.equal(result.reworkBaseHash, base.reworkBaseHash ?? null);
    assert.equal(result.reworkBasePlanPath, base.reworkBasePlanPath ?? null);
    assert.equal(result.approved, false);
    assert.equal(result.qaStatus, 'FAIL');
  }
});

test('proposal category cannot be changed to bypass recovery', () => {
  const proposal = recoveryProposal(rework);
  assert.throws(() => applyRecoveryProposal(rework, { ...proposal, category: 'native-mode' }), /suggestion expired/);
});

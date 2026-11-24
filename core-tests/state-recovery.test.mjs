import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryProposal, applyRecoveryProposal } from '../core/state-recovery.mjs';
import { isResumableForgeState, normalizeForgeState } from '../core/forge-state.mjs';

const rework = {
  active: true, phase: 'PLAN', approved: true, planValid: true,
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

test('legacy approval checkpoints never manufacture approval', () => {
  for (const phase of ['PLANNING', 'PROPOSAL', 'AWAITING_APPROVAL', 'PLAN_MODE_PENDING']) {
    const migrated = normalizeForgeState({ active: true, phase, planWritten: true, planValid: true, approved: false });
    assert.equal(migrated.phase, 'PLAN');
    assert.equal(migrated.approved, false);
    assert.equal(migrated.planWritten, true);
    assert.equal(migrated.planValid, true);
  }
  const approved = normalizeForgeState({ active: true, phase: 'EXECUTING', approved: true, approvedPlanHash: 'hash' });
  assert.equal(approved.phase, 'EXECUTE');
  assert.equal(approved.approved, true);
  assert.equal(approved.approvedPlanHash, 'hash');
});

test('legacy delivery phase does not imply QA PASS', () => {
  for (const phase of ['QA_REVIEW', 'QA_EVIDENCE_PENDING', 'DELIVERY_PREP', 'DELIVERY_BLOCKED']) {
    const migrated = normalizeForgeState({ active: true, phase, approved: true });
    assert.equal(migrated.phase, 'QA');
    assert.equal(migrated.qaStatus, undefined);
  }
  const passed = normalizeForgeState({ active: true, phase: 'DELIVERY_PREP', qaStatus: 'PASS', workingTreeAtQa: { hash: 'h' } });
  assert.equal(passed.qaStatus, 'PASS');
  assert.deepEqual(passed.workingTreeAtQa, { hash: 'h' });
});

test('legacy gate records merge into three phases; requirement-gate records are dropped', () => {
  const migrated = normalizeForgeState({
    active: true, phase: 'DELIVERY_PREP',
    gateAgents: { REQUIREMENT: ['forge-requirement'], PLANNING: ['planner'], QA_REVIEW: ['qa', 'reviewer'], DELIVERY_PREP: ['delivery'], QA: ['qa'] },
    gateAgentsSpawned: { 'REQUIREMENT:COOKING': ['forge-requirement'], QA_REVIEW: ['qa'], DELIVERY_PREP: ['delivery'] },
    agentRetries: { REQUIREMENT: 1, QA_REVIEW: 2, DELIVERY_PREP: 1 },
  });
  assert.deepEqual(migrated.gateAgents, { PLAN: ['planner'], QA: ['qa', 'reviewer', 'delivery'] });
  assert.deepEqual(migrated.gateAgentsSpawned, { QA: ['qa', 'delivery'] });
  assert.deepEqual(migrated.agentRetries, { QA: 2 });
});

test('a legacy requirement-gate checkpoint resumes as PLAN without approval', () => {
  for (const phase of ['REQUIREMENT', 'COOKING', 'REQUIREMENT:CHALLENGE']) {
    const migrated = normalizeForgeState({ active: true, phase, approved: true, approvedPlanHash: 'h', planValid: true, planWritten: true,
      gateAgents: { REQUIREMENT: ['forge-requirement'] }, agentRetries: { REQUIREMENT: 1, 'REQUIREMENT:summary': 2 } });
    assert.equal(migrated.phase, 'PLAN', phase);
    assert.equal(migrated.approved, false, phase);
    assert.equal(migrated.approvedPlanHash, null, phase);
    assert.equal(migrated.planValid, false, phase);
    assert.equal(migrated.planWritten, false, phase);
    assert.deepEqual(migrated.gateAgents, {}, phase);
    assert.deepEqual(migrated.agentRetries, {}, phase);
    assert.equal(recoveryProposal(migrated), null, phase);
  }
  const blocked = normalizeForgeState({ active: false, phase: 'AGENTS_BLOCKED', approved: true });
  assert.equal(blocked.phase, 'PLAN');
  assert.equal(blocked.approved, false);
  assert.equal(blocked.active, true);
});

test('legacy rework clears approval and superseded planning agents', () => {
  const migrated = normalizeForgeState({
    active: true, phase: 'REWORK_PLANNING', approved: true, planWritten: true, planValid: true,
    approvedPlanHash: 'old-hash', planPath: 'local://old-plan.md',
    gateAgents: { PLANNING: ['old-planner'], REWORK_PLANNING: ['new-planner'] },
  });
  assert.equal(migrated.phase, 'PLAN');
  assert.equal(migrated.approved, false);
  assert.equal(migrated.approvedPlanHash, null);
  assert.equal(migrated.planPath, null);
  assert.equal(migrated.reworkBaseHash, 'old-hash');
  assert.equal(migrated.reworkBasePlanPath, 'local://old-plan.md');
  assert.deepEqual(migrated.gateAgents, { PLAN: ['new-planner'] });
});

test('completed legacy delivery stays inactive and cannot resume', () => {
  const completed = normalizeForgeState({ active: false, phase: 'DELIVERY', qaStatus: 'PASS' });
  assert.equal(completed.phase, 'QA');
  assert.equal(completed.active, false);
  assert.equal(completed.qaStatus, 'PASS');
  assert.equal(isResumableForgeState(completed), false);
});

test('plan recovery accepts native filesystem paths and validated inline plans', () => {
  const plan = { active: true, phase: 'PLAN', approved: false, planWritten: true, planValid: true, approvedPlanHash: 'plan-hash' };
  assert.equal(recoveryProposal({ ...plan, planPath: '/Users/example/.claude/plans/plan.md' }), null);
  assert.equal(recoveryProposal({ ...plan, planPath: null }), null);
  assert.equal(recoveryProposal({ ...plan, planPath: null, approvedPlanHash: null }).key, 'proposal-without-plan');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryProposal, applyRecoveryProposal } from '../forge/state-recovery.mjs';
const approved = {active:true, slug:'forge-abc', approved:true, planValid:true,
  approvedPlanHash:'sha256-tested', planWritten:true, planPath:'local://forge-abc-plan.md'};

test('execution without approved receipt returns to plan without inferring approval',()=>{
  const state={active:true,phase:'EXECUTE',approved:false,planValid:true,planWritten:true,planPath:approved.planPath};
  const proposal=recoveryProposal(state,'inactive');
  assert.equal(proposal.target,'PLAN');
  const fixed=applyRecoveryProposal(state,proposal);
  assert.equal(fixed.approved,false);
  assert.equal(fixed.phase,'PLAN');
  assert.equal(fixed.executionObserved,false);
  assert.equal(fixed.approvedPlanHash,null);
});

test('QA without approved receipt cannot proceed',()=>{
  const state={...approved,phase:'QA',approvedPlanHash:null,qaStatus:'PASS'};
  const fixed=applyRecoveryProposal(state,recoveryProposal(state));
  assert.equal(fixed.phase,'PLAN');
  assert.equal(fixed.approved,false);
  assert.equal(fixed.approvedPlanHash,null);
});

test('saved unapproved plan remains in plan gate',()=>{
  const state={active:true,phase:'PLAN',approved:false,planWritten:true,planValid:true,
    planPath:'local://forge-reworked-plan.md',reworkBaseHash:'sha256-old'};
  assert.equal(recoveryProposal(state,'active'),null);
  assert.equal(state.approved,false);
});

test('plan marked written without a saved plan is reset',()=>{
  const state={active:true,phase:'PLAN',approved:false,planWritten:true,planValid:true,planPath:null};
  const fixed=applyRecoveryProposal(state,recoveryProposal(state,'active'));
  assert.equal(fixed.phase,'PLAN');
  assert.equal(fixed.planWritten,false);
  assert.equal(fixed.planValid,false);
  assert.equal(fixed.approved,false);
});

test('QA status does not manufacture delivery or approval',()=>{
  for (const qaStatus of ['BLOCKED','FAIL','pending']) {
    const state={...approved,phase:'QA',qaStatus};
    assert.equal(recoveryProposal(state,'inactive'),null);
    assert.equal(state.qaStatus,qaStatus);
  }
});

test('native mode mismatch never changes the Forge gate',()=>{
  const state={active:true,phase:'PLAN',approved:false,planWritten:false};
  const proposal=recoveryProposal(state,'inactive');
  assert.equal(proposal.category,'native-mode');
  assert.equal(proposal.target,'PLAN');
  assert.strictEqual(applyRecoveryProposal(state,proposal),state);
});

test('valid QA and execution checkpoints do not cause prompts',()=>{
  assert.equal(recoveryProposal({...approved,phase:'EXECUTE'},'inactive'),null);
  assert.equal(recoveryProposal({...approved,phase:'QA',qaStatus:'BLOCKED'},'inactive'),null);
});

test('stale recovery candidates are rejected',()=>{
  const state={active:true,phase:'PLAN',planWritten:true,planPath:null};
  const proposal=recoveryProposal(state,'inactive');
  assert.throws(()=>applyRecoveryProposal({...state,phase:'EXECUTE'},proposal),/expired/);
});

test('recovery never infers approval from stale REQUIREMENT with approved flag',()=>{
  const state={...approved,phase:'REQUIREMENT'};
  const fixed=applyRecoveryProposal(state,recoveryProposal(state,'inactive'));
  assert.equal(fixed.phase,'PLAN');
  assert.equal(fixed.approved,false);
  assert.equal(fixed.approvedPlanHash,null);
});

test('failed rework pins superseded approved plan as read-only base', () => {
  const state={...approved,phase:'PLAN',qaStatus:'FAIL'};
  const proposal=recoveryProposal(state);
  assert.equal(proposal.key,'rework-still-approved');
  const fixed=applyRecoveryProposal(state,proposal);
  assert.equal(fixed.phase,'PLAN');
  assert.equal(fixed.reworkBasePlanPath,approved.planPath);
  assert.equal(fixed.reworkBaseHash,approved.approvedPlanHash);
  assert.equal(fixed.planPath,null);
  assert.equal(fixed.approved,false);
});

test('existing rework base is preserved, not replaced by planPath', () => {
  const state={...approved,phase:'PLAN',qaStatus:'FAIL',reworkBasePlanPath:'local://base-plan.md'};
  const fixed=applyRecoveryProposal(state,recoveryProposal(state));
  assert.equal(fixed.reworkBasePlanPath,'local://base-plan.md');
});

test('legacy rework migration revokes superseded approval before recovery', () => {
  const state={...approved,phase:'REWORK_PLANNING',qaStatus:'FAIL'};
  const proposal=recoveryProposal(state,'inactive');
  assert.equal(proposal.category,'native-mode');
  const fixed=applyRecoveryProposal(state,proposal);
  assert.equal(fixed.phase,'PLAN');
  assert.equal(fixed.approved,false);
  assert.equal(fixed.reworkBasePlanPath,approved.planPath);
  assert.equal(fixed.reworkBaseHash,approved.approvedPlanHash);
  assert.equal(fixed.planPath,null);
});

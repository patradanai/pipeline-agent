import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryProposal, applyRecoveryProposal } from '../forge/state-recovery.mjs';
const approved = {active:true, slug:'forge-abc', approved:true, planValid:true,
  approvedPlanHash:'sha256-tested', planWritten:true, planPath:'local://forge-abc-plan.md'};

test('missing approved execution receipt is not silently promoted',()=>{
  const state={active:true,phase:'EXECUTING',approved:false,planValid:true,planWritten:true,planPath:approved.planPath};
  const proposal=recoveryProposal(state,'inactive');
  assert.equal(proposal.target,'AWAITING_APPROVAL');
  const fixed=applyRecoveryProposal(state,proposal);
  assert.equal(fixed.approved,false);
  assert.equal(fixed.phase,'AWAITING_APPROVAL');
  assert.equal(fixed.executionObserved,false);
  assert.equal(fixed.approvedPlanHash,null);
});

test('evidence blocker in rework offers QA evidence pending without revoking prior approval',()=>{
  const state={...approved,phase:'REWORK_PLANNING',qaStatus:'BLOCKED'};
  const proposal=recoveryProposal(state,'inactive');
  assert.equal(proposal.target,'QA_EVIDENCE_PENDING');
  const fixed=applyRecoveryProposal(state,proposal);
  assert.equal(fixed.approved,true);
  assert.equal(fixed.approvedPlanHash,approved.approvedPlanHash);
  assert.equal(fixed.qaEvidencePending,true);
});

test('rework with new saved plan may propose but cannot become executed',()=>{
  const state={active:true,phase:'REWORK_PLANNING',approved:false,planWritten:true,
    planPath:'local://forge-reworked-plan.md',reworkBaseHash:'sha256-old'};
  const proposal=recoveryProposal(state,'active');
  assert.equal(proposal.target,'PROPOSAL');
  const fixed=applyRecoveryProposal(state,proposal);
  assert.equal(fixed.phase,'PROPOSAL');
  assert.notEqual(fixed.approved,true);
  assert.equal(fixed.proposalDeferred,true);
});

test('invalid proposal without saved plan returns to planning',()=>{
  const state={active:true,phase:'PROPOSAL',approved:false,planWritten:false,planPath:null};
  const fixed=applyRecoveryProposal(state,recoveryProposal(state,'active'));
  assert.equal(fixed.phase,'PLANNING');
});

test('no QA PASS can be recovered into delivery',()=>{
  const state={...approved,phase:'DELIVERY_PREP',qaStatus:'BLOCKED'};
  const fixed=applyRecoveryProposal(state,recoveryProposal(state,'inactive'));
  assert.equal(fixed.phase,'QA_EVIDENCE_PENDING');
});

test('a native mode mismatch never changes the Forge Gate',()=>{
  const state={active:true,phase:'REWORK_PLANNING',approved:false,planWritten:false};
  const proposal=recoveryProposal(state,'inactive');
  assert.equal(proposal.category,'native-mode');
  assert.equal(proposal.target,'REWORK_PLANNING');
  assert.strictEqual(applyRecoveryProposal(state,proposal),state);
});

test('valid QA and execution checkpoints do not cause prompts',()=>{
  assert.equal(recoveryProposal({...approved,phase:'EXECUTING'},'inactive'),null);
  assert.equal(recoveryProposal({...approved,phase:'QA_EVIDENCE_PENDING',qaStatus:'BLOCKED'},'inactive'),null);
});

test('stale recovery candidates are rejected',()=>{
  const state={active:true,phase:'PROPOSAL',planWritten:false,planPath:null};
  const proposal=recoveryProposal(state,'inactive');
  assert.throws(()=>applyRecoveryProposal({...state,phase:'EXECUTING'},proposal),/expired/);
});

test('recovery never infers approval from stale REQUIREMENT with approved flag',()=>{
  const state={...approved,phase:'REQUIREMENT',requirementStep:'DISCOVERY'};
  const fixed=applyRecoveryProposal(state,recoveryProposal(state,'inactive'));
  assert.equal(fixed.phase,'PLANNING');
  assert.equal(fixed.approved,false);
});

// ---------------------------------------------------------------- v5.23
test('v5.23: stale rework approval pins the superseded plan as read-only base', () => {
  const s={active:true,phase:'REWORK_PLANNING',approved:true,planValid:true,planWritten:true,approvedPlanHash:'h1',planPath:'local://f-plan.md',qaStatus:'FAIL',slug:'f'};
  const p=recoveryProposal(s);
  assert.equal(p.key,'rework-still-approved');
  const r=applyRecoveryProposal(s,p);
  assert.equal(r.reworkBasePlanPath,'local://f-plan.md');
  assert.equal(r.reworkBaseHash,'h1');
  assert.equal(r.planPath,null);
  assert.equal(r.approved,false);
});

test('v5.23: existing rework base is preserved, not replaced by planPath', () => {
  const s={active:true,phase:'REWORK_PLANNING',approved:true,planValid:true,approvedPlanHash:'h2',planPath:'local://new-plan.md',reworkBasePlanPath:'local://base-plan.md',qaStatus:'FAIL'};
  const r=applyRecoveryProposal(s,recoveryProposal(s));
  assert.equal(r.reworkBasePlanPath,'local://base-plan.md');
});

test('v5.23: delivery without QA PASS routes consistently', () => {
  const base={active:true,phase:'DELIVERY_PREP',approved:true,planValid:true,approvedPlanHash:'h',planPath:'local://d-plan.md'};
  const evidence=applyRecoveryProposal({...base,qaStatus:'BLOCKED'},recoveryProposal({...base,qaStatus:'BLOCKED'}));
  assert.equal(evidence.phase,'QA_EVIDENCE_PENDING');
  assert.equal(evidence.qaEvidencePending,true);
  const failed=applyRecoveryProposal({...base,qaStatus:'FAIL'},recoveryProposal({...base,qaStatus:'FAIL'}));
  assert.equal(failed.phase,'REWORK_PLANNING');
  assert.equal(failed.reworkBasePlanPath,'local://d-plan.md');
  assert.equal(failed.reworkBaseHash,'h');
  assert.equal(failed.planPath,null);
  assert.equal(failed.qaEvidencePending,false);
});

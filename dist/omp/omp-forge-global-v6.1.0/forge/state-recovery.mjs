/**
 * Conservative Forge state reconciliation. These are suggestions, not automatic
 * transitions. Never manufacture an approval or a QA PASS from a phase name.
 */
const PLAN_STAGES = new Set(['PLANNING', 'PROPOSAL', 'REWORK_PLANNING']);

/** Same pinning as `/forge rework`: the superseded approved plan becomes the
 * read-only base, and a NEW local:// plan must be written and re-approved. */
function reworkPin(state) {
  return {
    planValid: false, planWritten: false, approvedPlanHash: null, planPath: null,
    reworkBaseHash: state.approvedPlanHash ?? state.reworkBaseHash ?? null,
    reworkBasePlanPath: state.reworkBasePlanPath ?? state.planPath ?? null,
  };
}

export function recoveryProposal(state, nativePlan = 'unknown') {
  if (!state || typeof state.phase !== 'string' || !state.active) return null;
  const phase = state.phase;
  const hasApprovedEvidence = state.approved === true && state.planValid === true &&
    typeof state.approvedPlanHash === 'string' && state.approvedPlanHash.length > 0;
  const written = state.planWritten === true && /^local:\/\/[a-zA-Z0-9][a-zA-Z0-9._-]*-plan\.md$/.test(state.planPath ?? '');
  const issue = (key, target, explanation, patch, category = 'mismatch') => ({
    key, current: phase, target, explanation, patch, category,
  });

  if (phase === 'EXECUTING' && !hasApprovedEvidence) {
    return issue('execution-without-approved-plan', written && state.planValid ? 'AWAITING_APPROVAL' : 'PLANNING',
      'Execution has no verified approved-plan snapshot. Return to the plan/approval gate; do not infer human consent.',
      { phase: written && state.planValid ? 'AWAITING_APPROVAL' : 'PLANNING', approved: false,
        executionObserved: false, approvedPlanHash: null }, 'safety');
  }
  if (['QA_REVIEW', 'QA_EVIDENCE_PENDING'].includes(phase) && !hasApprovedEvidence) {
    return issue('qa-without-approved-plan', written && state.planValid ? 'AWAITING_APPROVAL' : 'PLANNING',
      'QA cannot verify against an approved plan without recorded approval evidence.',
      { phase: written && state.planValid ? 'AWAITING_APPROVAL' : 'PLANNING', approved: false,
        approvedPlanHash: null, qaEvidencePending: false }, 'safety');
  }
  if (phase === 'DELIVERY_PREP' && (state.qaStatus !== 'PASS' || !hasApprovedEvidence)) {
    const target = hasApprovedEvidence && state.qaStatus !== 'FAIL' ? 'QA_EVIDENCE_PENDING' : 'REWORK_PLANNING';
    return issue('delivery-without-qa-pass', target,
      'Delivery requires a verifiable QA PASS and existing approved plan.',
      target === 'QA_EVIDENCE_PENDING'
        ? { phase: target, approved: true, qaEvidencePending: true }
        : { phase: target, approved: false, qaEvidencePending: false, ...reworkPin(state) }, 'safety');
  }
  if (phase === 'REWORK_PLANNING' && state.approved === true && state.qaStatus === 'BLOCKED' && hasApprovedEvidence) {
    return issue('evidence-qa-misrouted-to-rework', 'QA_EVIDENCE_PENDING',
      'QA was blocked by missing evidence rather than a confirmed code failure; the approved plan should remain pinned.',
      {phase: 'QA_EVIDENCE_PENDING', qaEvidencePending: true}, 'safe-qa');
  }
  if (phase === 'REWORK_PLANNING' && state.approved === true) {
    return issue('rework-still-approved', 'REWORK_PLANNING',
      'Rework must not inherit permission to execute under a superseded approval.',
      {phase:'REWORK_PLANNING', approved: false, ...reworkPin(state)}, 'safety');
  }
  if (phase === 'REWORK_PLANNING' && written) {
    return issue('saved-rework-plan-stuck', 'PROPOSAL',
      'A new session-local plan write is recorded. The next step is a fresh native human review, not implementation.',
      { phase: 'PROPOSAL', proposalDeferred: true }, 'plan');
  }
  if (phase === 'PROPOSAL' && !written) {
    return issue('proposal-without-plan', 'PLANNING',
      'Forge shows Proposal but has no successfully recorded canonical plan write.',
      {phase: 'PLANNING', proposalDeferred: false, planWritten: false}, 'plan');
  }
  if (phase === 'REQUIREMENT' && state.approved === true) {
    // An inconsistent record is not proof that the implementation gate can
    // resume. Deliberately revoke executable privileges; require new review.
    return issue('requirement-still-approved', 'PLANNING',
      'Requirement state and an approval flag conflict. A prior approval cannot be replayed without matching native review evidence.',
      {phase:'PLANNING', approved:false, approvedPlanHash:null, planValid:false, planWritten:false}, 'safety');
  }
  if (PLAN_STAGES.has(phase) && nativePlan === 'inactive') {
    return issue('native-plan-mode-inactive', phase,
      'Forge is planning, but native OMP Plan Mode is inactive. Activate Plan Mode before saving/submitting the plan; keep the same Gate.',
      {}, 'native-mode');
  }
  return null;
}

/** Only mutate the exact candidate derived from the CURRENT checkpoint. */
export function applyRecoveryProposal(state, proposal) {
  if (!state || !proposal || !state.active) throw new Error('No active state to recover');
  const current = recoveryProposal(state, proposal.category === 'native-mode' ? 'inactive' : 'unknown');
  if (!current || current.key !== proposal.key || current.current !== proposal.current ||
      current.target !== proposal.target) throw new Error('Recovery suggestion expired; re-check state');
  if (proposal.category === 'native-mode') return state;
  return { ...state, ...current.patch, recoveryAudit: [ ...(state.recoveryAudit ?? []), {
    from: current.current, to: current.target, reason: current.key,
    reviewedBy: 'human', at: new Date().toISOString(),
  } ], version: Math.max(Number(state.version) || 8, 9) };
}

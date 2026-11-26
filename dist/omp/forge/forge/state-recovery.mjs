/**
 * Conservative Forge state reconciliation. These are suggestions, not automatic
 * transitions. Never manufacture an approval or a QA PASS from a phase name.
 */
import { createHash } from 'node:crypto';
import { normalizeForgeState } from './forge-state.mjs';

// Checkpoints are JSON data. Sort object keys so equivalent snapshots have the
// same identity regardless of property insertion order.
function checkpointFingerprint(state) {
  const json = JSON.stringify(state, (_key, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
  });
  return createHash('sha256').update(json).digest('hex');
}


/** Same pinning as `/forge rework`: the superseded approved plan becomes the
 * read-only base, and a NEW local:// plan must be written and re-approved. */
function reworkPin(state) {
  const hasBase = state.reworkBaseHash != null || state.reworkBasePlanPath != null;
  return {
    planValid: false, planWritten: false, approvedPlanHash: null, planPath: null,
    reworkBaseHash: hasBase ? state.reworkBaseHash ?? null : state.approvedPlanHash ?? null,
    reworkBasePlanPath: hasBase ? state.reworkBasePlanPath ?? null : state.planPath ?? null,
  };
}

export function recoveryProposal(input) {
  const state = normalizeForgeState(input);
  if (!state || typeof state.phase !== 'string' || !state.active) return null;
  const phase = state.phase;
  const hasApprovedEvidence = state.approved === true && state.planValid === true &&
    typeof state.approvedPlanHash === 'string' && state.approvedPlanHash.length > 0;
  const written = state.planWritten === true && (
    (typeof state.planPath === 'string' && state.planPath.trim().length > 0) ||
    (state.planValid === true && typeof state.approvedPlanHash === 'string' && state.approvedPlanHash.length > 0)
  );
  const issue = (key, target, explanation, patch, category = 'mismatch') => ({
    key, current: phase, target, explanation, patch, category,
    checkpointFingerprint: checkpointFingerprint(input),
  });

  if (phase === 'EXECUTE' && !hasApprovedEvidence) {
    return issue('execution-without-approved-plan', 'PLAN',
      'Execution has no verified approved-plan snapshot. Return to the plan gate; do not infer human consent.',
      { phase: 'PLAN', approved: false, executionObserved: false, approvedPlanHash: null }, 'safety');
  }
  if (phase === 'QA' && !hasApprovedEvidence) {
    return issue('qa-without-approved-plan', 'PLAN',
      'QA cannot verify against an approved plan without recorded approval evidence.',
      { phase: 'PLAN', approved: false, approvedPlanHash: null, qaEvidencePending: false }, 'safety');
  }
  if (phase === 'PLAN' && state.approved === true && state.qaStatus === 'FAIL') {
    return issue('rework-still-approved', 'PLAN',
      'Rework must not inherit permission to execute under a superseded approval.',
      { phase: 'PLAN', approved: false, ...reworkPin(state) }, 'safety');
  }
  if (phase === 'PLAN' && state.planWritten === true && !written) {
    return issue('proposal-without-plan', 'PLAN',
      'Forge has no successfully recorded canonical plan write.',
      { phase: 'PLAN', reviewRequested: false, planWritten: false, planValid: false, approved: false, approvedPlanHash: null }, 'plan');
  }
  return null;
}

/** Only mutate the exact candidate derived from the CURRENT checkpoint. */
export function applyRecoveryProposal(state, proposal) {
  if (!state || !proposal || !normalizeForgeState(state).active) throw new Error('No active state to recover');
  const current = recoveryProposal(state);
  if (!current || current.key !== proposal.key || current.current !== proposal.current ||
      current.target !== proposal.target || current.category !== proposal.category ||
      current.checkpointFingerprint !== proposal.checkpointFingerprint) {
    throw new Error('Recovery suggestion expired; re-check state');
  }
  return { ...normalizeForgeState(state), ...current.patch, recoveryAudit: [ ...(state.recoveryAudit ?? []), {
    from: current.current, to: current.target, reason: current.key,
    reviewedBy: 'human', at: new Date().toISOString(),
  } ], version: Math.max(Number(state.version) || 8, 9) };
}

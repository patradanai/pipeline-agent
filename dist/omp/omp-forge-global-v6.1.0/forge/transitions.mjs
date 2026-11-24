/** Platform-neutral, pure Forge state transitions shared by every adapter. */
import { requiredAgentsFor, missingGateAgentsFor, agentNameFor, latestHighFindings, qaOpenItems } from './core.mjs';

export function hasGateAgents(state, phase = state?.phase) {
  if (!state) return false;
  return missingGateAgentsFor(phase === state.phase ? state : { ...state, phase }).length === 0;
}

/** Record that a required specialist of the CURRENT gate reported. Returns the same object if not required. */
export function markGateAgent(state, agentName) {
  if (!state?.active || !requiredAgentsFor(state).includes(agentName)) return state;
  const key = state.phase;
  const seen = new Set(state.gateAgents?.[key] ?? []);
  seen.add(agentName);
  return { ...state, gateAgents: { ...(state.gateAgents ?? {}), [key]: [...seen] } };
}

/** Human approved the plan through the platform's approval dialog. */
export function approvedExecutionState(state, auditReason, reviewedBy = 'native-plan-review') {
  return { ...state, phase: 'EXECUTE', approved: true, reworkBaseHash: null, reworkBasePlanPath: null, executionObserved: false,
    gateAgents: { ...(state.gateAgents ?? {}), EXECUTE: [] }, agentRetries: { ...(state.agentRetries ?? {}), EXECUTE: 0 },
    ...(auditReason ? { recoveryAudit: [ ...(state.recoveryAudit ?? []), {
      from: state.phase, to: 'EXECUTE', reason: auditReason, reviewedBy, at: new Date().toISOString(),
    } ].slice(-20) } : {}) };
}

/** Apply an evaluated QA report. FAIL → PLAN (approval revoked), BLOCKED → evidence pending, PASS → delivery.
 * FAIL and BLOCKED wait for a human decision (reworkDecisionPending) before any fix is planned. */
export function qaReportTransition(state, report, { reportPath, workingTree = null } = {}) {
  const failed = report.status === 'FAIL';
  const evidencePending = report.status === 'BLOCKED';
  return {
    ...state,
    phase: failed ? 'PLAN' : 'QA',
    reworkBasePlanPath: failed ? state.planPath : state.reworkBasePlanPath,
    planPath: failed ? null : state.planPath,
    planWritten: failed ? false : state.planWritten,
    planValid: failed ? false : state.planValid,
    approvedPlanHash: failed ? null : state.approvedPlanHash,
    reworkBaseHash: failed ? state.approvedPlanHash : state.reworkBaseHash,
    active: true,
    approved: failed ? false : state.approved,
    qaStatus: report.status,
    qaEvidencePending: evidencePending,
    qaReportPath: reportPath,
    qaOpenItems: report.status === 'PASS' ? null : qaOpenItems(report),
    workingTreeAtQa: workingTree,
    reworkCycles: failed ? (state.reworkCycles ?? 0) + 1 : (state.reworkCycles ?? 0),
    ...(failed ? { reworkReason: 'QA_FAIL', reworkNotes: null } : {}),
    reworkDecisionPending: failed || evidencePending,
    gateAgents: { ...(state.gateAgents ?? {}), ...(failed ? { PLAN: [], EXECUTE: [], QA: [] } : {}) },
    agentRetries: { ...(state.agentRetries ?? {}), ...(failed ? { PLAN: 0, EXECUTE: 0, QA: 0 } : {}) },
  };
}

/** Preconditions shared by adapters before accepting a QA submission. Throws with an actionable message. */
export function assertQaSubmittable(state, submission) {
  if (!state?.active || state.phase !== 'QA' || state.qaStatus === 'PASS' || !state.approved || !state.planValid || !state.approvedPlanHash) {
    throw new Error('Forge QA report can be submitted only during approved QA review.');
  }
  if (!hasGateAgents(state) && (submission?.codeReview?.status === 'PASS')) {
    throw new Error(`Independent reviewer ${requiredAgentsFor(state).join(', ')} must run before a PASS code review.`);
  }
  // The reviewer's CRITICAL/HIGH findings cannot vanish: each stays at CRITICAL/HIGH or is explicitly disputed.
  const reviewer = agentNameFor(state, 'qa', 'reviewer');
  const findings = Array.isArray(submission?.codeReview?.findings) ? submission.codeReview.findings : [];
  const dropped = latestHighFindings(state, 'QA', reviewer).filter(id => !findings.some(f =>
    [f?.id, f?.title, f?.evidence].some(v => String(v ?? '').toUpperCase().includes(id)) &&
    (['CRITICAL', 'HIGH'].includes(String(f?.severity ?? '').toUpperCase()) || /^\s*Disputed:/i.test(String(f?.evidence ?? '')))));
  if (dropped.length) {
    throw new Error(`${reviewer} reported CRITICAL/HIGH finding(s) ${dropped.join(', ')} that codeReview.findings does not carry. Keep each under its ID at CRITICAL/HIGH, or start its evidence with "Disputed:" and your counter-evidence.`);
  }
}

/** Plan review on: the critic must have reported on this PLAN cycle, and the plan must cite each of its CRITICAL/HIGH IDs. */
export function assertPlanProposable(state, planContent) {
  if (state?.planReview !== true) return;
  const critic = agentNameFor(state, 'planning', 'critic');
  if (!(state.gateAgents?.PLAN ?? []).includes(critic)) {
    throw new Error(`plan review is on: run ${critic} once on the written plan and await its report before proposing.`);
  }
  const text = String(planContent ?? '').toUpperCase();
  const missing = latestHighFindings(state, 'PLAN', critic).filter(id => !text.includes(id));
  if (missing.length) throw new Error(`resolve plan-review finding(s) ${missing.join(', ')}: cite each ID in the plan where it is resolved, or under Assumptions & contingencies with why it stands.`);
}

export function assertDeliverySubmittable(state, workingTreeNow) {
  if (!state?.active || state.phase !== 'QA' || state.qaStatus !== 'PASS' || !state.approved || !state.planValid || !state.approvedPlanHash) throw new Error('Delivery requires a PASS QA gate.');
  const qa = state.workingTreeAtQa;
  if (qa?.available && (!workingTreeNow?.available || workingTreeNow.hash !== qa.hash || workingTreeNow.root !== qa.root)) {
    throw new Error('Working tree changed after QA PASS. Delivery blocked; rerun QA against the current diff.');
  }
}

export function deliveryTransition(state, { deliveryPath, commitMessagePath, commitMessage }) {
  return { ...state, phase: 'QA', active: false, deliveryPath, commitMessagePath, commitMessage };
}

/** Explicit human request for a new plan after QA FAIL/BLOCKED. */
export function reworkTransition(state) {
  // A pending PLAN proposal is not approved; retain both it and the actual approved base.
  if (state.phase === 'PLAN') return state;
  return { ...state, active: true, approved: false, qaEvidencePending: false, phase: 'PLAN', planWritten: false, planValid: false, approvedPlanHash: null,
    reworkBaseHash: state.approvedPlanHash ?? null, reworkBasePlanPath: state.planPath ?? null, planPath: null,

    reworkCycles: (state.reworkCycles ?? 0) + (state.qaStatus === 'BLOCKED' ? 1 : 0), reworkReason: state.qaStatus === 'FAIL' ? 'QA_FAIL' : 'QA_BLOCKED',
    gateAgents: { ...(state.gateAgents ?? {}), PLAN: [] }, agentRetries: { ...(state.agentRetries ?? {}), PLAN: 0 } };
}

/** The human chose to plan a fix after QA FAIL/BLOCKED. Optional notes steer the fix plan,
 * which still needs plan approval before any code changes. */
export function approveReworkTransition(state, notes = '') {
  const base = state.phase === 'PLAN' ? state : reworkTransition(state);
  const text = String(notes ?? '').trim();
  return { ...base, reworkDecisionPending: false, reworkNotes: text ? text.slice(0, 4000) : (base.reworkNotes ?? null) };
}

const STEERABLE_PHASES = new Set(['PLAN', 'EXECUTE', 'QA']);

/** Where a steering prompt would take the workflow, or null when nothing can be steered.
 * Lets an adapter ask the human before anything changes. */
export function steeringRoute(state) {
  if (!state?.active || state.deliveryPath || !STEERABLE_PHASES.has(state.phase)) return null;
  return { from: state.phase, to: 'PLAN', revoked: state.approved === true };
}

/** A prompt the user typed while the workflow ran. It amends the requirement, so the
 * workflow re-enters PLAN: PLAN withdraws any proposal, and EXECUTE/QA lose their
 * approval and re-plan.
 * Throws when no running workflow can take steering. */
export function steerTransition(state, text, { at = new Date().toISOString() } = {}) {
  const directive = String(text ?? '');
  if (!directive.trim()) throw new Error('Steering prompt is empty.');
  if (!steeringRoute(state)) throw new Error('No running Forge workflow to steer.');
  const steeringRevision = (state.steeringRevision ?? 0) + 1;
  const next = {
    ...state, steeringRevision,
    requirementSteering: [...(state.requirementSteering ?? []), { revision: steeringRevision, phase: state.phase, text: directive, at }],
  };
  const draft = { phase: 'PLAN', planWritten: false, planValid: false, approvedPlanHash: null, reviewRequested: false, proposalRetries: 0, reworkDecisionPending: false,
    gateAgents: { ...(state.gateAgents ?? {}), PLAN: [] }, agentRetries: { ...(state.agentRetries ?? {}), PLAN: 0 } };
  if (state.approved !== true) return { ...next, ...draft };
  // The approved plan becomes the read-only rework base; a revised plan needs new approval.
  return { ...next, ...draft, approved: false, executionObserved: false, qaStatus: null, qaEvidencePending: false, qaRetries: 0, deliveryRetries: 0,
    reworkReason: 'STEERING', reworkBaseHash: state.approvedPlanHash ?? null, reworkBasePlanPath: state.planPath ?? null, planPath: null,
    reworkCycles: (state.reworkCycles ?? 0) + 1,
    gateAgents: { ...draft.gateAgents, EXECUTE: [], QA: [] }, agentRetries: { ...draft.agentRetries, EXECUTE: 0, QA: 0 } };
}

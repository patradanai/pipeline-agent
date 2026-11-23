/** Platform-neutral, pure Forge state transitions shared by every adapter. */
import { requiredAgentsFor, missingGateAgentsFor, normalizeRequirementSummary } from './core.mjs';

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
  return { ...state, phase: 'EXECUTE', approved: true, reworkBaseHash: null, executionObserved: false,
    gateAgents: { ...(state.gateAgents ?? {}), EXECUTE: [] }, agentRetries: { ...(state.agentRetries ?? {}), EXECUTE: 0 },
    ...(auditReason ? { recoveryAudit: [ ...(state.recoveryAudit ?? []), {
      from: state.phase, to: 'EXECUTE', reason: auditReason, reviewedBy, at: new Date().toISOString(),
    } ].slice(-20) } : {}) };
}

/** Apply an evaluated QA report. FAIL → rework (approval revoked), BLOCKED → evidence pending, PASS → delivery. */
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
    workingTreeAtQa: workingTree,
    reworkCycles: failed ? (state.reworkCycles ?? 0) + 1 : (state.reworkCycles ?? 0),
    ...(failed ? { reworkReason: 'QA_FAIL' } : {}),
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
    throw new Error(`Independent QA specialists ${requiredAgentsFor(state).join(' and ')} must both run before PASS.`);
  }
}

export function assertDeliverySubmittable(state, workingTreeNow) {
  if (!state?.active || state.phase !== 'QA' || state.qaStatus !== 'PASS' || !state.approved || !state.planValid || !state.approvedPlanHash) throw new Error('Delivery requires a PASS QA gate.');
  if (!hasGateAgents(state)) throw new Error(`Independent ${requiredAgentsFor(state).join(', ')} agent must run before delivery submission.`);
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
  const previousHash = state.approvedPlanHash ?? state.reworkBaseHash ?? null;
  return { ...state, active: true, approved: false, qaEvidencePending: false, phase: 'PLAN', planWritten: false, planValid: false, approvedPlanHash: null,
    reworkBaseHash: previousHash, reworkBasePlanPath: state.reworkBasePlanPath ?? state.planPath, planPath: null,

    reworkCycles: (state.reworkCycles ?? 0) + (state.qaStatus === 'BLOCKED' ? 1 : 0), reworkReason: state.qaStatus === 'FAIL' ? 'QA_FAIL' : 'QA_BLOCKED',
    gateAgents: { ...(state.gateAgents ?? {}), PLAN: [] }, agentRetries: { ...(state.agentRetries ?? {}), PLAN: 0 } };
}

const STEERABLE_PHASES = new Set(['REQUIREMENT', 'PLAN', 'EXECUTE', 'QA']);
const MAX_STEERING = 20;

/** Where a steering prompt would take the workflow, or null when nothing can be steered.
 * Lets an adapter ask the human before anything changes. */
export function steeringRoute(state) {
  if (!state?.active || state.deliveryPath || !STEERABLE_PHASES.has(state.phase)) return null;
  const restartsRequirement = state.phase === 'REQUIREMENT';
  return { from: state.phase, to: restartsRequirement ? 'REQUIREMENT' : 'PLAN', revoked: !restartsRequirement && state.approved === true };
}

/** A prompt the user typed while the workflow ran. It amends the requirement, so the
 * workflow re-enters the gate that must absorb it: REQUIREMENT re-runs its analysis,
 * PLAN withdraws any proposal, and EXECUTE/QA lose their approval and re-plan.
 * Throws when no running workflow can take steering. */
export function steerTransition(state, text, { at = new Date().toISOString() } = {}) {
  const directive = String(text ?? '').trim();
  if (!directive) throw new Error('Steering prompt is empty.');
  if (!steeringRoute(state)) throw new Error('No running Forge workflow to steer.');
  const steeringRevision = (state.steeringRevision ?? 0) + 1;
  const next = {
    ...state, steeringRevision,
    requirementSteering: [...(state.requirementSteering ?? []), { revision: steeringRevision, phase: state.phase, text: directive, at }].slice(-MAX_STEERING),
  };
  if (state.phase === 'REQUIREMENT') {
    return { ...next, requirementSummary: null, requirementSummaryRequested: false,
      gateAgents: { ...(state.gateAgents ?? {}), REQUIREMENT: [] },
      agentRetries: { ...(state.agentRetries ?? {}), REQUIREMENT: 0, 'REQUIREMENT:summary': 0 },
      // The earlier report no longer covers the requirement; keep it for audit only.
      agentCompletions: (state.agentCompletions ?? []).map(c => c?.gate === 'REQUIREMENT' ? { ...c, superseded: true } : c) };
  }
  const draft = { phase: 'PLAN', planWritten: false, planValid: false, approvedPlanHash: null, reviewRequested: false, proposalRetries: 0,
    gateAgents: { ...(state.gateAgents ?? {}), PLAN: [] }, agentRetries: { ...(state.agentRetries ?? {}), PLAN: 0 } };
  if (state.approved !== true) return { ...next, ...draft };
  // The approved plan becomes the read-only rework base; a revised plan needs new approval.
  return { ...next, ...draft, approved: false, executionObserved: false, qaStatus: null, qaEvidencePending: false, qaRetries: 0, deliveryRetries: 0,
    reworkReason: 'STEERING', reworkBaseHash: state.approvedPlanHash ?? null, reworkBasePlanPath: state.planPath ?? null, planPath: null,
    reworkCycles: (state.reworkCycles ?? 0) + 1,
    gateAgents: { ...draft.gateAgents, EXECUTE: [], QA: [] }, agentRetries: { ...draft.agentRetries, EXECUTE: 0, QA: 0 } };
}

/** Validate and apply forge_requirement_summary: the requirement gate then opens PLANNING.
 * Throws an actionable Error when rejected. Returns { state, summarizedHigh, summary }. */
export function applyRequirementSummary(state, params) {
  if (!state?.active || state.phase !== 'REQUIREMENT') throw new Error('no Forge REQUIREMENT gate is active.');
  const missing = missingGateAgentsFor(state);
  if (missing.length) throw new Error(`requirement report missing: run ${missing.join(', ')} once and await its report first.`);
  const summary = normalizeRequirementSummary(params);
  // Cross-check: the requirement agent's OWN severity labels for this gate.
  // A summary may merge duplicates but must not make CRITICAL/HIGH vanish.
  const reported = (state.agentCompletions ?? []).filter(c => c.gate === 'REQUIREMENT' && !c.superseded)
    .reduce((acc, c) => ({ critical: acc.critical + (c.reportedSeverities?.critical ?? 0), high: acc.high + (c.reportedSeverities?.high ?? 0) }), { critical: 0, high: 0 });
  const summarizedHigh = summary.findings.filter(f => ['CRITICAL','HIGH'].includes(f.severity)).length;
  if (reported.critical + reported.high > 0 && summarizedHigh === 0) {
    throw new Error(`the requirement report contains ${reported.critical} CRITICAL and ${reported.high} HIGH label(s), but the summary lists no CRITICAL/HIGH finding. Keep the report's original severity (merge duplicates only) and resubmit.`);
  }
  return {
    state: { ...state, phase: 'PLAN', planWritten: false, requirementSummary: { ...summary, specialistSeverities: reported } },
    summarizedHigh, summary,
  };
}

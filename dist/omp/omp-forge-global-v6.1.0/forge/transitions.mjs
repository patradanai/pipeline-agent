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

/** Human approved the plan through the platform's native approval. */
export function approvedExecutionState(state, auditReason) {
  return { ...state, phase: 'EXECUTING', approved: true, reworkBaseHash: null, executionObserved: false,
    nativeApprovalPending: null,
    gateAgents: { ...(state.gateAgents ?? {}), EXECUTING: [] }, agentRetries: { ...(state.agentRetries ?? {}), EXECUTING: 0 },
    ...(auditReason ? { recoveryAudit: [ ...(state.recoveryAudit ?? []), {
      from: state.phase, to: 'EXECUTING', reason: auditReason, reviewedBy: 'native-plan-review', at: new Date().toISOString(),
    } ].slice(-20) } : {}) };
}

/** Apply an evaluated QA report. FAIL → rework (approval revoked), BLOCKED → evidence pending, PASS → delivery. */
export function qaReportTransition(state, report, { reportPath, workingTree = null } = {}) {
  const failed = report.status === 'FAIL';
  const evidencePending = report.status === 'BLOCKED';
  return {
    ...state,
    phase: failed ? 'REWORK_PLANNING' : evidencePending ? 'QA_EVIDENCE_PENDING' : 'DELIVERY_PREP',
    reworkBasePlanPath: failed ? state.planPath : state.reworkBasePlanPath,
    planPath: failed ? null : state.planPath,
    planWritten: failed ? false : state.planWritten,
    planValid: failed ? false : state.planValid,
    approvedPlanHash: failed ? null : state.approvedPlanHash,
    reworkBaseHash: failed ? state.approvedPlanHash : state.reworkBaseHash,
    active: true,
    approved: !failed,
    qaStatus: report.status,
    qaEvidencePending: evidencePending,
    qaReportPath: reportPath,
    workingTreeAtQa: workingTree,
    reworkCycles: failed ? (state.reworkCycles ?? 0) + 1 : (state.reworkCycles ?? 0),
    gateAgents: { ...(state.gateAgents ?? {}), ...(failed ? { PLANNING: [], EXECUTING: [], QA_REVIEW: [] } : report.status === 'PASS' ? { DELIVERY_PREP: [] } : {}) },
    agentRetries: { ...(state.agentRetries ?? {}), ...(failed ? { PLANNING: 0, EXECUTING: 0, QA_REVIEW: 0 } : report.status === 'PASS' ? { DELIVERY_PREP: 0 } : {}) },
  };
}

/** Preconditions shared by adapters before accepting a QA submission. Throws with an actionable message. */
export function assertQaSubmittable(state, submission) {
  if (!state || state.phase !== 'QA_REVIEW' || !state.approved || !state.planValid || !state.approvedPlanHash) {
    throw new Error('Forge QA report can be submitted only during approved QA_REVIEW.');
  }
  if (!hasGateAgents(state, 'QA_REVIEW') && (submission?.codeReview?.status === 'PASS')) {
    throw new Error(`Independent QA specialists ${requiredAgentsFor(state).join(' and ')} must both run before PASS.`);
  }
}

export function assertDeliverySubmittable(state, workingTreeNow) {
  if (!state || state.phase !== 'DELIVERY_PREP' || state.qaStatus !== 'PASS') throw new Error('Delivery requires a PASS QA gate.');
  if (!hasGateAgents(state, 'DELIVERY_PREP')) throw new Error(`Independent ${requiredAgentsFor(state).join(', ')} agent must run before delivery submission.`);
  const qa = state.workingTreeAtQa;
  if (qa?.available && (!workingTreeNow?.available || workingTreeNow.hash !== qa.hash || workingTreeNow.root !== qa.root)) {
    throw new Error('Working tree changed after QA PASS. Delivery blocked; rerun QA against the current diff.');
  }
}

export function deliveryTransition(state, { deliveryPath, commitMessagePath, commitMessage }) {
  return { ...state, phase: 'DELIVERY', active: false, deliveryPath, commitMessagePath, commitMessage };
}

/** Explicit human request for a new plan after QA FAIL/BLOCKED. */
export function reworkTransition(state) {
  const previousHash = state.approvedPlanHash ?? state.reworkBaseHash ?? null;
  return { ...state, active: true, approved: false, qaEvidencePending: false, phase: 'REWORK_PLANNING', planWritten: false, planValid: false, approvedPlanHash: null,
    reworkBaseHash: previousHash, reworkBasePlanPath: state.reworkBasePlanPath ?? state.planPath, planPath: null,

    reworkCycles: (state.reworkCycles ?? 0) + (state.phase === 'QA_EVIDENCE_PENDING' ? 1 : 0),
    gateAgents: { ...(state.gateAgents ?? {}), REWORK_PLANNING: [] }, agentRetries: { ...(state.agentRetries ?? {}), REWORK_PLANNING: 0 } };
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
  const reported = (state.agentCompletions ?? []).filter(c => c.gate === 'REQUIREMENT')
    .reduce((acc, c) => ({ critical: acc.critical + (c.reportedSeverities?.critical ?? 0), high: acc.high + (c.reportedSeverities?.high ?? 0) }), { critical: 0, high: 0 });
  const summarizedHigh = summary.findings.filter(f => ['CRITICAL','HIGH'].includes(f.severity)).length;
  if (reported.critical + reported.high > 0 && summarizedHigh === 0) {
    throw new Error(`the requirement report contains ${reported.critical} CRITICAL and ${reported.high} HIGH label(s), but the summary lists no CRITICAL/HIGH finding. Keep the report's original severity (merge duplicates only) and resubmit.`);
  }
  return {
    state: { ...state, phase: 'PLANNING', planWritten: false, requirementSummary: { ...summary, specialistSeverities: reported } },
    summarizedHigh, summary,
  };
}

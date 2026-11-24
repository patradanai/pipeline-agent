/** Platform-neutral Forge state identity and resumability rules. */
export const FORGE_STATE_ENTRY = 'dev.omp-forge.workflow.v1';
export const RECOVERABLE_PHASES = Object.freeze(['PLAN', 'EXECUTE', 'QA']);
const RECOVERABLE = new Set(RECOVERABLE_PHASES);
const LEGACY_PHASES = Object.freeze({
  REQUIREMENT: 'PLAN', DISCOVERY: 'PLAN', COOKING: 'PLAN', CHALLENGE: 'PLAN',
  'REQUIREMENT:DISCOVERY': 'PLAN', 'REQUIREMENT:COOKING': 'PLAN',
  'REQUIREMENT:CHALLENGE': 'PLAN',
  PLAN_MODE_PENDING: 'PLAN', PLANNING: 'PLAN', PROPOSAL: 'PLAN',
  AWAITING_APPROVAL: 'PLAN', PLAN_MODE_BLOCKED: 'PLAN', REWORK_PLANNING: 'PLAN',
  EXECUTING: 'EXECUTE', EXECUTION_BLOCKED: 'EXECUTE',
  QA_REVIEW: 'QA', QA_EVIDENCE_PENDING: 'QA', QA_FAILED: 'QA',
  DELIVERY_PREP: 'QA', DELIVERY_BLOCKED: 'QA', DELIVERY: 'QA',
});
const LEGACY_BLOCKED = new Set(['PLAN_MODE_BLOCKED', 'AGENTS_BLOCKED', 'EXECUTION_BLOCKED', 'DELIVERY_BLOCKED', 'QA_FAILED']);
/** The removed requirement gate (v6.2): its reports are not PLAN evidence and its approval flags are void. */
const REQUIREMENT_FAMILY = new Set(['REQUIREMENT', 'DISCOVERY', 'COOKING', 'CHALLENGE', 'REQUIREMENT:DISCOVERY', 'REQUIREMENT:COOKING', 'REQUIREMENT:CHALLENGE']);

/**
 * Normalize persisted legacy checkpoints at a restore boundary. Phase names
 * never constitute approval or QA evidence. Existing evidence is retained;
 * rework uses its own planning agents rather than a superseded plan's agents.
 */
export function normalizeForgeState(state) {
  if (!state || typeof state !== 'object') return state;
  const oldPhase = state.phase;
  const phase = oldPhase === 'AGENTS_BLOCKED'
    ? (LEGACY_PHASES[state.blockedFrom] ?? (RECOVERABLE.has(state.blockedFrom) ? state.blockedFrom : 'PLAN'))
    : (LEGACY_PHASES[oldPhase] ?? oldPhase);
  const legacy = phase !== oldPhase || LEGACY_BLOCKED.has(oldPhase) ||
    [state.gateAgents, state.gateAgentsSpawned, state.agentRetries].some(records =>
      records && typeof records === 'object' && Object.keys(records).some(key => key in LEGACY_PHASES)) ||
    (Array.isArray(state.agentCompletions) && state.agentCompletions.some(record => record && record.gate in LEGACY_PHASES));
  if (!legacy) return state;
  const fromRequirement = REQUIREMENT_FAMILY.has(oldPhase) ||
    (oldPhase === 'AGENTS_BLOCKED' && (!state.blockedFrom || REQUIREMENT_FAMILY.has(state.blockedFrom)));

  const remap = (records, mergeArrays = false) => {
    if (!records || typeof records !== 'object' || Array.isArray(records)) return records;
    const result = {};
    for (const [key, value] of Object.entries(records)) {
      if (oldPhase === 'REWORK_PLANNING' && ['PLANNING', 'PROPOSAL', 'AWAITING_APPROVAL'].includes(key)) continue;
      // Requirement-gate reports are not proof that the PLAN gate ran.
      if (REQUIREMENT_FAMILY.has(key)) continue;
      const mapped = LEGACY_PHASES[key] ?? key;
      if (!RECOVERABLE.has(mapped)) continue;
      if (mergeArrays && Array.isArray(value)) {
        result[mapped] = [...new Set([...(result[mapped] ?? []), ...value])];
      } else if (typeof value === 'number' && typeof result[mapped] === 'number') {
        result[mapped] = Math.max(result[mapped], value);
      } else {
        result[mapped] = value;
      }
    }
    return result;
  };
  return {
    ...state, phase,
    ...(oldPhase === 'REWORK_PLANNING' && state.approved === true ? {
      approved: false,
      reworkBaseHash: state.reworkBaseHash ?? state.approvedPlanHash ?? null,
      reworkBasePlanPath: state.reworkBasePlanPath ?? state.planPath ?? null,
      approvedPlanHash: null, planPath: null, planWritten: false, planValid: false,
    } : {}),
    ...(state.active === false && LEGACY_BLOCKED.has(oldPhase) ? { active: true } : {}),
    ...(state.gateAgents ? { gateAgents: remap(state.gateAgents, true) } : {}),
    ...(state.gateAgentsSpawned ? { gateAgentsSpawned: remap(state.gateAgentsSpawned, true) } : {}),
    ...(state.agentRetries ? { agentRetries: remap(state.agentRetries) } : {}),
    ...(Array.isArray(state.agentCompletions) ? { agentCompletions: state.agentCompletions.map(record =>
      record && LEGACY_PHASES[record.gate] ? { ...record, gate: LEGACY_PHASES[record.gate] } : record) } : {}),
    ...(fromRequirement ? { approved: false, approvedPlanHash: null, planValid: false, planWritten: false } : {}),
  };
}

export function isResumableForgeState(value) {
  const state = normalizeForgeState(value);
  return Boolean(state && typeof state === 'object' && RECOVERABLE.has(state.phase) && state.active === true);
}

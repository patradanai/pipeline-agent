/** Platform-neutral Forge state identity and resumability rules. */
export const FORGE_STATE_ENTRY = 'dev.omp-forge.workflow.v1';
export const RECOVERABLE_PHASES = Object.freeze(['REQUIREMENT', 'PLAN', 'EXECUTE', 'QA']);
const RECOVERABLE = new Set(RECOVERABLE_PHASES);
const LEGACY_PHASES = Object.freeze({
  DISCOVERY: 'REQUIREMENT', COOKING: 'REQUIREMENT', CHALLENGE: 'REQUIREMENT',
  'REQUIREMENT:DISCOVERY': 'REQUIREMENT', 'REQUIREMENT:COOKING': 'REQUIREMENT',
  'REQUIREMENT:CHALLENGE': 'REQUIREMENT',
  PLAN_MODE_PENDING: 'PLAN', PLANNING: 'PLAN', PROPOSAL: 'PLAN',
  AWAITING_APPROVAL: 'PLAN', PLAN_MODE_BLOCKED: 'PLAN', REWORK_PLANNING: 'PLAN',
  EXECUTING: 'EXECUTE', EXECUTION_BLOCKED: 'EXECUTE',
  QA_REVIEW: 'QA', QA_EVIDENCE_PENDING: 'QA', QA_FAILED: 'QA',
  DELIVERY_PREP: 'QA', DELIVERY_BLOCKED: 'QA', DELIVERY: 'QA',
});
const LEGACY_BLOCKED = new Set(['PLAN_MODE_BLOCKED', 'AGENTS_BLOCKED', 'EXECUTION_BLOCKED', 'DELIVERY_BLOCKED', 'QA_FAILED']);

/**
 * Normalize persisted legacy checkpoints at a restore boundary. Phase names
 * never constitute approval or QA evidence. Existing evidence is retained;
 * rework uses its own planning agents rather than a superseded plan's agents.
 */
export function normalizeForgeState(state) {
  if (!state || typeof state !== 'object') return state;
  const oldPhase = state.phase;
  const phase = oldPhase === 'AGENTS_BLOCKED'
    ? (LEGACY_PHASES[state.blockedFrom] ?? (RECOVERABLE.has(state.blockedFrom) ? state.blockedFrom : 'REQUIREMENT'))
    : (LEGACY_PHASES[oldPhase] ?? oldPhase);
  const legacy = phase !== oldPhase || LEGACY_BLOCKED.has(oldPhase) ||
    [state.gateAgents, state.gateAgentsSpawned, state.agentRetries].some(records =>
      records && typeof records === 'object' && Object.keys(records).some(key => key in LEGACY_PHASES)) ||
    (Array.isArray(state.agentCompletions) && state.agentCompletions.some(record => record && record.gate in LEGACY_PHASES));
  if (!legacy) return state;

  const remap = (records, mergeArrays = false) => {
    if (!records || typeof records !== 'object' || Array.isArray(records)) return records;
    const result = {};
    for (const [key, value] of Object.entries(records)) {
      if (oldPhase === 'REWORK_PLANNING' && ['PLANNING', 'PROPOSAL', 'AWAITING_APPROVAL'].includes(key)) continue;
      // A legacy substep report is not proof that the unified gate ran.
      if (['DISCOVERY', 'COOKING', 'CHALLENGE', 'REQUIREMENT:DISCOVERY', 'REQUIREMENT:COOKING', 'REQUIREMENT:CHALLENGE'].includes(key)) continue;
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
  };
}

export function isResumableForgeState(value) {
  const state = normalizeForgeState(value);
  return Boolean(state && typeof state === 'object' && RECOVERABLE.has(state.phase) && state.active === true);
}

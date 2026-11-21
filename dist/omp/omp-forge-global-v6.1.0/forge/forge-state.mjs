/** Platform-neutral Forge state identity and resumability rules. */
export const FORGE_STATE_ENTRY = 'dev.omp-forge.workflow.v1';
export const RECOVERABLE_PHASES = Object.freeze([
  'REQUIREMENT','PLAN_MODE_PENDING','PLANNING','PROPOSAL','AWAITING_APPROVAL',
  'PLAN_MODE_BLOCKED','AGENTS_BLOCKED','EXECUTION_BLOCKED','EXECUTING',
  'QA_REVIEW','QA_EVIDENCE_PENDING','QA_FAILED','REWORK_PLANNING','DELIVERY_PREP','DELIVERY_BLOCKED',
]);
const RECOVERABLE = new Set(RECOVERABLE_PHASES);

export function isResumableForgeState(value) {
  if (!value || typeof value !== 'object' || !RECOVERABLE.has(value.phase)) return false;
  // A blocked workflow may have active:false intentionally. Completed and cancelled
  // sessions must not be surfaced merely because an older custom entry was active.
  return value.active === true || value.phase.endsWith('_BLOCKED') || value.phase === 'QA_FAILED';
}

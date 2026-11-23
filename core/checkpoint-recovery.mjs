/**
 * Forge checkpoint mirror, separate from project files. OMP branch state
 * remains authoritative. A mirror is *only* a human-review recovery hint.
 * A mirrored approval is NEVER sufficient to authorize implementation.
 *
 * Schema 2 (v5.23): one private file per OMP session, holding the latest
 * written state plus up to MAX_RECENT recent workflows keyed by slug, so a
 * save on one branch no longer erases a different workflow saved on another.
 */
import { createHash } from 'node:crypto';
import {
  chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, unlinkSync, writeSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { FORGE_STATE_ENTRY, isResumableForgeState, normalizeForgeState } from './forge-state.mjs';

const MAX_BYTES = 1024 * 1024;
const MAX_SESSION_PATH = 4096;
const MAX_REQUIREMENT = 25000;
const MAX_RECENT = 8;
const SCHEMA = 2;
export const CHECKPOINT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TEMP_TTL_MS = 60 * 60 * 1000;
const CHECKPOINT_NAME = /^[0-9a-f]{64}\.json$/;
const TEMP_NAME = /^[0-9a-f]{64}\.json\.tmp-/;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function sessionIdentity(manager, cwd) {
  const sessionId = manager?.getSessionId?.();
  const sessionFile = manager?.getSessionFile?.();
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256 ||
      typeof sessionFile !== 'string' || sessionFile.length > MAX_SESSION_PATH || !isAbsolute(sessionFile)) return null;
  const canonicalPath = resolve(sessionFile);
  const fingerprint = createHash('sha256').update(sessionId + '\0' + canonicalPath).digest('hex');
  return { sessionId, sessionFile: canonicalPath, cwd: typeof cwd === 'string' ? cwd : '', fingerprint };
}

/** Identity used only to KEY an in-memory recovery offer (never persisted).
 * Sessions without a file cannot have a mirror, but their full history can
 * still provide an unambiguous, human-confirmed recovery candidate. */
export function recoveryIdentity(manager, cwd) {
  const persistent = sessionIdentity(manager, cwd);
  if (persistent) return persistent;
  const sessionId = manager?.getSessionId?.();
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256) return null;
  return { sessionId, sessionFile: null, cwd: typeof cwd === 'string' ? cwd : '',
    fingerprint: 'memory-' + createHash('sha256').update(sessionId).digest('hex') };
}

function checkpointPath(root, identity) {
  return join(root, `${identity.fingerprint}.json`);
}

function sameIdentity(actual, expected) {
  return actual?.sessionId === expected?.sessionId && actual?.sessionFile === expected?.sessionFile &&
    actual?.fingerprint === expected?.fingerprint;
}

function isPersistentIdentity(identity) {
  return Boolean(identity && typeof identity.sessionFile === 'string' && /^[0-9a-f]{64}$/.test(identity.fingerprint ?? ''));
}

function ensurePrivateDir(root) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const st = lstatSync(root);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('Forge checkpoint root is not a private directory');
  // mkdirSync's mode only applies on creation; tighten pre-existing folders too.
  try { if ((st.mode & 0o077) !== 0) chmodSync(root, 0o700); } catch { /* best effort */ }
}

function readDoc(root, identity) {
  if (!isPersistentIdentity(identity)) return null;
  try {
    const filename = checkpointPath(root, identity);
    const st = lstatSync(filename);
    if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_BYTES) return null;
    const doc = JSON.parse(readFileSync(filename, 'utf8'));
    if ((doc?.schema !== 1 && doc?.schema !== SCHEMA) || !sameIdentity(doc.identity, identity)) return null;
    if (!doc.state || typeof doc.state !== 'object') return null;
    return doc;
  } catch { return null; }
}

function recentOf(doc) {
  if (!doc) return [];
  if (doc.schema === SCHEMA && Array.isArray(doc.recent)) {
    return doc.recent.filter(r => r && typeof r.slug === 'string' && SLUG.test(r.slug) && r.state && typeof r.state === 'object');
  }
  // schema 1 upgrade: the single stored state becomes the only recent entry.
  const s = doc.state;
  return typeof s?.slug === 'string' && SLUG.test(s.slug) ? [{ slug: s.slug, savedAt: doc.savedAt ?? null, state: s }] : [];
}

function isTombstone(state) {
  return state?.active === false && !(typeof state.slug === 'string' && state.slug);
}

function writeAtomic(destination, payload) {
  const temp = `${destination}.tmp-${process.pid}-${createHash('sha256').update(payload).digest('hex').slice(0, 10)}`;
  try {
    const fd = openSync(temp, 'wx', 0o600);
    try { writeSync(fd, payload + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, destination);
    try { const dir = openSync(resolve(destination, '..'), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); } } catch { /* platform-dependent */ }
  } finally {
    try { unlinkSync(temp); } catch {}
  }
}

export function persistForgeCheckpoint(root, identity, state) {
  if (!isPersistentIdentity(identity) || !state || typeof state !== 'object' ||
      !(typeof state.phase === 'string' || state.active === false)) return false;
  ensurePrivateDir(root);
  const destination = checkpointPath(root, identity);
  const savedAt = new Date().toISOString();
  let recent = recentOf(readDoc(root, identity));
  if (isTombstone(state)) {
    // An explicit /forge off: a named cancel drops only that workflow, an
    // anonymous tombstone retires every mirrored workflow of the session.
    recent = typeof state.cancelledSlug === 'string' ? recent.filter(r => r.slug !== state.cancelledSlug) : [];
  } else if (typeof state.slug === 'string' && SLUG.test(state.slug)) {
    recent = [{ slug: state.slug, savedAt, state }, ...recent.filter(r => r.slug !== state.slug)];
  }
  recent = recent.slice(0, MAX_RECENT);
  const build = () => JSON.stringify({ schema: SCHEMA, identity, savedAt, state, recent });
  let payload = build();
  while (Buffer.byteLength(payload) > MAX_BYTES && recent.length > 1) { recent = recent.slice(0, -1); payload = build(); }
  if (Buffer.byteLength(payload) > MAX_BYTES) throw new Error('Forge checkpoint exceeds size limit');
  writeAtomic(destination, payload);
  return true;
}

/** Latest written state of this exact session (any validity). */
export function loadForgeCheckpointRecord(root, identity) {
  return normalizeForgeState(readDoc(root, identity)?.state ?? null);
}

export function loadForgeCheckpoint(root, identity) {
  const state = loadForgeCheckpointRecord(root, identity);
  return isValidRestoreCandidate(state) ? state : null;
}

/** Restorable workflows of this session, newest first. A terminal latest
 * state (cancel tombstone, finished delivery, inactive non-blocked state)
 * suppresses every offer: the last thing the human did was close Forge. */
export function loadForgeCheckpointCandidates(root, identity) {
  const doc = readDoc(root, identity);
  if (!doc) return [];
  if (doc.state.active === false && !isValidRestoreCandidate(doc.state)) return [];
  return recentOf(doc)
    .filter(r => isValidRestoreCandidate(r.state) && r.state.slug === r.slug)
    .map(r => ({ state: normalizeForgeState(r.state), savedAt: typeof r.savedAt === 'string' ? r.savedAt : null }));
}

export function isValidRestoreCandidate(state) {
  return isResumableForgeState(state) && typeof state.requirement === 'string' &&
    state.requirement.trim().length > 0 && state.requirement.length <= MAX_REQUIREMENT &&
    typeof state.slug === 'string' && SLUG.test(state.slug);
}

/** Remove mirrors untouched for `maxAgeMs` and abandoned temp files. Only
 * touches regular files whose names match Forge's own fingerprint format. */
export function pruneForgeCheckpoints(root, { maxAgeMs = CHECKPOINT_TTL_MS, now = Date.now() } = {}) {
  let removed = 0;
  let names;
  try {
    const st = lstatSync(root);
    if (st.isSymbolicLink() || !st.isDirectory()) return 0;
    names = readdirSync(root);
  } catch { return 0; }
  for (const name of names) {
    const isCheckpoint = CHECKPOINT_NAME.test(name);
    const isTemp = TEMP_NAME.test(name);
    if (!isCheckpoint && !isTemp) continue;
    try {
      const full = join(root, name);
      const st = lstatSync(full);
      if (!st.isFile() || st.isSymbolicLink()) continue;
      if (now - st.mtimeMs > (isTemp ? TEMP_TTL_MS : maxAgeMs)) { unlinkSync(full); removed++; }
    } catch { /* concurrently removed or unreadable */ }
  }
  return removed;
}

/** When branch has no Forge entry, full session history is only a hint.
 * Avoid selecting arbitrarily among different Forge workflows/branches.
 */
export function candidateFromSessionEntries(entries) {
  if (!Array.isArray(entries)) return null;
  const candidates = new Map();
  for (const entry of entries) {
    if (entry?.type !== 'custom' || entry.customType !== FORGE_STATE_ENTRY) continue;
    const state = normalizeForgeState(entry.data);
    if (isTombstone(state)) {
      if (typeof state.cancelledSlug === 'string') candidates.delete(state.cancelledSlug);
      else candidates.clear();
      continue;
    }
    if (isValidRestoreCandidate(state)) candidates.set(state.slug, state);
    else if (state && typeof state.slug === 'string') candidates.delete(state.slug);
  }
  return candidates.size === 1 ? [...candidates.values()][0] : null;
}

/** Safe, human-confirmed recovery. Prior approval is recorded in the audit,
 * but never inherited when the approved branch's history is not present.
 * The user must obtain a fresh native plan approval before EXECUTE.
 */
export function prepareHumanRecovery(candidate) {
  if (!isValidRestoreCandidate(candidate)) throw new Error('Invalid Forge recovery checkpoint');
  const prior = candidate.phase;
  candidate = normalizeForgeState(candidate);
  const stage = candidate.approved === true || ['EXECUTE', 'QA'].includes(candidate.phase)
    ? 'PLAN' : candidate.phase;
  return {
    ...candidate,
    active: true,
    phase: stage,
    ...(stage === 'PLAN' ? {planWritten: false, planValid: false, planPath: null, reviewRequested: false} : {}),
    approved: false, approvedPlanHash: null, qaStatus: 'pending', qaEvidencePending: false,
    executionObserved: false, blockedFrom: null,
    gateAgents: { ...(candidate.gateAgents ?? {}), [stage]: [] },
    agentRetries: { ...(candidate.agentRetries ?? {}), [stage]: 0 },
    recoveryAudit: [ ...(candidate.recoveryAudit ?? []), {
      from: prior, to: stage, reason: 'missing-current-branch-checkpoint',
      reviewedBy: 'human', at: new Date().toISOString(),
      priorApprovalRevoked: Boolean(candidate.approved),
    } ].slice(-20),
  };
}

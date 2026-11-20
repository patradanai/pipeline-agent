/** OMP adapter: Forge session discovery helpers. Only reads OMP's existing JSONL session history. */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import { FORGE_STATE_ENTRY, isResumableForgeState } from './forge-state.mjs';
export { FORGE_STATE_ENTRY, isResumableForgeState };

export async function readLatestForgeState(sessionPath) {
  let latest = null;
  const stream = createReadStream(sessionPath, { encoding:'utf8' });
  const rows = createInterface({ input:stream, crlfDelay:Infinity });
  try {
    for await (const row of rows) {
      if (!row.includes(FORGE_STATE_ENTRY)) continue;
      let entry;
      try { entry = JSON.parse(row); } catch { continue; }
      if (entry?.type === 'custom' && entry.customType === FORGE_STATE_ENTRY) {
        latest = entry.data || null;
      }
    }
  } finally {
    rows.close();
    stream.destroy();
  }
  return latest;
}

/**
 * OMP SessionManager.listForPicker / listAllForPicker returned SessionInfo[] in
 * older builds. In v19, they return PickerListing with an indexed `sessions`
 * preview and a `complete: Promise<SessionInfo[]>` for the full scan.
 *
 * Prefer the complete scan: Forge state resides inside JSONL files, so a
 * session omitted from the indexed preview must remain discoverable. If the
 * full scan fails, safely fall back to any valid preview list.
 */
export async function resolvePickerSessions(listing) {
  if (Array.isArray(listing)) return listing;
  if (!listing || typeof listing !== 'object') return [];
  const preview = Array.isArray(listing.sessions) ? listing.sessions : [];
  if (listing.complete && typeof listing.complete.then === 'function') {
    try {
      const full = await listing.complete;
      if (Array.isArray(full)) return full;
    } catch { /* retain valid indexed preview on listing failure */ }
  }
  return preview;
}

export async function discoverForgeSessions(sessions, { readState=readLatestForgeState, maxScan=150, concurrency=8 } = {}) {
  const unique = [];
  const seen = new Set();
  for (const info of sessions.slice(0, maxScan)) {
    if (!info?.path || seen.has(info.path)) continue;
    seen.add(info.path);
    unique.push(info);
  }
  // Bounded parallel reads; results keep the picker's original order.
  const results = new Array(unique.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < unique.length) {
      const i = next++;
      try {
        const state = await readState(unique[i].path);
        if (isResumableForgeState(state)) results[i] = { info: unique[i], state };
      } catch { /* unreadable session cannot be presented as safe to resume */ }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, unique.length)) }, worker));
  return results.filter(Boolean);
}

export function forgeSessionLabel(item, index, { showCwd=false }={}) {
  const rawTitle = item.state.requirement || item.info.title || item.info.firstMessage || 'Untitled workflow';
  const title = String(rawTitle).replace(/[\r\n\t]/g, ' ').trim().slice(0, 66);
  const stage = String(item.state.phase).replace(/_/g,' ');
  const location = showCwd && item.info.cwd ? ` · ${String(item.info.cwd).split('/').filter(Boolean).slice(-2).join('/')}` : '';
  return `${index + 1}. [${stage}] ${title}${location}`;
}

/** Validate a selected session against OMP's actual active branch after switch.
 * The last custom entry in the JSONL file is not necessarily on the selected
 * branch (tree edits and resume can select an older leaf). Fail closed instead
 * of treating an unrelated REQUIREMENT as the intended EXECUTING checkpoint.
 */
export function sameResumeCheckpoint(selected, restored) {
  if (!isResumableForgeState(selected) || !isResumableForgeState(restored)) return false;
  if (selected.phase !== restored.phase) return false;
  if (selected.slug && restored.slug && selected.slug !== restored.slug) return false;
  if (selected.requirement && restored.requirement && selected.requirement !== restored.requirement) return false;
  if (Boolean(selected.approved) !== Boolean(restored.approved)) return false;
  if (selected.approvedPlanHash && restored.approvedPlanHash && selected.approvedPlanHash !== restored.approvedPlanHash) return false;
  return true;
}

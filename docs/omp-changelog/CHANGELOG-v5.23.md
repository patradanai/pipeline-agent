# Forge v5.23 — Approval Handoff & Guarded Recovery

Code-review follow-up to v5.22.

## Fixed — high

- **No more approve → branch switch → re-plan loop.** When OMP moves to a new
  branch as part of leaving Plan Mode right after a native approval, Forge
  carries that approval forward (`reason: plan-approval-branch-handoff` in
  `recoveryAudit`). The handoff is in-process only, single-use, expires after
  15 s, requires the same OMP session id, an EXECUTING state with a valid
  approved-plan hash, and a target branch with **no** Forge entry. Tombstones,
  other workflows, refine/dismiss, restarts and session switches never receive it.
- **No fail-open window.** While an orphaned workflow is unresolved
  (`RECOVERY_AVAILABLE`), the main agent is limited to `read/grep/glob/ls/ask`.
  Edits, shell and subagents are blocked with an instruction to run
  `/forge recover`. Git-write and repo-publishing guards stay on even after the
  human chooses "Keep this branch inactive". Sessions with no Forge history are
  unaffected.

## Fixed — medium

- Blocked workflows (`*_BLOCKED`, `active:false`) in the mirror are recoverable
  again; only cancel tombstones and finished/inactive states are terminal.
- Mirror schema 2: per-session file keeps up to 8 recent workflows by slug,
  so a save on one branch no longer erases a different workflow. The recovery
  picker shows requirement + saved time and offers up to two older workflows.
  Schema 1 files from v5.22 are read transparently.
- `/forge off` now records `cancelledSlug`; it retires that workflow from the
  mirror and history fallback without touching others.
- Recovery into `REWORK_PLANNING` pins the superseded plan exactly like
  `/forge rework` (`reworkBasePlanPath`, `reworkBaseHash`, `planPath: null`),
  so the previously approved plan cannot be overwritten.
- `DELIVERY_PREP → QA_EVIDENCE_PENDING` recovery sets `qaEvidencePending: true`.

## Fixed — low

- Checkpoints untouched for 30 days and abandoned temp files are pruned once
  per OMP start (only Forge-named regular files; symlinks ignored).
- Checkpoint dir is tightened to `0700` even if it pre-existed; writes are
  `fsync`ed before the atomic rename.
- Tombstone `version` is consistent (9) on branch and mirror.
- File-less sessions can still get an unambiguous history-based recovery offer.
- `/forge resume` session discovery reads up to 8 files in parallel, order kept.
- `install.sh` restores agents parked by `uninstall.sh` (`*.disabled.*`)
  instead of overwriting them with bundled defaults.
- Changelogs moved to `docs/changelog/`; README/QUICKSTART updated.

## Tests

- 180/180 automated tests (was 158), smoke install/uninstall/reinstall PASS.
- Mock OMP API only. The handoff assumes OMP emits `session_branch`,
  `session_tree` or `session_switch` within 15 s of `plan_review_resolved`;
  validate on macOS OMP v19 with `/forge status` right after approval.

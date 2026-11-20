# Forge v5.22 — Branch-Aware State Recovery

## Fixed

- After native OMP Plan Mode exits or a session tree switch, Forge no longer silently reports `inactive` just because the new branch does not contain a Forge custom entry.
- Every workflow state write is mirrored outside the repository in the private user folder `~/.omp/agent/forge-checkpoints/`, keyed by **both** the OMP Session ID and the exact Session File path.
- If the active branch has no Forge entry but a same-session checkpoint exists, the footer shows `FORGE · Recovery available · /forge recover`; `/forge status` reports the last known Gate.
- An interactive Recovery Picker (when OMP is idle) offers safe state restoration, keeping the current branch, or an explanation. Selecting recovery creates a fresh Forge entry on the current branch; declining makes no changes.
- Explicitly cancelled/completed workflows leave an inactive checkpoint and are **not** automatically offered for recovery.
- When the mirror is unavailable, unambiguous entries from OMP's full same-session history can be presented as a fallback; ambiguous histories do not guess.

## Approval safety

- An approved `EXECUTING`, `QA_REVIEW` or later workflow on another branch is **not** automatically reauthorized for implementation. After explicitly confirming an off-branch recovery, Forge returns to `PLANNING`, clears approval/QA privileges and requires a fresh native OMP Plan Approval.
- To retain an already approved execution without renewed approval, navigate to the **original OMP branch containing the approved checkpoint** via native `/resume`, then inspect `/forge status`.
- A branch-local cancellation marker always wins over a previous mirrored checkpoint.
- No auto Git commits/pushes, approval bypasses, or project source edits were added.

## Tests

- Existing workflow, QA, approval, install and status tests retained.
- New unit/integration cases cover matching session identities, mirror persistence, absent branch state, human recovery, cancel/decline, historical fallback, permission downgrade, and tombstone behavior.
- Tests run in a mock OMP Extension API, not on the user's Mac.

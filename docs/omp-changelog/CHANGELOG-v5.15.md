# v5.15 — Forge Session Resume Picker

- `/forge resume` with no active workflow opens a native OMP **select dialog** listing saved, resumable Forge sessions from the current project. Select **Search all projects…** to find workflows in other projects.
- Reads Forge state from existing OMP JSONL sessions (`dev.omp-forge.workflow.v1`). It does **not** create a second workflow store and does not copy checkpoints across session boundaries.
- Uses OMP's public session listing and `ExtensionCommandContext.switchSession()`; the existing `session_switch` handler restores the selected session's own branch state. Resumes from its recorded Gate.
- Lists active and explicitly blocked states; ignores cancelled/completed workflows. The most recent checkpoint in the JSONL determines eligibility.
- If OMP rejects switching or the picker is dismissed, current session remains unchanged. Refuses session switching from a subagent.
- Human approval, independent QA, and no-auto-commit policies are unchanged.

## Limitations

This selector uses OMP's standard `ctx.ui.select` dialog, **not** the fullscreen fuzzy-search `/resume` picker. It scans at most the latest 100 current-project or 250 all-project session files for Forge checkpoints. For older files or unusual session backends, open OMP `/resume` and then `/forge resume`. A live E2E test is still required on the operator's installed OMP version.

# v5.12 — Simplified Native OMP Agent Management

- Removed Forge's duplicate Agent chooser, setter/resetter commands, assignment config changes, and related auto-completion.
- Kept `/forge agents` as a read-only map with found/missing Agent file diagnostics and declared model hints.
- Uses nine fixed `forge-*` agent names; all model/prompt configuration belongs to OMP `/agents`.
- Deprecated `/forge agent ...` now provides guidance; it does not start a requirement or mutate config.
- New workflows ignore deprecated `agentAssignments` overrides, but existing session snapshots remain resumable.
- Preflight checks that all nine Forge Agent definition files exist before starting.
- Installer retains user-edited Agent definitions by default, avoiding model override loss on upgrade.
- Preserved Gate Skills, 5-stage minimal UI, native Approval/Rework, evidence-driven QA and manual Git delivery.

# Forge v5.20 — State Recovery Popup and Rework Safety

- Implemented `state-recovery.mjs`: pure conservative state consistency checks.
- Added native TUI popup when the loaded checkpoint is inconsistent with
  recorded plan, QA, or approval evidence; the user can Switch, Keep, or view
  the explanation. No automatic state switching.
- Added `/forge recover` and `/forge status` state warning.
- Added safeguards against race conditions while the user is reviewing a
  suggestion, and an audit trail for confirmed state corrections.
- Prevented unsafe subagent dispatch and mutating tools during structural
  state contradictions; no auto approval, auto QA PASS, auto commit/push.
- Fixed rework path pinning: a new local:// plan can be written, with native
  human approval still mandatory before implementation.
- Fixed explicit evidence-to-rework transition so failure to enter Plan Mode
  does not destroy the earlier approved QA checkpoint.
- 141/141 automated tests plus installer/uninstaller smoke test passed locally.

Note: OMP TUI and actual plan approvals must still be verified on the user's Mac.

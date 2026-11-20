# OMP Forge v5.4 — Event-driven Gate Transition Hotfix

## Fixed

- REQUIREMENT internal steps auto-advance on successful named task completion, not only `session_stop`.
- Injects next-stage instruction via OMP `tool_result.additionalContext` in the same agent turn.
- Blocks plan approval until a successful canonical `local://<slug>-plan.md` write.
- Failed plan writes leave state in PLANNING (no false PROPOSAL).
- Handles Plan Mode `busy`: waits until the main turn settles to enter Plan Mode and then continues.
- Uses `sessionModes.set({mode:"plan",action:"enter"})` for inactive/paused Plan Mode.
- Requirement read-only block explicitly instructs the agent to finish named specialists, not request a user next-gate command.

## Unchanged

- Global install, 9 specialist agents, native terminal approval, strict BIZ/REQ/TC/QG QA, human-approved rework, manual-only Git delivery, multiline `/forge` input.
- Tool guards are not a full operating-system sandbox.

## Validation

- 54/54 Node mock/unit tests pass (including 5 new regression tests).
- Installer/uninstaller smoke test in isolated temporary directory.
- End-to-end operation on the user's installed OMP remains unverified.

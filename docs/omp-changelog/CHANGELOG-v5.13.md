# Forge v5.13 — Native Plan Proposal Deadlock Hotfix

## Fixed
- Native `write xd://propose` can be forwarded while the Forge workflow remains in `PLANNING` after a successfully written `local://` plan. OMP itself verifies that the plan file exists and that native Plan Mode is active before opening its Approval UI.
- A legitimate `plan_review_requested` event now bridges the stale `PLANNING` state directly to `AWAITING_APPROVAL` after validation of the business-topic, requirement, test-case, and quality-gate contract. No execution is allowed before an actual human approval.
- Clarified planner instruction: when local plan writing succeeds but tool-result tracking misses the event, submit only the plan slug, not a path, to `xd://propose`.
- Reject malformed proposal values; still block arbitrary `xd://` writes, source changes, and git commit/push before approval.

## Testing
- 104 automated tests passed, including two regressions for lost write telemetry, native review, invalid plan, and policy guards.
- Installer/uninstaller smoke test passed. Real OMP TUI end-to-end approval remains unverified on the user's Mac.

## Existing session recovery
1. Install this hotfix and restart OMP; open the same session.
2. `/forge status` should show the existing PLANNING workflow.
3. Ask OMP to submit the saved plan using `write` with `path: xd://propose` and content equal to the plan slug (e.g. `forge-mwnpvafm`). Do not repeat Requirement/Planning unless session recovery failed.
4. Do not try to bypass native OMP Plan Mode; if OMP says Plan Mode is inactive, re-enter Plan Mode before submitting.

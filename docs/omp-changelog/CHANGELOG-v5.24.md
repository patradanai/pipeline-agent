# Forge v5.24 — Approval Survives OMP "Approve and execute" New Session

## Root cause (verified against @oh-my-pi/pi-coding-agent 19.0.1)

`interactive-mode.ts #approvePlan` runs with `preserveContext: choice !== "execute"`.
For **execute** it calls `handleClearCommand()`: a brand-new session (new id
and file), announced as `session_switch { reason: "new", previousSessionFile }`.
`plan_review_resolved` is emitted from the overlay's `onClose`, which
`prepareSessionSwitch()` triggers, so it can land before or after that switch.
v5.23 only handled a branch change inside the same session id, so Forge state
stayed behind in the planning session and the execution session showed none.

## Fixed

- **Order A** (resolved first): the fresh EXECUTING approval is carried into the
  new session when `previousSessionFile` is the file that owned the native
  review, within 60 s, single-use, new session empty of Forge entries.
  Audit: `plan-approval-new-session-handoff`.
- **Order B** (switch first): the workflow is carried as `AWAITING_APPROVAL`
  with `nativeApprovalPending {reviewId, planFilePath}`. Writes stay blocked.
  It becomes EXECUTING only through (a) `plan_review_resolved` for that same
  `reviewId` with an approval choice, or (b) OMP's own
  `mode_change {mode:"none", data.approvedPlanFilePath}` entry, which
  `#approvePlan` appends to the new session before the execution turn.
  Audit: `native-approval-mode-change-entry`.
- `plan_review_requested`: OMP's real field `planFilePath` is now recorded
  (`nativePlanFilePath`). The Forge `local://…-plan.md` write pin is unchanged.

## Not carried

Plain `/new`, a refine/dismiss, a different previous session file, a stale
(> 60 s) approval, or a new session that already has Forge entries.

## Tests

188/188 (8 new). The 4 core v5.24 tests fail on v5.23 and pass on v5.24.

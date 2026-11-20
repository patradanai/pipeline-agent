# Forge v5.14 — Deferred Native Plan Review Recovery

Fixes the second half of the Plan approval deadlock seen on v5.13:

- In v5.13, Forge no longer blocked `write xd://propose`, but native OMP still rejected it with `No plan is awaiting approval` if Plan Mode was paused/inactive.
- `sessionModes.set({ mode: 'plan', action: 'enter' })` is refused with `busy` during an active turn, compaction, or mode transition. Repeating `xd://propose` does not fix the native state.

## Changes

- After a successful `local://...-plan.md` write, defer Plan Mode recovery until the OMP session is idle. Retry transient `busy` results with a bounded managed timer; never force an implementation write.
- Use native `ctx.openPlanReview()` after Plan Mode is active, without repeatedly asking the model to submit `xd://propose`.
- If Forge misses the write-result event but a proposal is attempted while Plan Mode is paused, mark the submission deferred and retry only when idle. OMP remains responsible for proving the plan file exists.
- Restore old `PLAN_MODE_BLOCKED` sessions through `/forge resume`, using the existing plan for native review rather than regenerating it when `planWritten` or `blockedFrom: PROPOSAL` is set.
- Preserve source-write restrictions, independent QA, manual approval, and the no-auto-commit/push policy.
- Do not automatically approve any plan; only open OMP's native human review.

## Tests

108/108 automated checks pass, including new mocks for paused/inactive Plan Mode, `busy` retries, missed plan write telemetry, non-retryable mode failures, and recovery of a blocked session. Installer smoke test is separate. These are **not** a live OMP end-to-end test.

## Known limitation

A `local://` plan belongs to its OMP session. If the plan file is absent from the current session or `plan.enabled` / `extensionHandlers.modeControl` is disabled, `openPlanReview()` can still fail. Keep the original OMP session and use `/plan-review` or `/forge resume` after resolving host-level mode settings.

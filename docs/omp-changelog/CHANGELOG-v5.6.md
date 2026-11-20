# OMP Forge v5.6 — Plan Sandbox Write Hotfix

## Root cause

`PLANNING` previously permitted a canonical `local://<slug>-plan.md` write only when `ctx.sessionModes.getState().plan === "active"`. OMP can temporarily return paused/inactive during a tool hook even after the planner completed, making Forge incorrectly block the plan file and repeatedly ask the user how to proceed.

## Fix

- Authorize **only** root-level `local://*-plan.md` write operations during PLANNING based on workflow gate + constrained path. Native OMP remains in control of any additional plan-mode restrictions.
- Do not allow source/workspace writes, arbitrary `local://` files, bash redirect workarounds, or `xd://propose` before successful plan-file creation.
- Record the precise plan path after a successful `write` result; allow PROPOSAL to write only that same local plan and `xd://propose`; never propose automatically.
- Rework resets `planWritten`, `planValid`, and the previous approval hash before requesting a new plan file.
- Keep all separate specialist agents, 5-stage minimal status UI, Human Approval, independent QA, and manual-only Git operations.

## Limitations

This patch is tested with mocked OMP extension events, not yet with the user's installed OMP runtime. OMP itself can still deny a `local://` write if its own native Plan Mode is not available. The extension cannot override OMP's native authorization; that would be a different failure message.

### Install

Unzip, `cd omp-forge-global-v5.6`, `bash install.sh`, restart OMP. For a previously deadlocked session use `/forge off` then `/forge` with your original requirement in a fresh session.

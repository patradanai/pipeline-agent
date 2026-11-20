# Forge v5.21 — Persistent Gate Status After Plan Mode

## Fixed

- OMP may rebuild transient composer widgets when leaving native Plan Mode, hiding Forge's previous above-editor progress display.
- Forge now prefers `ctx.ui.setStatus('forge-phase', ...)` for a **persistent, compact footer status** tied to the actual persisted workflow phase.
- The legacy above-editor widget is removed when `setStatus` is available (prevents duplicate progress lines); older OMP integrations without `setStatus` retain the original widget.
- Status is re-applied on session start, session switch/branch/tree, native plan review resolution, main-agent start/end, and session stop.
- The Execution → QA transition refreshes status immediately.
- The status UI is presentation-only: no extra Gate transitions, approvals, source writes, or Git actions.

## Expected status

- After approved plan: `FORGE Execution 3/5`
- During independent QA: `FORGE QA review 4/5`
- During QA evidence collection: `FORGE QA evidence needed 4/5`
- Rework planning: `FORGE Planning 2/5 Rework N`
- Native approval overlay / finished delivery: no redundant Forge status.

## Limitations

- This patch restores the display when Forge's session state is still present. It does **not** reconstruct missing/corrupt workflow checkpoints. If `/forge status` says `inactive` after approval, investigate the session/branch and use OMP `/resume` rather than assuming an Execution checkpoint.
- Native OMP interactive behavior still requires validation on the user's macOS OMP v19 installation.

## Verification

- 144/144 automated tests pass, including plan-review → execution footer restore and QA transition.
- Installer / uninstaller smoke test passes.

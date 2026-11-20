# OMP Forge v5.5 — Minimal Status UI

## Changes

- Replaced 5-line, 6-node debug-style gate widget with **one concise line**: `FORGE  ▰▰▱▱▱  Planning  2/5`.
- Hide the Forge widget during `PROPOSAL` and `AWAITING_APPROVAL`, leaving the OMP Native Plan Review to handle plan approval without duplicate UI.
- Display five user-facing work stages only: Requirement, Planning, Execution, QA review and Delivery.
- Avoid showing future gates, hollow-circle indicators and a permanent success widget after Delivery.
- Show a concise action hint (`/forge status`) if a workflow is blocked; retain detailed diagnostics on-demand.
- Preserve the exact state machine, specialist-agent routing, approval guards, QA requirements, rework loop and manual Git commit policy from v5.4.

## Verification

- 64/64 Node mock/logic tests passed.
- Installer and uninstaller smoke tests passed in a temporary directory.
- **Not yet tested end-to-end against a local OMP TUI**; appearance depends on terminal font and theme.

## Install

Unzip and execute `bash install.sh` from inside `omp-forge-global-v5.5`, then restart OMP.

# OMP Forge Global v5.3 — Unified REQUIREMENT gate

## What changed
- Only one user-facing **REQUIREMENT** gate instead of DISCOVERY, COOKING and CHALLENGE as separate gates.
- Internal requirement loop: Discovery (forge-requirement), Cooking (forge-requirement, forge-critic, forge-architect, forge-qa-strategist), Challenge (forge-critic, forge-architect).
- These are automatic steps, not separate user approvals; each named agent must return a successful task result before the next step.
- Progress UI: REQUIREMENT → PLANNING → APPROVAL → EXECUTION → QA → DELIVERY.
- Migrates in-progress branch-local workflows from v5.2 DISCOVERY/COOKING/CHALLENGE to REQUIREMENT with their existing internal step and completed-agent records.
- Preserves the v5.2 multiline input and native OMP approval UI; post-execution QA and no-auto-commit policy unchanged.

## Install

```sh
unzip omp-forge-global-v5.3-unified-requirement.zip
cd omp-forge-global-v5.3
bash install.sh
```
Restart OMP. In OMP type `/forge`, hit Enter and write your multiline requirement.

## Verification
49/49 mock tests and installer/uninstaller smoke test passed with Node v22.16.0.
Not yet tested end-to-end on your installed OMP runtime.

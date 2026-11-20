# v5.7 — Global Configurable Gate Agents

- Added `/forge agents`, `/forge agent` interactive picker, `/forge agent list`.
- Added `/forge agent set <gate> <role> <name>` and shorthand for single-role gates.
- Added `/forge agent reset <gate|all> [role]`.
- Added global agent registry discovery from `~/.omp/agent/agents/`.
- Persists assignments in existing `config.json` without discarding auto-start preference.
- Snapshots assignments per workflow, refuses modifying them while a workflow is active.
- Routes configured agents through internal REQUIREMENT phases, Planning, Execution, QA, Delivery, task allowlists and child read-only controls.
- Rejects duplicate agents across distinct roles; maintains independent review roles.
- Rework Planning explicitly calls the configured Planner.
- Added config, routing and extension regressions; preserved v5.6 plan-write hotfix, QA evidence checks and manual-Git policy.

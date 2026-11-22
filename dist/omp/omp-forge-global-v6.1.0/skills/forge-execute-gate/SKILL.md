---
name: forge-execute-gate
description: Guides Forge execution of an explicitly human-approved plan and handoff to independent QA.
disable-model-invocation: true
---

# Execute gate

Begin only with recorded human approval of the current plan. Use `forge-executor` for implementation within approved task scope. Preserve task and requirement traceability; record actual changes, completed and blocked tasks, errors, dependencies, and deviations. The orchestrator runs appropriate safe checks and passes their real results to QA.

If material scope drift is necessary, stop and return to planning for a revised plan and fresh human approval. Do not claim acceptance or QA PASS from implementation or self-review. Never stage, commit, push, tag, release, or deploy as part of Forge execution.

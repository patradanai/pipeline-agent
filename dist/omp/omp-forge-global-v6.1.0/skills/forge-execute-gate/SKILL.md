---
name: forge-execute-gate
description: Guides Forge execution of an explicitly human-approved plan and handoff to independent QA.
disable-model-invocation: true
---

# Execute gate

Begin only with recorded human approval of the current plan. Implement the approved plan yourself, step by step, verifying each step before the next; track steps with todo. You may delegate independent slices to subagents, but you own integration and verification. Record changed files, checks actually run with their results, completed and blocked steps, and deviations.

If material scope drift is necessary, stop and return to planning for a revised plan and fresh approval. Do not claim acceptance or QA PASS from implementation or self-review. Never stage, commit, push, tag, release, or deploy.

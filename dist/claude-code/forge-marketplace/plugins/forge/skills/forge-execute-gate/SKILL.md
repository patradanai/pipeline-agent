---
name: forge-execute-gate
description: Guides Forge execution of an explicitly human-approved plan and handoff to independent QA.
disable-model-invocation: true
---

# Execute gate

Begin only with recorded human approval of the current plan. Implement the approved plan yourself, step by step, verifying each step before the next; track steps with todo. You may delegate independent slices to subagents, but you own integration and verification. Record changed files, checks actually run with their results, completed and blocked steps, and deviations.

On an approved QA fix plan, the earlier steps are already implemented: do only the remediation steps for the open items Forge lists, verify each with its TC and gate checks, and leave the full regression run to QA.

If material scope drift is necessary, stop and return to planning for a revised plan and fresh approval. Do not claim acceptance or QA PASS from implementation or self-review. Never stage, commit, push, tag, release, or deploy.

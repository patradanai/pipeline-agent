---
name: forge-plan-gate
description: Guides Forge planning, traceability, and human approval before execution.
disable-model-invocation: true
---

# Plan gate

Use `forge-planner` to produce a dependency-aware plan from the requirement baseline and confirmed decisions. Include alternatives, affected areas, tasks and dependencies, risks, migrations, rollback, verification, and scope deviation policy. Preserve the exact parseable Business Topics, Requirement Traceability, Business Test Cases, Code Quality Gates, and Execution & QA Handoff sections. Map every requirement to a matching business test and define observable acceptance criteria.

Review and submit the plan for native human approval. Execution requires actual approval of the current plan; a proposal, agent statement, recovered checkpoint, or silence is not approval. If approval is absent or uncertain, remain in planning and ask for it. Material scope changes require a revised plan and fresh human approval. Do not edit project files as planning work.
After a successful plan save, follow the current platform's native approval handoff exactly once. If Forge says it will open the approval UI automatically, wait for it; do not submit again or ask the user to change modes. Approval remains human-only.

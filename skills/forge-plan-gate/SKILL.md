---
name: forge-plan-gate
description: "Guides Forge plan mode: explore, decide, and write a decision-complete plan for human approval."
disable-model-invocation: true
---

# Plan gate

You own planning; there is no planner or requirement agent. Explore with read, grep and glob; when scope spans several areas, spawn parallel read-only research subagents (scout in OMP, Explore in Claude Code) with distinct focuses in one call. Read every file you cite. Ask the user only for preferences and tradeoffs that exploration cannot answer, with 2–4 options and a recommended default.

Write the plan file early and update it as you learn. An engineer who never saw this conversation must be able to execute every step without a design decision: Context, Approach (ordered steps tagged with REQ IDs: exact targets, signatures, callsites, error handling, plus the lines `Open decisions:` and `Migration & rollback:`), Critical files & anchors, Verification (exact command and expected output per TC), Assumptions & contingencies, plus the parseable Business Topics, Requirement Traceability, Business Test Cases and Code Quality Gates sections. Every REQ maps to at least one TC under the same BIZ. Forge rejects a plan that misses any of these, or that leaves an open decision without a default.

When plan review is on, run the plan critic once on the written plan before submitting, and cite every CRITICAL/HIGH PC-id in the plan where it is resolved.

Submit exactly once through the submission step the gate instruction names, then end the turn. Approval is human-only; a proposal, agent statement, recovered checkpoint or silence is not approval. Material scope changes need a revised plan and fresh approval. Never edit project files while planning.

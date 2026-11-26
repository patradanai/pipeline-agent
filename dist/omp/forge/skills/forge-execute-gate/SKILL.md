---
name: forge-execute-gate
description: Forge execute gate checklist for implementing a human-approved plan and handing off to QA.
disable-model-invocation: true
forge-audience: lead
---

# Execute gate checklist

- Work the approved steps in order; after each step run its Verification command and fix failures before moving on.
- Keep a running list of changed files and of each check with its exit status; you report both at the end.
- Need a user decision? Use the ask tool. Ending the turn with a question or a progress note does not advance Forge; only forge_execution_done starts QA.
- A blocked step: record why, continue with the independent steps, and report it as unfinished.
- Scope drift beyond the plan: stop and tell the user; a revised plan needs fresh approval.
- When every step is done or blocked, call forge_execution_done once, then end the turn. Never stage, commit, push, tag or deploy.

---
name: forge-plan-gate
description: "Forge plan gate checklist: decision-complete plans that pass the plan contract and QA."
disable-model-invocation: true
forge-audience: lead
---

# Plan gate checklist

- Ground every path, symbol and signature in a file you read this session; send parallel read-only scouts for areas you have not read.
- Ask only what the code cannot answer: 2–4 options with a recommended default. Every question must change the plan.
- Write each Verification and QG check as the exact command QA will run: one command per line or `code` span, run from the right directory (`cd dir && …` is fine), no file redirects, installs or multi-line scripts. QA may run those commands verbatim; anything else must be a standard test, lint or typecheck runner.
- Give every TC a concrete expected result (value, message, exit status); "works correctly" cannot be verified.
- Contract rows, one per line and outside code fences:
  - `- BIZ-001: <business capability>`
  - `- REQ-001 | BIZ-001 | <behavior> | <acceptance criteria>`
  - `- TC-001 | BIZ-001 | REQ-001 | <scenario> | <expected> | <command or check>`
  - `- QG-001: <tests, lint, typecheck or build gate>`
- IDs are unique; every REQ has a TC under the same BIZ; include negative and edge cases.
- On a QA rework, change only the items Forge lists and keep every passing section and ID verbatim.

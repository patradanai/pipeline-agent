---
name: forge-qa-gate
description: Forge QA gate checklist for evidence-based verification of an approved implementation.
disable-model-invocation: true
forge-audience: lead
---

# QA gate checklist

- Start with forge_qa_scope and give the reviewer exactly the changed files it lists.
- Run the plan's Verification and QG commands in this turn, one check per command, exactly as written; Forge accepts them verbatim. Output from the implementation turn is not QA evidence.
- Evidence is the command, its exit status and the decisive output line, or a file:line you read. Inspection never proves that a runtime test ran: report such a TC as NOT_RUN.
- Per TC, submit only testId, status, actual, evidence and severity; Forge fills in BIZ, REQ, scenario and expected from the plan.
- Carry every CRITICAL/HIGH reviewer finding under its CR-id, or start its evidence with "Disputed:" followed by your counter-evidence.
- If forge_qa_submit returns format errors, fix exactly those and submit again.
- On FAIL or BLOCKED, end the turn: the user decides what happens next. Never edit code during QA.

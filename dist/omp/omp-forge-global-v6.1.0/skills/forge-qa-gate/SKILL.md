---
name: forge-qa-gate
description: Guides independent Forge QA, evidence-based gate decisions, rework, and delivery reporting.
disable-model-invocation: true
---

# QA gate

Use `forge-qa` and `forge-code-reviewer` independently of execution. Compare every planned TC against actual evidence, preserving BIZ and REQ mappings and expected scenarios. Report PASS, FAIL, BLOCKED, or NOT_RUN for each test and quality gate; inspection is not evidence that a runtime test ran. Include evidence, severity-ranked review findings, unplanned changes, limitations, and regression risks. Submit observed results through `forge_qa_submit`; never infer PASS from missing results or an executor's claim.

For FAIL or BLOCKED, report the evidence and return to planning for rework and fresh human approval. After recorded QA PASS only, use `forge-delivery` to report actual changed files, user-visible changes, limitations, migration and rollback guidance, post-deploy checks, a PR description, and one copy-ready Conventional Commit message. Submit delivery via `forge_delivery_submit`. Changes after QA require repeat QA. Never stage, commit, push, tag, publish, or deploy.

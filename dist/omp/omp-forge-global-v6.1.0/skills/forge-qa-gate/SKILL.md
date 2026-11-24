---
name: forge-qa-gate
description: Guides independent Forge QA, evidence-based gate decisions, rework, and delivery reporting.
disable-model-invocation: true
---

# QA gate

You verify; the code reviewer agent reviews the diff independently and in parallel. Call forge_qa_scope first, then in one response start the reviewer (task text: plan reference, changed files, QG IDs) and run the plan's safe check commands. Compare every planned TC with observed evidence, preserving BIZ/REQ mappings and the original scenario and expected text. Report PASS, FAIL, BLOCKED or NOT_RUN per test and quality gate; inspection is not evidence that a runtime test ran. Merge the reviewer's severity-ranked findings into codeReview: every CRITICAL/HIGH CR-id stays at CRITICAL/HIGH, or its evidence starts with "Disputed:" and your counter-evidence. Submit once through forge_qa_submit; never infer PASS from missing results.

For FAIL or BLOCKED, report the evidence and return to planning for rework and fresh approval. After recorded QA PASS only, write the delivery yourself: actual changed files, user-visible changes, limitations, migration and rollback notes, and one copy-ready Conventional Commit message, submitted via forge_delivery_submit. Changes after QA require repeat QA. Never stage, commit, push, tag, publish, or deploy.

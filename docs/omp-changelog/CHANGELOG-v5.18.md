# OMP Forge v5.18 — QA Evidence Recovery

This release addresses the reported false rework loop: QA marked tests `NOT_RUN` because no diff scope was inspected, then Forge moved directly to Rework Planning even though no concrete implementation failure was found.

## Changes

- Added read-only `forge_qa_scope` tool to inspect Git HEAD, tracked modified paths and untracked paths without staging, committing, or executing project scripts. If Git is unavailable, it reports a limitation rather than inventing evidence.
- Updated QA orchestration instructions: the main agent must obtain workspace scope first, pass it to independent QA/code reviewer agents, and verify existing source/documents as needed. An empty working-tree diff is neither a PASS nor an automatic NOT_RUN.
- QA results with **observed FAIL** still return to Rework Planning and require a **fresh human Approval** before implementation.
- QA results that are **BLOCKED solely because evidence/tests cannot be verified** now enter `QA_EVIDENCE_PENDING`, retaining the previously approved plan/hash and staying read-only. Use `/forge qa` to retry validation, or `/forge rework` explicitly if implementation changes are required. Rework cycles are not spent by evidence-only QA retries.
- `/forge resume` recognizes evidence-pending checkpoints. It does not replay implementation or generate an extra approval.
- Tool guard denies all project writes and Git commits/pushes during QA and QA evidence recovery.
- Fixed `/forge rework` so an OMP-busy Plan Mode failure does not discard the approved plan before new approval is ready.
- Installer preserves current OMP `/agents` configuration, model choices, and Gate Skills.

## Compatibility / Existing sessions

**Important:** Existing v5.17 sessions that already entered `REWORK_PLANNING` after a `BLOCKED` report may have intentionally cleared their approved-plan hash. v5.18 will NOT silently reconstruct approval. For those sessions, use OMP's session tree/branch history to locate the checkpoint just before QA submission, then run `/forge qa` under the original approved branch; otherwise follow a new human approval. Do not auto-promote a prior `REWORK_PLANNING` branch into execution.

## Validation

- Run: `node --experimental-strip-types --test tests/*.test.mjs`
- Run: `bash smoke-install.sh`
- Test coverage includes missing evidence, QA retry, code FAIL/rework, workspace diff inventory, clean diff, Resume and no-auto-commit guard.

Tests validate a simulated OMP extension environment and local read-only Git, **not** end-to-end QA behavior on the user's Mac. Runtime evidence must still be verified.

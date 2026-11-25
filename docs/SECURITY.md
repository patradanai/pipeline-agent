# Security and trust model

Forge adds workflow guardrails. It is **not a sandbox**, a substitute for host permissions, or a guarantee that an agent cannot change files outside its intended scope.

## What Forge enforces

- A valid plan requires human approval before Forge's executor gate. In OMP, a user can explicitly opt in to automatic approval of later valid plans for that run only.
- Pre-approval and QA tool policies restrict known write and shell tools.
- QA and code-review specialists are configured as read-only; the executor does not receive shell access.
- Agent-issued Git publishing and common Git write commands are blocked by adapter hooks.
- QA reports require structured test evidence; unrun tests must not be marked PASS.
- QA FAIL and approved requirement steering revoke the old plan approval. OMP auto-approval does not bypass plan validation, an enabled critic, or the human decision to plan a QA fix.

## What Forge does not guarantee

- Tool guards are not OS-level isolation. Nested scripts, arbitrary commands, external tools, MCP servers, host bugs, and user actions can bypass some controls.
- Forge cannot prove that a model's report is truthful. It requires evidence fields and specialist reports, but reviewers must inspect the evidence and changed files.
- Forge does not prevent a user, another extension, or another process from changing the repository.
- The manual-Git policy is an agent guardrail, not a hard filesystem prohibition.

## Safe usage

1. Use Forge only in repositories and environments you trust.
2. Keep host-level file and command permissions enabled; do not grant broad access solely because Forge is installed.
3. Read the complete plan before approving. Reject or refine plans that exceed scope.
4. Inspect `git diff` and run your own tests before merging or publishing.
5. Treat requirement prompts, session files, reports, and checkpoints as potentially sensitive. Redact them before sharing.
6. Review custom agents, skills, MCP servers, hooks, and shell commands. These are separate trust inputs.
7. Pin and review the source revision before installing in a sensitive environment.

## Reporting a vulnerability

There is no private security contact configured in this repository yet. Until one is published, do not include secrets or sensitive data in public issue reports. Report only minimal reproduction details through the project's trusted maintainer channel.

## License status

This repository currently has no `LICENSE` file. Do not assume public source visibility grants permission to reuse, modify, or redistribute it.

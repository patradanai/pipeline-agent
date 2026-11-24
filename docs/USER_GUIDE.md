# Forge user guide

This guide describes Forge's workflow on OMP and Claude Code. Host-specific features are called out below.

## Start a workflow

Write a concrete request with desired behavior, constraints, relevant paths, and how you will verify success. For example:

```text
/forge Add CSV export to the booking service. Require admin access, preserve existing filters, and add tests for empty and large exports.
```

Forge starts in plan mode. The main agent explores the code itself (read-only research subagents may help), asks only preference questions the code cannot answer, and writes a plan with stable IDs:

- `BIZ-*`: business capabilities
- `REQ-*`: requirements and acceptance criteria
- `TC-*`: business test cases mapped to requirements
- `QG-*`: code quality gates

The plan must also contain `## Context`, `## Approach`, `## Verification` and `## Assumptions & contingencies`. `## Approach` must include an `Open decisions:` line (`none`, or one sub-bullet per decision with `default: …`; an item containing `BLOCKER` is rejected, so the agent asks you first) and a `Migration & rollback:` line (steps, or `not applicable — <reason>`). Forge rejects a proposal that misses any of these.

Inspect the plan, scope, tests, risks, and rollback notes. Approve only when you agree with the plan. Approval is explicit and cannot be supplied by an agent.

## Workflow and decisions

| Phase | Forge behavior | Your role |
|---|---|---|
| Plan | The main agent explores the repository read-only and writes an implementation and verification plan. | Answer preference questions; review the complete plan and approve or refine it. |
| Execute | The main agent implements the approved plan. | Inspect changes; add a prompt in OMP to open the steering choice if scope changes. |
| QA | The main agent runs the planned checks and verifies every test case while `forge-code-reviewer` independently reviews the diff and reports `CR-001 [HIGH] file:line — evidence — fix` lines. Every CRITICAL/HIGH CR-id must appear in the QA submission, either still CRITICAL/HIGH (the gate FAILs) or with evidence starting `Disputed:` plus counter-evidence (it stays visible in the QA report); otherwise the submission is rejected. QA cannot edit code. | Read the QA summary; on FAIL/BLOCKED decide whether to plan a fix, rerun QA, or wait. |
| Delivery | After QA PASS, Forge prepares delivery and a copy-ready commit message. | Review the diff and commit manually. |

After every QA submission, Forge shows a QA summary: a header `Forge QA ✅ PASS / ❌ FAIL / ⚠️ BLOCKED` with counts and the full report path; one row per approved test case (status ✅ ❌ ⚠️ ⏸️, test case, business topic, scenario, actual, evidence); a quality-gate table; code-review findings with severity icons (🔴 CRITICAL 🟠 HIGH 🟡 MEDIUM ⚪ LOW); and gate blockers. OMP displays it in the TUI (it is not sent to the model); in Claude Code the agent is told to print it verbatim.

A QA `FAIL` or `BLOCKED` does not start a fix on its own. Forge waits for your decision, and the footer shows `QA failed · your decision` or `QA blocked · your decision`. While it waits, Forge blocks plan writes, plan proposals and QA resubmission. A `BLOCKED` or `NOT_RUN` result is an evidence gap, not proof of a code defect.

- **OMP:** when the QA turn ends, a dialog opens. On FAIL: **Plan the fix** (draft a rework plan, then approve it), **Plan the fix with my notes** (your notes go into the rework instruction), or **Not now** (keeps the QA report and state). On BLOCKED, **Rerun QA** (you collected the missing evidence) comes first. `/forge review` shows the summary again and reopens the decision; `/forge rework` and `/forge qa` also decide.
- **Claude Code:** run `/forge-rework` to plan a fix, `/forge-qa` to rerun QA after BLOCKED, or `/forge-off`.

A QA FAIL revokes the execution approval at once; after BLOCKED, the approval is kept until you choose to plan a fix. Either way the rework plan needs a normal plan approval before any code changes, so there are two human checkpoints.

After QA PASS, if the working tree changes before delivery, use `/forge qa` to start a fresh QA round. The approved plan is retained, but the old verdict, QA snapshot, delivery artifacts, and reviewer completion no longer authorize delivery. The code reviewer must report again.

## OMP prompt steering

While an OMP Forge workflow is active, a normal interactive prompt (not a slash command) opens a confirmation dialog:

- **Steer** records the prompt as a requirement amendment and re-enters the gate that must absorb it.
- **Cancel** leaves workflow state unchanged, keeps the current work running, and returns the prompt to the editor.

| Current phase | Steer result |
|---|---|
| `PLAN` | Withdraw an unapproved proposal and revise the existing draft. |
| `EXECUTE` or `QA` | Revoke approval, stop obsolete work, and create a revised plan against the approved plan and current working tree. Approval is required again. |

Forge reports the transition as `Forge steering #N · <from> → <to> · prompt "…" from user`; every steer re-enters `PLAN`. All steering directives remain in workflow state and in later Planning and Rework instructions; older requirements are not discarded after 20 prompts. Longer histories use more context. `/forge status` shows the steering count.

The dialog is OMP-specific. The Claude Code adapter does not currently provide this prompt-steering flow. If the OMP dialog is cancelled, the prompt returns to the editor. Pasted images are not retained on cancellation; attach them again if you resend the prompt.

If the session, branch, gate, or approval changes while the steering dialog is open, Forge rejects the stale choice without applying the prompt. Submit the prompt again in the intended workflow. Late task reports and delayed compaction callbacks cannot authorize work for a replacement workflow or a new QA round.

## OMP commands

Run these in the main OMP session:

| Command | Purpose |
|---|---|
| `/forge` | Prefill `forge: ` in the prompt editor. |
| `/forge <requirement>` | Start a workflow directly. |
| `/forge status` | Show phase, approval, QA result, steering count, waiting agents, and `plan review: ON/OFF`. |
| `/forge review` | Open the plan approval dialog when a valid plan awaits review, or show the QA summary again and reopen the QA FAIL/BLOCKED decision. |
| `/forge qa` | Run or retry post-execution QA against the approved plan (for example, rerun after QA `BLOCKED`). |
| `/forge rework` | Plan a fix after QA `FAIL` or `BLOCKED`; the rework plan requires new approval. |
| `/forge report` | Show the latest QA report path. |
| `/forge delivery` | Show or prepare the delivery artifact after QA PASS. |
| `/forge resume` | Choose a saved Forge session to resume. |
| `/forge recover` | Review a detected checkpoint inconsistency. |
| `/forge agents` | Show the fixed Forge agent mapping. |
| `/forge planreview on\|off` | Turn the optional plan critic on or off (default OFF, saved in Forge config, applies to new workflows). When ON, the main agent must run `forge-plan-critic` once on the written plan and cite every CRITICAL/HIGH PC-id in the plan before Forge accepts the proposal. |
| `/forge skill` | Manage optional skills assigned to gates. |
| `/forge off` | Cancel the current Forge workflow. |

Typing `/` commands does not trigger prompt steering. See the [custom OMP skills guide](CUSTOM_SKILLS.md) for examples, creation, binding, and limits. For install-specific notes, see the [OMP quickstart](../adapters/omp/QUICKSTART_TH.md).

## Claude Code commands

Start with `/forge <requirement>`. Common commands include `/forge-status`, `/forge-plan`, `/forge-approve`, `/forge-qa`, `/forge-rework`, `/forge-delivery`, `/forge-report`, `/forge-resume`, `/forge-agents`, `/forge-planreview on|off`, and `/forge-off`. Check the [Claude Code adapter guide](../adapters/claude-code/README.md) for adapter-specific behavior and known gaps.

## Model profiles and usage

Forge's agents (`forge-code-reviewer`, and `forge-plan-critic` when plan review is ON) use the model assignments selected when the package is built; the main agent uses your session model. Profiles are `rigor` (default), `balanced`, and `economy`; they change models, not required gates. Total cost varies with model provider, context size, retries, task complexity, and whether rework is needed.

To choose a profile before building:

```bash
FORGE_MODELS=balanced npm run build
```

OMP preserves customized installed agent files. Use OMP `/agents` to adjust models. Replacing bundled agent definitions is an explicit operation and backs up old definitions.

## Data and privacy

Forge does not normally create implementation files in your project before approval. Plans, state, reports, and delivery artifacts are stored in OMP session/local data or Claude Code plugin data. Exact OMP data paths can be customized with `PI_CODING_AGENT_DIR`, `FORGE_REPORT_DIR`, and `FORGE_CHECKPOINT_DIR`; Claude Code uses its plugin data directory.

Prompts and requirements may appear in the host conversation and Forge's persisted session state. Review local session/checkpoint/report files before sharing them; they can contain private project details. Do not commit or publish these artifacts unless you have reviewed and redacted them.

## Troubleshooting

### OMP does not show Forge

Restart OMP after installing. Confirm `~/.omp/agent/extensions/forge/index.ts` exists, and use `/forge status` in a main TUI session. If using a custom data directory, inspect `$PI_CODING_AGENT_DIR/extensions/forge/index.ts` instead.

### Forge reports missing agents

Confirm `forge-code-reviewer.md` and `forge-plan-critic.md` exist under the active agent directory and are visible to OMP `/agents`. The installer preserves customized definitions and installs missing ones; it does not overwrite custom versions by default. Retired Forge agents are moved to `forge-backups/`.

### Plan approval does not start execution

Check `/forge status`, confirm the correct session/branch is active, and run `/forge recover` only if Forge offers recovery. Never assume a plan was approved because the state says `PLAN` or because a prior session approved a different plan.

### QA is BLOCKED

Read the QA summary (or the report named by `/forge report`). `BLOCKED` and `NOT_RUN` mean evidence is incomplete. Run the safe checks available in your environment, then choose **Rerun QA** in the OMP dialog or use `/forge qa` to collect a fresh independent report. Use `/forge rework` (or **Plan the fix**) only when implementation changes are needed.

### Workflow state is inconsistent after switching sessions

Return to the original OMP session with `/resume` when you need to preserve its approval. Cross-session recovery deliberately requires a new approval. Read the [checkpoint notes](../adapters/omp/QUICKSTART_TH.md#ไฟล์-checkpoint-สำรอง-ไม่ใช่-project) before moving or sharing checkpoint files.

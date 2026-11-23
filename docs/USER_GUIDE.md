# Forge user guide

This guide describes Forge's workflow on OMP and Claude Code. Host-specific features are called out below.

## Start a workflow

Write a concrete request with desired behavior, constraints, relevant paths, and how you will verify success. For example:

```text
/forge Add CSV export to the booking service. Require admin access, preserve existing filters, and add tests for empty and large exports.
```

Forge starts with a requirement analysis. The main agent reviews the specialist's report and records a requirement summary before planning. The planner then produces a plan with stable IDs:

- `BIZ-*`: business capabilities
- `REQ-*`: requirements and acceptance criteria
- `TC-*`: business test cases mapped to requirements
- `QG-*`: code quality gates

Inspect the plan, scope, tests, risks, and rollback notes. Approve only when you agree with the plan. Approval is explicit and cannot be supplied by an agent.

## Workflow and decisions

| Phase | Forge behavior | Your role |
|---|---|---|
| Requirement | One specialist analyzes the request. The main agent reviews and summarizes the findings. | Resolve genuine business questions; correct scope before planning. |
| Plan | A planner prepares an implementation and verification plan. | Review the complete plan and approve or refine it. |
| Execute | The executor implements the approved plan. | Inspect changes; add a prompt in OMP to open the steering choice if scope changes. |
| QA | Independent QA and code review examine the implementation. QA cannot edit code. | Provide missing evidence or choose rework when needed. |
| Delivery | After QA PASS, Forge prepares delivery and a copy-ready commit message. | Review the diff and commit manually. |

A QA `FAIL` returns to planning and revokes approval. A `BLOCKED` or `NOT_RUN` result is an evidence gap, not proof of a code defect; Forge retains the approved plan so you can collect evidence or explicitly choose rework. A new plan always requires a fresh approval.

After QA PASS, if the working tree changes before delivery, use `/forge qa` to start a fresh QA round. The approved plan is retained, but the old verdict, QA snapshot, delivery artifacts, and specialist completions no longer authorize delivery. Both QA specialists must report again.

## OMP prompt steering

While an OMP Forge workflow is active, a normal interactive prompt (not a slash command) opens a confirmation dialog:

- **Steer** records the prompt as a requirement amendment and re-enters the gate that must absorb it.
- **Cancel** leaves workflow state unchanged, keeps the current work running, and returns the prompt to the editor.

| Current phase | Steer result |
|---|---|
| `REQUIREMENT` | Re-run requirement analysis with the prior report available as delta context. |
| `PLAN` | Withdraw an unapproved proposal and revise the existing draft. |
| `EXECUTE` or `QA` | Revoke approval, stop obsolete work, and create a revised plan against the approved plan and current working tree. Approval is required again. |

Forge reports the transition as `Forge steering #N · <from> → <to> · prompt "…" from user`. All steering directives remain in workflow state and in later Requirement, Planning, and Rework instructions; older requirements are not discarded after 20 prompts. Longer histories use more context. `/forge status` shows the steering count.

The dialog is OMP-specific. The Claude Code adapter does not currently provide this prompt-steering flow. If the OMP dialog is cancelled, the prompt returns to the editor. Pasted images are not retained on cancellation; attach them again if you resend the prompt.

If the session, branch, gate, or approval changes while the steering dialog is open, Forge rejects the stale choice without applying the prompt. Submit the prompt again in the intended workflow. Late task reports and delayed compaction callbacks cannot authorize work for a replacement workflow or a new QA round.

## OMP commands

Run these in the main OMP session:

| Command | Purpose |
|---|---|
| `/forge` | Prefill `forge: ` in the prompt editor. |
| `/forge <requirement>` | Start a workflow directly. |
| `/forge status` | Show phase, approval, QA result, steering count, and waiting agents. |
| `/forge review` | Open the plan approval dialog when a valid plan awaits review. |
| `/forge qa` | Run or retry post-execution QA against the approved plan. |
| `/forge rework` | Start a new plan after QA `FAIL` or `BLOCKED`; requires new approval. |
| `/forge report` | Show the latest QA report path. |
| `/forge delivery` | Show or prepare the delivery artifact after QA PASS. |
| `/forge resume` | Choose a saved Forge session to resume. |
| `/forge recover` | Review a detected checkpoint inconsistency. |
| `/forge agents` | Show the fixed Forge agent mapping. |
| `/forge skill` | Manage optional skills assigned to gates. |
| `/forge off` | Cancel the current Forge workflow. |

Typing `/` commands does not trigger prompt steering. See the [custom OMP skills guide](CUSTOM_SKILLS.md) for examples, creation, binding, and limits. For install-specific notes, see the [OMP quickstart](../adapters/omp/QUICKSTART_TH.md).

## Claude Code commands

Start with `/forge <requirement>`. Common commands include `/forge-status`, `/forge-plan`, `/forge-approve`, `/forge-qa`, `/forge-rework`, `/forge-delivery`, `/forge-report`, `/forge-resume`, `/forge-agents`, and `/forge-off`. Check the [Claude Code adapter guide](../adapters/claude-code/README.md) for adapter-specific behavior and known gaps.

## Model profiles and usage

Forge's specialist agents use the model assignments selected when the package is built. Profiles are `rigor` (default), `balanced`, and `economy`; they change models, not required gates. A workflow can use multiple agent calls, and total cost varies with model provider, context size, retries, task complexity, and whether rework is needed.

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

Confirm all six `forge-*.md` definitions exist under the active agent directory and are visible to OMP `/agents`. The installer preserves customized definitions and installs missing ones; it does not overwrite custom versions by default.

### Plan approval does not start execution

Check `/forge status`, confirm the correct session/branch is active, and run `/forge recover` only if Forge offers recovery. Never assume a plan was approved because the state says `PLAN` or because a prior session approved a different plan.

### QA is BLOCKED

Read the report named by `/forge report`. `BLOCKED` and `NOT_RUN` mean evidence is incomplete. Run the safe checks available in your environment, then use `/forge qa` to collect a fresh independent report. Use `/forge rework` only when implementation changes are needed.

### Workflow state is inconsistent after switching sessions

Return to the original OMP session with `/resume` when you need to preserve its approval. Cross-session recovery deliberately requires a new approval. Read the [checkpoint notes](../adapters/omp/QUICKSTART_TH.md#ไฟล์-checkpoint-สำรอง-ไม่ใช่-project) before moving or sharing checkpoint files.

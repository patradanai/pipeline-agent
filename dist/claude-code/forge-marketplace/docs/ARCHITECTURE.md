# Forge 6.1 architecture

## Layers

```
            ┌──────────────── host ────────────────┐
 OMP  ──►   │ adapters/omp/forge/index.ts           │  OMP events, tools, TUI, sessions
            │   uses core domain + transitions      │
 Claude ──► │ adapters/claude-code/bin/forge-hook   │  hook stdin/stdout, lock, files
 Code       │   translates → core/engine.mjs        │
            └──────────────┬───────────────────────┘
                           ▼
 core/  engine.mjs (controller) → transitions.mjs → core.mjs (domain) / workspace.mjs / platform.mjs
```

* **core** never imports a host API. It sees plain objects; I/O is injected
  (`deps.savePlan`, `deps.saveQaReport`, `deps.snapshotWorkingTree`, …).
* **adapters** own: event translation, state persistence, UI/notifications,
  host-specific recovery, installation.
* `scripts/build.mjs` vendors `core/*.mjs` into each package, so each install
  is self-contained (Claude Code copies only the plugin directory; OMP loads
  only `~/.omp/agent/extensions/forge`).

## Workflow state

Persisted phases are `PLAN`, `EXECUTE`, and `QA`. Plan
review remains inside `PLAN` and requires explicit human approval before
`EXECUTE`. QA failures return to `PLAN` with approval revoked. QA PASS and
delivery remain in `QA`; completed delivery sets the workflow inactive. Legacy
`REQUIREMENT` checkpoints restore as `PLAN` without approval.

Each gate has a bundled skill. Skills guide the work; runtime guards still
enforce approval, read-only review, and evidence-backed QA. Legacy checkpoints
are normalized on restore without deriving approval or QA PASS from a phase.

## What is shared today

| Concern | Shared in core | OMP | Claude Code |
|---|---|---|---|
| Gates, the QA reviewer agent, plan-mode instructions, plan contract, QA evaluation, reports | ✔ | uses | uses |
| Approval / QA / delivery / rework / steering transitions | ✔ `transitions.mjs` | uses | uses (via engine) |
| Git-write detection, discovery/QA command allowlists | ✔ | uses | uses (via engine) |
| Read-only git snapshot and QA scope | ✔ `workspace.mjs` | uses | uses |
| Event → decision controller | ✔ `engine.mjs` | **not yet** (own controller in index.ts) | uses |
| Instruction wording | ✔ `platform.mjs` | OMP text (unchanged) | translated, tested for leaks |

Next step: move the OMP controller onto `engine.mjs` (OMP-specific pieces —
Forge's own plan approval dialog, branch recovery, TUI pickers — stay in the
adapter).

## Event mapping

| Forge event | OMP | Claude Code |
|---|---|---|
| command (human) | `/forge` command handler | `UserPromptExpansion` for `/forge` (fires only for user-typed commands; the command has `disable-model-invocation: true`) |
| tool.pre | `tool_call`, `before_subagent_spawn` | `PreToolUse` (all tools, main + subagents via `agent_id`/`agent_type`) |
| tool.post | `tool_result` | `PostToolUse` (`Agent` result = specialist report) |
| plan submitted | write `local://…-plan.md` + `forge_plan_propose` (contract check) | `PreToolUse(ExitPlanMode)`: contract check; deny with issues if invalid |
| plan approved | Forge approval dialog (`ui.select`) after the turn ends, or `/forge review`; Forge sends the execution turn | `PostToolUse(ExitPlanMode)` succeeded; `/forge approve` as human fallback |
| plan rejected | dialog Refine (editor feedback) or Not now | `PostToolUseFailure(ExitPlanMode)` |
| turn end → QA | `session_stop` | `Stop` → `decision: block` with the QA instruction |
| Forge tools | `pi.registerTool` | plugin MCP server declares schemas; hooks validate (pre) and apply (post) |
| state | OMP session custom entries (+ checkpoint mirror) | `${CLAUDE_PLUGIN_DATA}/sessions/<session_id>.json`, per-session lock |

The OMP approval dialog re-reads the plan file and approves only when its hash
still matches the proposed plan. It also refuses when the workflow changed while
the dialog was open. Approval is never inferred from a restored checkpoint.
Recovery suggestions are bound to the exact checkpoint they were generated
from, so an outdated confirmation cannot overwrite newer state.

## Claude Code adapter — known gaps (validate on your install)

* Built and tested against the documented hook schemas with simulated
  payloads, not inside a live Claude Code session. Check on first run:
  plugin agents report `agent_type` as `forge:<name>`; the subagent tool is
  `Agent` (older builds: `Task`, also handled); a successful `ExitPlanMode`
  means the user approved.
* Not ported: gate skills (`/forge skill`), `/forge resume` session picker,
  OMP branch recovery. Claude Code keeps one state file per session.
* "Approve and clear context": a new session inherits `EXECUTING` only if
  `SessionStart(source=clear)` arrives within 2 minutes in the same `cwd`;
  if approval was not observed, Forge asks for `/forge approve`.
* Before approval, unknown tools (including other MCP servers) are denied
  (fail-closed, same as OMP).
* Every tool call spawns the hook process; sessions without a Forge workflow
  exit before loading the engine.

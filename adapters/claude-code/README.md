# Forge for Claude Code (plugin)

Same Forge gates as the OMP extension, running on Claude Code hooks.

## Install (local marketplace)

```bash
cd forge-suite && npm run build
```
In Claude Code:
```text
/plugin marketplace add /absolute/path/to/forge-suite/dist/claude-code/forge-marketplace
/plugin install forge@forge-local
```
Restart Claude Code, then check `/hooks` (Forge hooks listed), `/mcp` (server `forge`), `/agents` (9 `forge:` agents).
Requires `node` 22+ on PATH.

## Use

```text
/forge Build a booking approval flow        # thorough requirement (default)
/forge --fast <requirement>                 # orchestrator intake, challenge always runs
/forge quick <requirement>                  # LOW RIGOR, trivial changes only
/forge status | plan | approve | qa | rework | delivery | report | mode [thorough|fast|quick] | agents | off
```

Each subcommand also exists as its own command for autocomplete: type `/forge` and pick
`/forge-status`, `/forge-resume`, `/forge-approve`, `/forge-plan`, `/forge-qa`, `/forge-rework`, `/forge-delivery`,
`/forge-report`, `/forge-agents`, `/forge-mode`, `/forge-quick`, `/forge-fast`, `/forge-thorough`, `/forge-off`.

Flow:
1. Requirement specialists run through the Agent tool (`forge:forge-requirement`, …). Forge advances when their reports arrive.
2. Planning: `forge:forge-planner`, then Claude enters plan mode and calls **ExitPlanMode** with the full plan.
   Forge checks the plan contract first; an invalid plan is denied with the exact issues.
3. You approve in Claude Code's native plan prompt. Forge moves to EXECUTING. (If context was cleared and Forge
   did not see the approval, type `/forge approve`.)
4. `forge:forge-executor` implements. When Claude tries to stop, Forge starts independent QA
   (`forge:forge-qa` + `forge:forge-code-reviewer`) and requires `forge_qa_submit`.
5. QA PASS → `forge:forge-delivery` → `forge_delivery_submit` → copy-ready commit message. You commit manually.

Guards (whenever a workflow exists): no agent git writes / repo publishing / `.git` writes; read-only before approval
and during QA/delivery; specialists read-only; executor has no shell; wrong agent for a gate is denied.

## Where things are stored

`${CLAUDE_PLUGIN_DATA}` (Claude Code's persistent plugin data dir):
`sessions/<session_id>.json` (state), `reports/<session>/<slug>/` (plan, QA report, delivery, commit message),
`config.json` (`requirementMode`). Nothing is written into your project by Forge.

## Models

Set in `agents/roles.json` (opus for analysis/planning/QA, sonnet for executor/delivery), then rebuild.

## Validate on first run

See "Claude Code adapter — known gaps" in `docs/ARCHITECTURE.md`. Quick check: `/forge Build a hello endpoint`,
let it run the first specialist, then `/forge status` should show `waiting agents` shrinking.

## Resume

* **Same session, everything kept (incl. approval):** Claude Code's own resume — `claude --resume <session>` /
  `claude --continue` / `/resume`. Forge state is per session id, and Forge reminds Claude of the current gate.
* **Find or adopt work from another session of this project:** `/forge-resume` lists them;
  `/forge-resume <n>` adopts one into the current session. An approval is never carried across sessions:
  approved work restarts at PLANNING and needs a fresh native approval. The source session is retired so two
  live copies never exist.

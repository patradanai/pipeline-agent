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
Restart Claude Code, then check `/hooks` (Forge hooks listed), `/mcp` (server `forge`), and `/agents` (`forge:forge-code-reviewer` and `forge:forge-plan-critic`).
Requires `node` 22+ on PATH.

### Update an existing installation

Rebuild with `npm run build`. Back up the marketplace folder you registered, then replace the entire folder with `dist/claude-code/forge-marketplace` at the same path. Do not overlay it: removed agents and commands must not survive.

```bash
claude plugin update forge@forge-local --scope user
```

Restart Claude Code to load the new hooks, MCP server and agent definitions.

## Use

```text
/forge Build a booking approval flow        # start a workflow
/forge status | plan | approve | qa | rework | delivery | report | agents | planreview on|off | off
```

Each subcommand also exists as its own command for autocomplete: type `/forge` and pick
`/forge-status`, `/forge-resume`, `/forge-approve`, `/forge-plan`, `/forge-qa`, `/forge-rework`, `/forge-delivery`,
`/forge-report`, `/forge-agents`, `/forge-planreview`, `/forge-off`.

Flow:
1. Plan: Claude enters plan mode, explores the code itself (read-only `Explore` subagents allowed), asks preferences
   with AskUserQuestion, writes the plan file, then calls **ExitPlanMode** with the full plan.
   Forge checks the plan contract first; an invalid plan is denied with the exact issues. The plan needs `## Context`,
   `## Approach`, `## Verification`, `## Assumptions & contingencies` and the BIZ/REQ/TC/QG sections; `## Approach`
   needs an `Open decisions:` line (`none`, or sub-bullets each with `default: …`; any `BLOCKER` item is denied — ask
   first) and a `Migration & rollback:` line (steps, or `not applicable — <reason>`).
   Optional plan critic: `/forge-planreview on|off` (default OFF, saved in Forge config, applies to new workflows,
   shown in `/forge status` as `plan review: ON/OFF`). When ON, Claude must run `forge:forge-plan-critic` once on the
   written plan, and ExitPlanMode is denied until it reported and every CRITICAL/HIGH PC-id is cited in the plan.
2. You approve in Claude Code's native plan prompt. Forge moves to EXECUTE. (If context was cleared and Forge
   did not see the approval, type `/forge approve`.)
3. Claude implements the approved plan itself, then calls **`forge_execution_done`** (summary, changed files, checks
   actually run, unfinished work, deviations). QA starts only when the turn ends after that call. If Claude ends a turn
   without it, Forge reminds it to finish (twice), then pauses and tells you: reply `note: <text>` to let it continue,
   or run `/forge-qa` to start QA now. In QA Claude runs the plan's checks (commands written in the approved plan's
   Verification / Test Cases / Quality Gates may run verbatim) and verifies every TC while `forge:forge-code-reviewer`
   reviews the diff (`CR-001 [HIGH] file:line — evidence — fix`), then calls `forge_qa_submit` with, per TC, only
   `testId`, `status`, `actual`, `evidence`, `severity` (Forge fills BIZ/REQ/scenario/expected from the plan). A
   submission with format errors (missing, unplanned or duplicate IDs, PASS without evidence) is not recorded and comes
   back for correction, at most twice per QA round. Every CRITICAL/HIGH CR-id must be in `codeReview.findings`, still CRITICAL/HIGH (gate
   FAILs) or with evidence starting `Disputed:` plus counter-evidence; otherwise the submission is rejected. After each
   submission Claude is told to print Forge's QA summary verbatim: `Forge QA ✅ PASS / ❌ FAIL / ⚠️ BLOCKED` with counts
   and the report path, one row per TC (✅ ❌ ⚠️ ⏸️), quality gates, review findings (🔴 🟠 🟡 ⚪) and gate blockers.
   On QA FAIL/BLOCKED Forge does not start a fix on its own; it waits for your decision (`QA failed · your decision` /
   `QA blocked · your decision`) and blocks plan writes, ExitPlanMode and QA resubmission meanwhile. Run
   `/forge-rework` to plan a fix (the rework plan still needs normal plan approval), `/forge-qa` to rerun QA after
   BLOCKED, or `/forge-off`.
4. QA PASS → Claude calls `forge_delivery_submit` → copy-ready commit message. You commit manually.

Prompts while an approved plan runs (EXECUTE or QA): start the prompt with
* `steer: <text>` to change the requirement — Forge re-plans and revokes the approval (the revised plan needs your
  approval again);
* `note: <text>` (or `reply: <text>`) to send a clarification or answer — the approval and approved scope stay;
* anything else is blocked with this explanation. Slash commands (`/forge-off`, `/forge-qa`, …) always work.

Gate skills (`forge-plan-gate`, `forge-execute-gate`, `forge-qa-gate`) are inlined into each gate instruction; Claude
cannot invoke them by name.

Guards (whenever a workflow exists): no agent git writes / repo publishing / `.git` writes; read-only before approval
and during QA/delivery; `forge-code-reviewer` read-only and allowed only in QA; `forge-plan-critic` read-only.

## Where things are stored

`${CLAUDE_PLUGIN_DATA}` (Claude Code's persistent plugin data dir):
`sessions/<session_id>.json` (state), `reports/<session>/<slug>/` (plan, QA report, delivery, commit message),
`config.json` (`trace`, `planReview`). Nothing is written into your project by Forge. If the session state file is
not valid JSON, Forge fails closed: every non-read-only tool is denied with the file path until you run `/forge-off`
(or fix/delete the file).

## Models

Set in `agents/roles.json` (`forge-code-reviewer`: `rigor` sonnet, `balanced` opus, `economy` sonnet; `forge-plan-critic`: `rigor` opus, `balanced` opus, `economy` sonnet), then rebuild. Pick another profile with `FORGE_MODELS=balanced|economy`.

## Validate on first run

See "Claude Code adapter — known gaps" in `docs/ARCHITECTURE.md`. Quick check: `/forge Build a hello endpoint`,
let it reach QA, then `/forge status` should show `waiting agents` shrinking after the reviewer reports.

## Resume

* **Same session, everything kept (incl. approval):** Claude Code's own resume — `claude --resume <session>` /
  `claude --continue` / `/resume`. Forge state is per session id, and Forge reminds Claude of the current gate.
* **Find or adopt work from another session of this project:** `/forge-resume` lists them;
  `/forge-resume <n>` adopts one into the current session. An approval is never carried across sessions:
  approved work restarts at PLANNING and needs a fresh native approval. The source session is retired so two
  live copies never exist.

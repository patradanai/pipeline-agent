# Forge v6.1.0 — Single-Pass Requirement Gate

The Requirement gate was the slowest part of a run: four specialists in three
sequential rounds (7 agent runs), each re-reading the workspace, plus an
orchestrator synthesis between rounds. v6.1 runs ONE agent once and keeps the
checks that made the old gate rigorous.

## Changed

- Gate 1 is one `forge-requirement` run. Its prompt merges the analyst, critic,
  architect and QA-strategist duties plus the former challenge round. The report
  covers six lenses (intake, gaps, critique, architecture, QA strategy,
  self-challenge) with CRITICAL/HIGH/MEDIUM/LOW and fact/assumption labels, a
  decision register and BIZ/REQ/TC/QG candidates.
- The gate instruction makes the orchestrator pass the six-lens checklist in the
  task text, so coverage holds even with an older or customized
  `forge-requirement.md`.
- After the report the orchestrator reviews it as an independent second reader
  (missed findings are added with source `orchestrator`) and calls
  `forge_requirement_summary` once → PLANNING. Forge still rejects a summary that
  drops the report's CRITICAL/HIGH labels. The summary is stored in state and
  embedded in the Planning instruction.
- `forge-requirement` stays on opus in the `balanced` model profile: it now
  carries the critic role.
- Plan section renamed 'Cooking & Gap Analysis' → 'Requirement & Gap Analysis'.

## Removed

- Requirement modes thorough/fast/quick, internal steps
  DISCOVERY/COOKING/CHALLENGE, challenge escalation and the summary `escalate`
  field.
- Commands `/forge mode` and `/forge quick|thorough|--fast <req>` (OMP), and
  `/forge-mode`, `/forge-quick`, `/forge-fast`, `/forge-thorough` (Claude Code).
  Typed anyway, the words become part of a normal requirement.
- Agents `forge-critic`, `forge-architect`, `forge-qa-strategist`. OMP
  `install.sh` moves installed copies (and `*.disabled.*` copies) into
  `forge-backups/`.

## Trade-off

- The critic is no longer a separate, independent agent. A mandatory
  self-challenge pass plus the orchestrator's second read replace it.

## Upgrade notes

- A Requirement gate in flight from v6.0 reruns `forge-requirement` once (old
  step progress is ignored); a new summary replaces an old one. v5
  DISCOVERY/COOKING/CHALLENGE phases still resume as REQUIREMENT.
- OMP keeps an existing `forge-requirement.md`. `install.sh` prints a NOTE when
  it differs from the bundled prompt; replace it with
  `FORGE_REINSTALL_AGENTS=1 bash install.sh` (backups kept).
- Claude Code live coverage report: checks are now C01–C19. E2E scenarios S3/S4
  (fast/quick) were removed and S5–S8 renumbered S3–S6.

## Tests

core 25/26, examples 9/9, OMP 214/214 + smoke install/uninstall/reinstall
PASS, Claude Code plugin 20/20. The failing core test ("planning and rework tell
Claude Code to use ExitPlanMode") comes from the v6.0.7 rework-path change: the
Claude Code rework wording rule in `core/platform.mjs` no longer matches the new
rework instruction.

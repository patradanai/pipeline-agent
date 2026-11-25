# Forge v6.1.0 — Single-Pass Requirement Gate

The Requirement gate was the slowest part of a run: four specialists in three
sequential rounds (7 agent runs), each re-reading the workspace, plus an
orchestrator synthesis between rounds. v6.1 runs ONE agent once and keeps the
checks that made the old gate rigorous.

## Changed

- Workflow safety fixes: QA and delivery now allow only known read-only tools,
  conservative test commands, and their phase-specific control tools. Unknown
  tools, including eval, AST/LSP mutations, and MCP writes, are denied.
- Pending specialist reports are bound to the session, workflow, approved hash,
  and gate generation. Cancel, restore, steering, and QA retry invalidate old work.
- Steering confirmations and delayed compact-execution callbacks validate their
  original gate snapshot; stale callbacks cannot dispatch a cancelled plan into
  a replacement workflow.
- `/forge qa` can reopen a PASS review after working-tree changes. It preserves
  plan approval but clears prior QA/delivery authorization and requires fresh
  specialist reports.
- Rework preserves the approved plan hash/path as a pair. Re-entering an existing
  PLAN proposal never promotes its unapproved hash to the approved base.
- Steering retains every directive instead of discarding requirements after 20
  prompts; resumed instructions retain earlier constraints.
- OMP: a prompt the user types while a workflow runs opens a steering popup:
  `Steer · <from> → <to>` or `Cancel · keep working on <gate>`. Cancel changes
  nothing and returns the prompt to the editor. Steer records it in state
  (`requirementSteering`, `steeringRevision`), aborts the running turn whose
  remaining work is obsolete, reports
  `Forge steering #N · <from> → <to> · prompt "…" from user`, and re-enters
  the gate that absorbs it: REQUIREMENT re-runs analysis, PLAN withdraws the
  proposal, EXECUTE/QA revoke approval and plan a rework
  (`reworkReason: STEERING`). Re-runs are delta runs against the earlier
  report, draft or approved plan. Every Requirement, Planning and Rework
  instruction carries all steering prompts, and the prompt is sent once. A
  prompt during QA no longer ends in a fabricated QA BLOCKED report, and a
  still-running executor loses write access once approval is revoked.
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
- OMP runs Forge's own plan mode instead of native OMP Plan Mode. The PLAN gate
  stays read-only except for one session-local plan file
  (`local://<slug>-plan.md`, or `local://<slug>-rework-<n>-plan.md` after QA
  FAIL). The model submits it with the new `forge_plan_propose` tool, which
  checks the plan contract. When the turn ends, Forge shows the plan in the
  transcript and opens its own approval dialog: **Approve and keep context**,
  **Approve and compact context**, **Refine plan**, or **Not now**. `/forge
  review` reopens it. Forge exits native OMP Plan Mode when Forge starts and
  again on approval, then sends the execution turn itself.
- OMP: when a rework starts (QA fix decision, `/forge rework`, steering that
  revokes an approved plan, or `/forge resume` of a rework PLAN), Forge copies
  the previous approved plan to `local://<slug>-rework-<n>-plan.md` once,
  never overwriting an existing file. The rework instruction then tells the
  agent to revise that copy with small `edit` calls instead of re-typing the
  whole plan with `write`. State tracks the copy in `reworkPlanSeededPath`;
  without a copy, the instruction is unchanged.
- Removed for OMP: `xd://propose` and `propose <slug>` handling,
  `plan_review_requested`/`plan_review_resolved`, approval handoff across
  branch/new-session switches, and the native Plan Mode recovery prompt.
  Approval now always happens in the current session.
- Bare `/forge` (OMP) no longer opens the text-only multiline dialog, which
  dropped pasted images. It prefills the main prompt with `forge: `; write the
  requirement there (Shift+Enter for new lines, Ctrl+V to paste images) and
  press Enter. The explicit `forge:` prefix now starts Forge even with images
  attached (implicit auto-start still skips messages with images). Pasted images
  are saved to `~/.omp/agent/forge-attachments/<slug>/image-<n>.<ext>` and their
  paths are appended to the requirement, so `forge-requirement` and later gates
  can open them with the read tool.
- Default model profile `rigor` is now: requirement and planner on opus, QA
  and code reviewer on sonnet, executor and delivery on haiku. `balanced` and
  `economy` are unchanged.
- OMP now gets the profile too: the build writes a default `model:` into each
  bundled `forge-*.md` (exact Anthropic id first, bare alias as fallback, e.g.
  `anthropic/claude-haiku-5-5, haiku`). OMP `/agents` can still change it.
  `install.sh` keeps agent files that are already installed; run
  `FORGE_REINSTALL_AGENTS=1 bash install.sh` to take the new defaults (old files
  are backed up).
- Fix: `forge: <requirement>` typed in the prompt never started Forge. OMP
  reports native Plan Mode as `{ status: 'inactive' }`, but Forge compared the
  whole object to `'inactive'`, so the input hook always bailed and the prompt
  went to the main model unchanged (no gates, no `forge-*` agents, so no
  per-agent model switch). Forge now reads `plan.status`.
- Keep the four-segment progress meter in OMP's persistent footer status,
  e.g. `FORGE ▰▱▱▱ Requirement 1/4`, instead of stripping its glyphs.
- OMP: per-gate main-session model. Forge switches the main session model when
  a gate starts (planning `@plan`, execution/QA/delivery `@default` by
  default) and keeps the thinking level. `/forge model`, `/forge model <gate>
  <@role|provider/id|keep>`, `/forge model reset`; saved as `gateModels` in
  the Forge config. A manual `/model` pick inside a gate is kept. See
  [Gate models (OMP)](../USER_GUIDE.md#gate-models-omp).
- Claude Code: fix hook output over ~8 KB arriving as invalid JSON on macOS.
  The hook exited before stdout to a pipe was flushed; it now waits for the
  write to finish.
- Workflow review fixes (both adapters unless noted):
  - QA command policy: QA runs the commands written in the approved plan's
    Verification, TC and QG lines verbatim, read-only inspection (including
    `git -C <dir>`), and test/lint/typecheck runners with arguments; steps may
    be chained and piped into read-only filters. `npm run build` is no longer
    allowed unless the plan names it. Redirects, installs, substitutions,
    multi-line scripts and mutating flags stay refused.
  - QA submissions report each TC by ID; Forge fills BIZ, REQ, scenario and
    expected from the plan. Format errors (missing, unplanned or duplicate IDs,
    PASS without evidence) are returned for correction up to twice per round
    instead of being recorded as BLOCKED. Summaries count test cases, quality
    gates and the code review separately.
  - Execution ends with the new `forge_execution_done` tool. A turn that ends
    without it gets two reminders, then pauses for the user; QA never starts on
    a question or a progress note. OMP: the steering dialog adds **Reply**
    (approval kept) and `/forge resume current` continues an interrupted
    execution. Claude Code: `steer:` / `note:` prompts while an approved plan
    runs; other prompts are blocked with a hint.
  - Gate skills: verified skill text is inlined into gate instructions (Claude
    Code could not load `disable-model-invocation` skills by name). New
    `forge-audience: lead|specialist|all` frontmatter; the bundled gate skills
    are `lead` and no longer reach `forge-code-reviewer` or
    `forge-plan-critic`. Bundled skills rewritten as short checklists;
    `install.sh` upgrades older bundled copies (backup kept).
  - Git guard also blocks `git clean`, `git restore`, `git rm`, `git mv` and
    `hub` git commands.
  - Plan contract ignores headings and rows inside code fences and rejects
    duplicate BIZ/REQ/QG IDs.
  - OMP: a gate-model switch that outlives its gate (cancel, steering) no
    longer dispatches the old gate's turn; orphaned-workflow recovery pauses
    subagent writes and Git commands too.
  - Claude Code: the state lock is never taken from a live owner; corrupt
    session state fails closed; only Forge's own MCP server tools are
    recognized.
  - `@` alone is rejected as a gate model; commit subjects reject control
    characters.
- Claude Code: the plan always lives in a file, as in OMP. Forge reads the plan
  only from the plan-mode plan file (a plan passed as text alone is denied) and
  keeps its own copy at `<Forge data>/plans/<slug>-plan.md`
  (`<slug>-rework-<n>-plan.md` for a QA rework), refreshed on every plan write.
  The approved text comes from ExitPlanMode's result. Native approval is
  unchanged.

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

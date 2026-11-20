# Forge Suite 6.0 — shared core + adapters

Forge is a gated multi-agent SDLC orchestrator:

`REQUIREMENT → PLANNING → native human plan approval → EXECUTING → independent QA → DELIVERY`

Nine named specialists, a parseable plan contract (BIZ/REQ/TC/QG), evidence-based
QA, and **no agent-run git writes** — on two hosts:

| Adapter | Host | Package after build |
|---|---|---|
| `adapters/omp` | Oh My Pi (OMP) extension | `dist/omp/omp-forge-global-v6.0.0/` |
| `adapters/claude-code` | Claude Code plugin (hooks + agents + command + MCP tools) | `dist/claude-code/forge-marketplace/` |

```
core/                     platform-neutral Forge (pure logic + read-only git inspection)
  core.mjs                gates, agents, requirement modes, plan contract, QA evaluation,
                          reports, command parsing, git-write detection, instructions
  transitions.mjs         shared state transitions (approval, QA, delivery, rework, summary)
  state-recovery.mjs      safety checks for inconsistent state
  checkpoint-recovery.mjs session checkpoint mirror (used by OMP)
  forge-state.mjs         state identity / resumability
  workspace.mjs           read-only git snapshot + QA scope
  platform.mjs            instruction wording per host (OMP text → Claude Code text)
  engine.mjs              event-driven controller: normalized events → decisions
agents/                   canonical prompts for the 9 specialists (+ roles.json models)
adapters/omp/             OMP extension (index.ts), session discovery, installer, tests
adapters/claude-code/     plugin template (hooks.json, forge-hook.mjs, forge-mcp.mjs, /forge)
scripts/build.mjs         vendors core + renders agents into self-contained packages
core-tests/               engine + platform tests
```

## Build and test

```bash
npm test        # build → core tests → OMP tests + installer smoke → Claude Code plugin e2e
```

Node 22+. No npm dependencies.

## Install

**OMP**
```bash
cd dist/omp/omp-forge-global-v6.0.0 && bash ./install.sh   # restart OMP
```

**Claude Code** — see [adapters/claude-code/README.md](../adapters/claude-code/README.md)
```text
/plugin marketplace add /absolute/path/to/dist/claude-code/forge-marketplace
/plugin install forge@forge-local
```

Live end-to-end test in Claude Code (trace + coverage report): [docs/E2E-TEST-PLAN_TH.md](E2E-TEST-PLAN_TH.md).

Architecture, event mapping and known gaps: [docs/ARCHITECTURE.md](ARCHITECTURE.md).

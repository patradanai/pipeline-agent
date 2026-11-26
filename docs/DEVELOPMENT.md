# Forge Suite 6.1 — shared core + adapters

Forge is a gated SDLC orchestrator:

`PLAN (main agent, read-only plan mode) → human plan approval → EXECUTE (main agent) → QA (main agent + forge-code-reviewer) → DELIVERY`

One named specialist (`forge-code-reviewer`, QA only), a parseable plan contract (BIZ/REQ/TC/QG), evidence-based
QA, and **no agent-run git writes** — on two hosts:

| Adapter | Host | Package after build |
|---|---|---|
| `adapters/omp` | Oh My Pi (OMP) extension | `dist/omp/omp-forge-global-v6.1.0/` |
| `adapters/claude-code` | Claude Code plugin (hooks + agents + command + MCP tools) | `dist/claude-code/forge-marketplace/` |

```
core/                     platform-neutral Forge (pure logic + read-only git inspection)
  core.mjs                gates, agents, requirement gate, plan contract, QA evaluation,
                          reports, command parsing, git-write detection, instructions
  transitions.mjs         shared state transitions (approval, QA, delivery, rework, summary)
  state-recovery.mjs      safety checks for inconsistent state
  checkpoint-recovery.mjs session checkpoint mirror (used by OMP)
  forge-state.mjs         state identity / resumability
  workspace.mjs           read-only git snapshot + QA scope
  platform.mjs            instruction wording per host (OMP text → Claude Code text)
  engine.mjs              event-driven controller: normalized events → decisions
agents/                   canonical prompt for forge-code-reviewer (+ roles.json models)
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
omp plugin link ./dist/omp/forge          # dev: symlink the build output; restart OMP after each build
omp plugin marketplace add "$PWD" && omp plugin install forge@omp-forge   # as users install it
```
Legacy: `cd dist/omp/omp-forge-global-v6.1.0 && bash ./install.sh`. Commit `dist/` and `.omp-plugin/marketplace.json` after a release build: Git marketplace installs read them from the repository.

**Claude Code** — see [adapters/claude-code/README.md](../adapters/claude-code/README.md)
```text
/plugin marketplace add /absolute/path/to/dist/claude-code/forge-marketplace
/plugin install forge@forge-local
```

Live end-to-end test in Claude Code (trace + coverage report): [docs/E2E-TEST-PLAN_TH.md](E2E-TEST-PLAN_TH.md).

Architecture, event mapping and known gaps: [docs/ARCHITECTURE.md](ARCHITECTURE.md).

#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT
mkdir -p "$TEST_ROOT/extensions/forge" "$TEST_ROOT/agents"
printf '{"autoStart":true,"agentAssignments":{"planning":{"planner":"custom-planner"}},"gateSkills":{"qa":["go-testing"]}}\n' > "$TEST_ROOT/extensions/forge/config.json"
printf 'PREVIOUS EXTENSION\n' > "$TEST_ROOT/extensions/forge/index.ts"
printf 'PREVIOUS AGENT\n' > "$TEST_ROOT/agents/forge-requirement.md"
# v6.1: agents merged into forge-requirement are parked in the backup, not left active.
printf 'RETIRED CRITIC\n' > "$TEST_ROOT/agents/forge-critic.md"
printf 'RETIRED ARCHITECT\n' > "$TEST_ROOT/agents/forge-architect.md.disabled.20250101-000000-1"
PI_CODING_AGENT_DIR="$TEST_ROOT" bash "$ROOT/install.sh" >/dev/null
[[ -f "$TEST_ROOT/extensions/forge/core.mjs" ]]
[[ -f "$TEST_ROOT/extensions/forge/session-resume.mjs" ]]
[[ -f "$TEST_ROOT/extensions/forge/checkpoint-recovery.mjs" ]]
for f in forge-state.mjs workspace.mjs transitions.mjs platform.mjs engine.mjs; do [[ -f "$TEST_ROOT/extensions/forge/$f" ]]; done
[[ -f "$TEST_ROOT/extensions/forge/state-recovery.mjs" ]]
[[ -f "$TEST_ROOT/extensions/forge/index.ts" ]]
[[ "$(find "$TEST_ROOT/agents" -name 'forge-*.md' | wc -l | tr -d ' ')" -eq 6 ]]
# Freshly installed agents carry the build profile's default model; OMP /agents can still change it.
grep -q '^model: ' "$TEST_ROOT/agents/forge-executor.md"
[[ ! -e "$TEST_ROOT/agents/forge-critic.md" && -z "$(find "$TEST_ROOT/agents" -name 'forge-architect.md*')" ]]
grep -R -q 'RETIRED CRITIC' "$TEST_ROOT/forge-backups"
grep -R -q 'RETIRED ARCHITECT' "$TEST_ROOT/forge-backups"
grep -q '"autoStart":true' "$TEST_ROOT/extensions/forge/config.json"
grep -q '"custom-planner"' "$TEST_ROOT/extensions/forge/config.json"
grep -q '"go-testing"' "$TEST_ROOT/extensions/forge/config.json"
# v5.12 must not overwrite a user's /agents configuration or prompt edits.
grep -q 'PREVIOUS AGENT' "$TEST_ROOT/agents/forge-requirement.md"
# Deprecated overrides remain stored but are ignored for new Forge runs.
# Reinstalling the extension should not alter preserved Agent files either.
PI_CODING_AGENT_DIR="$TEST_ROOT" bash "$ROOT/install.sh" >/dev/null
grep -q 'PREVIOUS AGENT' "$TEST_ROOT/agents/forge-requirement.md"
grep -R -q 'PREVIOUS EXTENSION' "$TEST_ROOT/forge-backups"
PI_CODING_AGENT_DIR="$TEST_ROOT" bash "$ROOT/uninstall.sh" >/dev/null
[[ ! -d "$TEST_ROOT/extensions/forge" ]]
[[ -f "$(find "$TEST_ROOT/forge-disabled" -name index.ts | head -n1)" ]]
# v5.23: uninstall -> reinstall restores the user's customized agent, not the bundled default.
[[ ! -f "$TEST_ROOT/agents/forge-requirement.md" ]]
PI_CODING_AGENT_DIR="$TEST_ROOT" bash "$ROOT/install.sh" >/dev/null
grep -q 'PREVIOUS AGENT' "$TEST_ROOT/agents/forge-requirement.md"
[[ "$(find "$TEST_ROOT/agents" -name 'forge-*.md' | wc -l | tr -d ' ')" -eq 6 ]]
[[ -z "$(find "$TEST_ROOT/agents" -name 'forge-*.disabled.*')" ]]
printf 'SMOKE INSTALL/UNINSTALL/REINSTALL: PASS (6 bundled agents, retired agents parked, user OMP agents restored, skills preserved, backup saved)\n'

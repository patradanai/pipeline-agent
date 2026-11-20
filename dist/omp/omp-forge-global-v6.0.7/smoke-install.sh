#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT
mkdir -p "$TEST_ROOT/extensions/forge" "$TEST_ROOT/agents"
printf '{"autoStart":true,"agentAssignments":{"planning":{"planner":"custom-planner"}},"gateSkills":{"qa":["go-testing"]}}\n' > "$TEST_ROOT/extensions/forge/config.json"
printf 'PREVIOUS EXTENSION\n' > "$TEST_ROOT/extensions/forge/index.ts"
printf 'PREVIOUS AGENT\n' > "$TEST_ROOT/agents/forge-requirement.md"
PI_CODING_AGENT_DIR="$TEST_ROOT" bash "$ROOT/install.sh" >/dev/null
[[ -f "$TEST_ROOT/extensions/forge/core.mjs" ]]
[[ -f "$TEST_ROOT/extensions/forge/session-resume.mjs" ]]
[[ -f "$TEST_ROOT/extensions/forge/checkpoint-recovery.mjs" ]]
for f in forge-state.mjs workspace.mjs transitions.mjs platform.mjs engine.mjs; do [[ -f "$TEST_ROOT/extensions/forge/$f" ]]; done
[[ -f "$TEST_ROOT/extensions/forge/state-recovery.mjs" ]]
[[ -f "$TEST_ROOT/extensions/forge/index.ts" ]]
[[ "$(find "$TEST_ROOT/agents" -name 'forge-*.md' | wc -l | tr -d ' ')" -eq 9 ]]
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
[[ "$(find "$TEST_ROOT/agents" -name 'forge-*.md' | wc -l | tr -d ' ')" -eq 9 ]]
[[ -z "$(find "$TEST_ROOT/agents" -name 'forge-*.disabled.*')" ]]
printf 'SMOKE INSTALL/UNINSTALL/REINSTALL: PASS (9 bundled agents, user OMP agents restored, skills preserved, backup saved)\n'

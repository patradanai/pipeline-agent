#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT
# Every assertion goes through check: a failing [[ ]] does not stop every bash build under set -e.
check() {
  if ! "$@"; then printf 'SMOKE FAIL (line %s): %s\n' "${BASH_LINENO[0]}" "$*" >&2; exit 1; fi
}
count_agents() { find "$TEST_ROOT/agents" -name 'forge-*.md' | wc -l | tr -d ' '; }
mkdir -p "$TEST_ROOT/extensions/forge" "$TEST_ROOT/agents" "$TEST_ROOT/skills/forge-plan-gate" "$TEST_ROOT/skills/forge-requirement-gate"
printf '{"autoStart":true,"agentAssignments":{"planning":{"planner":"custom-planner"}},"gateSkills":{"qa":["go-testing"]}}\n' > "$TEST_ROOT/extensions/forge/config.json"
printf 'PREVIOUS EXTENSION\n' > "$TEST_ROOT/extensions/forge/index.ts"
# v6.2: agents the main agent replaced, and gate skills that still route work to them, are parked in the backup.
printf 'OLD PLANNER\n' > "$TEST_ROOT/agents/forge-planner.md"
printf -- '---\nname: forge-plan-gate\ndescription: old\n---\nUse forge-planner\n' > "$TEST_ROOT/skills/forge-plan-gate/SKILL.md"
printf -- '---\nname: forge-requirement-gate\ndescription: old\n---\nOLD REQ GATE\n' > "$TEST_ROOT/skills/forge-requirement-gate/SKILL.md"
# v6.1: agents merged into forge-requirement are parked in the backup, not left active.
printf 'RETIRED CRITIC\n' > "$TEST_ROOT/agents/forge-critic.md"
printf 'RETIRED ARCHITECT\n' > "$TEST_ROOT/agents/forge-architect.md.disabled.20250101-000000-1"
PI_CODING_AGENT_DIR="$TEST_ROOT" bash "$ROOT/install.sh" >/dev/null
for f in index.ts core.mjs session-resume.mjs checkpoint-recovery.mjs state-recovery.mjs forge-state.mjs workspace.mjs transitions.mjs platform.mjs engine.mjs; do
  check test -f "$TEST_ROOT/extensions/forge/$f"
done
check test "$(count_agents)" -eq 2
# Freshly installed agents carry the build profile's default model; OMP /agents can still change it.
check grep -q '^model: ' "$TEST_ROOT/agents/forge-code-reviewer.md"
check grep -q '^model: ' "$TEST_ROOT/agents/forge-plan-critic.md"
check test ! -e "$TEST_ROOT/agents/forge-planner.md"
check grep -R -q 'OLD PLANNER' "$TEST_ROOT/forge-backups"
check test -f "$TEST_ROOT/skills/forge-plan-gate/SKILL.md"
check test -z "$(grep -l 'forge-planner' "$TEST_ROOT/skills/forge-plan-gate/SKILL.md" || true)"
check grep -R -q 'Use forge-planner' "$TEST_ROOT/forge-backups"
check test ! -e "$TEST_ROOT/skills/forge-requirement-gate"
check grep -R -q 'OLD REQ GATE' "$TEST_ROOT/forge-backups"
check test ! -e "$TEST_ROOT/agents/forge-critic.md"
check test -z "$(find "$TEST_ROOT/agents" -name 'forge-architect.md*')"
check grep -R -q 'RETIRED CRITIC' "$TEST_ROOT/forge-backups"
check grep -R -q 'RETIRED ARCHITECT' "$TEST_ROOT/forge-backups"
check grep -q '"autoStart":true' "$TEST_ROOT/extensions/forge/config.json"
check grep -q '"custom-planner"' "$TEST_ROOT/extensions/forge/config.json"
check grep -q '"go-testing"' "$TEST_ROOT/extensions/forge/config.json"
# Install must not overwrite a user's /agents configuration or prompt edits.
printf 'PREVIOUS AGENT\n' > "$TEST_ROOT/agents/forge-code-reviewer.md"
PI_CODING_AGENT_DIR="$TEST_ROOT" bash "$ROOT/install.sh" >/dev/null
check grep -q 'PREVIOUS AGENT' "$TEST_ROOT/agents/forge-code-reviewer.md"
check grep -R -q 'PREVIOUS EXTENSION' "$TEST_ROOT/forge-backups"
PI_CODING_AGENT_DIR="$TEST_ROOT" bash "$ROOT/uninstall.sh" >/dev/null
check test ! -d "$TEST_ROOT/extensions/forge"
check test -f "$(find "$TEST_ROOT/forge-disabled" -name index.ts | head -n1)"
# uninstall -> reinstall restores the user's customized agent, not the bundled default.
check test "$(count_agents)" -eq 0
PI_CODING_AGENT_DIR="$TEST_ROOT" bash "$ROOT/install.sh" >/dev/null
check grep -q 'PREVIOUS AGENT' "$TEST_ROOT/agents/forge-code-reviewer.md"
check test "$(count_agents)" -eq 2
check test -z "$(find "$TEST_ROOT/agents" -name 'forge-*.disabled.*')"
printf 'SMOKE INSTALL/UNINSTALL/REINSTALL: PASS (2 bundled agents, retired agents and agent-based gate skills parked, user OMP agents restored, backup saved)\n'

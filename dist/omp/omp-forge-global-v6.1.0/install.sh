#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_ROOT="$ROOT"
DIST_ROOT="$ROOT/../../dist/omp/omp-forge-global-v6.1.0"
FORGE_FILES=(index.ts session-resume.mjs core.mjs forge-state.mjs state-recovery.mjs checkpoint-recovery.mjs workspace.mjs transitions.mjs platform.mjs engine.mjs)
if [[ ! -f "$SOURCE_ROOT/forge/core.mjs" && -f "$DIST_ROOT/forge/core.mjs" ]]; then
  SOURCE_ROOT="$DIST_ROOT"
fi
AGENT_ROOT="${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}"
EXT="$AGENT_ROOT/extensions/forge"
AGENTS="$AGENT_ROOT/agents"
SKILLS="$AGENT_ROOT/skills"
GATE_SKILLS=(forge-plan-gate forge-execute-gate forge-qa-gate)
BACKUP_DIR="$AGENT_ROOT/forge-backups/$(date +%Y%m%d-%H%M%S)-$$"
for path in "${FORGE_FILES[@]/#/$SOURCE_ROOT/forge/}" "$SOURCE_ROOT/forge/config.json"; do
  [[ -f "$path" ]] || { printf 'Missing required file: %s\n' "$path" >&2; exit 1; }
done
for agent in forge-code-reviewer forge-plan-critic; do
  [[ -f "$SOURCE_ROOT/agents/$agent.md" ]] || { printf 'Missing agent: %s\n' "$SOURCE_ROOT/agents/$agent.md" >&2; exit 1; }
done
for skill in "${GATE_SKILLS[@]}"; do
  [[ -f "$SOURCE_ROOT/skills/$skill/SKILL.md" ]] || { printf 'Missing gate skill: %s\n' "$SOURCE_ROOT/skills/$skill/SKILL.md" >&2; exit 1; }
done
mkdir -p "$EXT" "$AGENTS" "$BACKUP_DIR"
for filename in "${FORGE_FILES[@]}"; do
  if [[ -f "$EXT/$filename" ]]; then cp -p "$EXT/$filename" "$BACKUP_DIR/$filename"; fi
  cp "$SOURCE_ROOT/forge/$filename" "$EXT/$filename"
done
if [[ ! -f "$EXT/config.json" ]]; then cp "$SOURCE_ROOT/forge/config.json" "$EXT/config.json"; fi
mkdir -p "$SKILLS"
skills_installed=0
skills_replaced=0
skills_preserved=0
skills_retired=0
for skill in "${GATE_SKILLS[@]}"; do
  if [[ -e "$SKILLS/$skill" || -L "$SKILLS/$skill" ]]; then
    # A pre-v6.2 bundled copy still routes work to retired agents: park it and install the new text.
    if [[ -f "$SKILLS/$skill/SKILL.md" ]] && grep -Eq 'forge-(requirement|planner|executor|delivery)|`forge-qa`' "$SKILLS/$skill/SKILL.md"; then
      mkdir -p "$BACKUP_DIR/skills" && mv "$SKILLS/$skill" "$BACKUP_DIR/skills/$skill"
      cp -R "$SOURCE_ROOT/skills/$skill" "$SKILLS/$skill"
      skills_replaced=$((skills_replaced+1))
    else
      skills_preserved=$((skills_preserved+1))
    fi
  else
    cp -R "$SOURCE_ROOT/skills/$skill" "$SKILLS/$skill"
    skills_installed=$((skills_installed+1))
  fi
done
# The requirement gate was removed in v6.2: park its skill so it is not listed as a Forge gate.
if [[ -e "$SKILLS/forge-requirement-gate" || -L "$SKILLS/forge-requirement-gate" ]]; then
  mkdir -p "$BACKUP_DIR/skills" && mv "$SKILLS/forge-requirement-gate" "$BACKUP_DIR/skills/forge-requirement-gate"
  skills_retired=$((skills_retired+1))
fi
installed=0
preserved=0
restored=0
shopt -s nullglob
for file in "$SOURCE_ROOT"/agents/forge-*.md; do
  filename="$(basename "$file")"
  # Native OMP /agents is the source of truth for user-selected models and prompts.
  # Do NOT replace an existing Agent definition during routine extension upgrades.
  if [[ -f "$AGENTS/$filename" ]]; then
    if [[ "${FORGE_REINSTALL_AGENTS:-0}" == "1" ]]; then
      cp -p "$AGENTS/$filename" "$BACKUP_DIR/$filename"
      cp "$file" "$AGENTS/$filename"
      installed=$((installed+1))
    else
      preserved=$((preserved+1))
    fi
  else
    # uninstall.sh parks agents as <name>.disabled.<YYYYmmdd-HHMMSS-pid>. Restore the
    # newest one so /agents customizations survive uninstall -> reinstall.
    disabled=("$AGENTS/$filename".disabled.*)
    if (( ${#disabled[@]} > 0 )) && [[ "${FORGE_REINSTALL_AGENTS:-0}" != "1" ]]; then
      latest="$(printf '%s\n' "${disabled[@]}" | LC_ALL=C sort | tail -n1)"
      mv "$latest" "$AGENTS/$filename"
      restored=$((restored+1))
    else
      cp "$file" "$AGENTS/$filename"
      installed=$((installed+1))
    fi
  fi
done
# Forge v6.2 runs planning, execution and delivery in the main agent; its only agents are
# forge-code-reviewer and forge-plan-critic. Park every retired agent (incl. copies parked by an older uninstall.sh) in the
# backup directory so OMP /agents no longer lists agents that Forge never runs.
retired=0
for file in "$AGENTS"/forge-{critic,architect,qa-strategist,requirement,planner,executor,qa,delivery}.md "$AGENTS"/forge-{critic,architect,qa-strategist,requirement,planner,executor,qa,delivery}.md.disabled.*; do
  [[ -f "$file" ]] || continue
  mv "$file" "$BACKUP_DIR/$(basename "$file")"
  retired=$((retired+1))
done
shopt -u nullglob
printf 'Installed OMP Forge v6.1 (shared core) at %s\n' "$AGENT_ROOT"
printf 'Backup directory: %s\n' "$BACKUP_DIR"
printf 'Configuration preserved: %s/config.json\n' "$EXT"
printf 'Agent definitions: %s installed, %s preserved, %s restored from uninstall (model/prompt changes kept)\n' "$installed" "$preserved" "$restored"
printf 'Gate skills: %s installed, %s replaced (old agent-based text, backed up), %s preserved, %s retired\n' "$skills_installed" "$skills_replaced" "$skills_preserved" "$skills_retired"
printf 'Retired agents (no longer used by Forge) moved to backup: %s\n' "$retired"
if ! cmp -s "$SOURCE_ROOT/agents/forge-code-reviewer.md" "$AGENTS/forge-code-reviewer.md"; then
  printf 'NOTE: your installed forge-code-reviewer differs from the bundled diff-scoped reviewer. Compare it with %s, or replace it: FORGE_REINSTALL_AGENTS=1 bash install.sh (backups kept).\n' "$SOURCE_ROOT/agents/forge-code-reviewer.md"
fi
printf 'Restart OMP. Then type: /forge (prefills "forge: " in the prompt; Shift+Enter for new lines, Ctrl+V to paste images)\n'
printf 'Manage agent models/prompts with OMP /agents; view fixed Forge map with /forge agents\n'
printf 'Forge plan mode with its own approval dialog; no automatic git commits or pushes.\n'
printf 'Plan gate: you plan in Forge plan mode (scout research, ask, plan file, forge_plan_propose); /forge planreview on adds forge-plan-critic before approval; QA uses one forge-code-reviewer\n'
printf 'Gate Skills: /forge skill (interactive), /forge skill list, /forge skill add qa go-testing\n'
printf 'Paste a new SKILL.md: /forge skill create (or /forge skill create qa)\n'
printf 'Autocomplete: type /forge followed by Space, then choose from the native suggestion list (Tab when needed).\n'
# For recovery only: FORGE_REINSTALL_AGENTS=1 bash install.sh replaces files after backup.
printf 'Branch-aware recovery snapshots (local, private, pruned after 30 days): %s/forge-checkpoints/\n' "$AGENT_ROOT"

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
GATE_SKILLS=(forge-requirement-gate forge-plan-gate forge-execute-gate forge-qa-gate)
BACKUP_DIR="$AGENT_ROOT/forge-backups/$(date +%Y%m%d-%H%M%S)-$$"
for path in "${FORGE_FILES[@]/#/$SOURCE_ROOT/forge/}" "$SOURCE_ROOT/forge/config.json"; do
  [[ -f "$path" ]] || { printf 'Missing required file: %s\n' "$path" >&2; exit 1; }
done
for agent in forge-requirement forge-planner forge-executor forge-qa forge-code-reviewer forge-delivery; do
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
skills_preserved=0
for skill in "${GATE_SKILLS[@]}"; do
  if [[ -e "$SKILLS/$skill" || -L "$SKILLS/$skill" ]]; then
    skills_preserved=$((skills_preserved+1))
  else
    cp -R "$SOURCE_ROOT/skills/$skill" "$SKILLS/$skill"
    skills_installed=$((skills_installed+1))
  fi
done
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
# forge-critic, forge-architect and forge-qa-strategist were merged into forge-requirement.
# Park every copy (incl. ones parked by an older uninstall.sh) in the backup directory
# so OMP /agents no longer lists agents that Forge never runs.
retired=0
for file in "$AGENTS"/forge-{critic,architect,qa-strategist}.md "$AGENTS"/forge-{critic,architect,qa-strategist}.md.disabled.*; do
  [[ -f "$file" ]] || continue
  mv "$file" "$BACKUP_DIR/$(basename "$file")"
  retired=$((retired+1))
done
shopt -u nullglob
printf 'Installed OMP Forge v6.1 (shared core) at %s\n' "$AGENT_ROOT"
printf 'Backup directory: %s\n' "$BACKUP_DIR"
printf 'Configuration preserved: %s/config.json\n' "$EXT"
printf 'Agent definitions: %s installed, %s preserved, %s restored from uninstall (model/prompt changes kept)\n' "$installed" "$preserved" "$restored"
printf 'Gate skills: %s installed, %s preserved in %s\n' "$skills_installed" "$skills_preserved" "$SKILLS"
printf 'Retired agents (merged into forge-requirement) moved to backup: %s\n' "$retired"
if ! cmp -s "$SOURCE_ROOT/agents/forge-requirement.md" "$AGENTS/forge-requirement.md"; then
  printf 'NOTE: forge-requirement now runs the whole Requirement gate in one pass, but your installed copy differs from the bundled one. Compare it with %s, or replace it: FORGE_REINSTALL_AGENTS=1 bash install.sh (backups kept).\n' "$SOURCE_ROOT/agents/forge-requirement.md"
fi
printf 'Restart OMP. Then type: /forge (prefills "forge: " in the prompt; Shift+Enter for new lines, Ctrl+V to paste images)\n'
printf 'Manage agent models/prompts with OMP /agents; view fixed Forge map with /forge agents\n'
printf 'Forge plan mode with its own approval dialog; no automatic git commits or pushes.\n'
printf 'Requirement gate: one forge-requirement pass (intake, gaps, critique, architecture, QA strategy, self-challenge), then your review via forge_requirement_summary\n'
printf 'Gate Skills: /forge skill (interactive), /forge skill list, /forge skill add qa go-testing\n'
printf 'Paste a new SKILL.md: /forge skill create (or /forge skill create qa)\n'
printf 'Autocomplete: type /forge followed by Space, then choose from the native suggestion list (Tab when needed).\n'
# For recovery only: FORGE_REINSTALL_AGENTS=1 bash install.sh replaces files after backup.
printf 'Branch-aware recovery snapshots (local, private, pruned after 30 days): %s/forge-checkpoints/\n' "$AGENT_ROOT"

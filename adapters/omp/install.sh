#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_ROOT="${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}"
EXT="$AGENT_ROOT/extensions/forge"
AGENTS="$AGENT_ROOT/agents"
BACKUP_DIR="$AGENT_ROOT/forge-backups/$(date +%Y%m%d-%H%M%S)-$$"
FORGE_FILES=(index.ts session-resume.mjs core.mjs forge-state.mjs state-recovery.mjs checkpoint-recovery.mjs workspace.mjs transitions.mjs platform.mjs engine.mjs)
for path in "${FORGE_FILES[@]/#/$ROOT/forge/}" "$ROOT/forge/config.json"; do
  [[ -f "$path" ]] || { printf 'Missing required file: %s\n' "$path" >&2; exit 1; }
done
for agent in forge-requirement forge-critic forge-architect forge-qa-strategist forge-planner forge-executor forge-qa forge-code-reviewer forge-delivery; do
  [[ -f "$ROOT/agents/$agent.md" ]] || { printf 'Missing agent: %s\n' "$agent" >&2; exit 1; }
done
mkdir -p "$EXT" "$AGENTS" "$BACKUP_DIR"
for filename in "${FORGE_FILES[@]}"; do
  if [[ -f "$EXT/$filename" ]]; then cp -p "$EXT/$filename" "$BACKUP_DIR/$filename"; fi
  cp "$ROOT/forge/$filename" "$EXT/$filename"
done
if [[ ! -f "$EXT/config.json" ]]; then cp "$ROOT/forge/config.json" "$EXT/config.json"; fi
installed=0
preserved=0
restored=0
shopt -s nullglob
for file in "$ROOT"/agents/forge-*.md; do
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
shopt -u nullglob
printf 'Installed OMP Forge v6.0 (shared core) at %s\n' "$AGENT_ROOT"
printf 'Backup directory: %s\n' "$BACKUP_DIR"
printf 'Configuration preserved: %s/config.json\n' "$EXT"
printf 'Agent definitions: %s installed, %s preserved, %s restored from uninstall (model/prompt changes kept)\n' "$installed" "$preserved" "$restored"
printf 'Restart OMP. Then type: /forge (opens multiline requirement editor)\n'
printf 'Manage agent models/prompts with OMP /agents; view fixed Forge map with /forge agents\n'
printf 'Native Plan Review; no automatic git commits or pushes.\n'
printf 'Requirement mode: thorough by default (all specialists, parallel batches). Opt-in: /forge --fast <req>, /forge quick <req> (low rigor)\n'
printf 'Gate Skills: /forge skill (interactive), /forge skill list, /forge skill add qa go-testing\n'
printf 'Paste a new SKILL.md: /forge skill create (or /forge skill create qa)\n'
printf 'Autocomplete: type /forge followed by Space, then choose from the native suggestion list (Tab when needed).\n'
# For recovery only: FORGE_REINSTALL_AGENTS=1 bash install.sh replaces files after backup.
printf 'Branch-aware recovery snapshots (local, private, pruned after 30 days): %s/forge-checkpoints/\n' "$AGENT_ROOT"

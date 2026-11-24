#!/usr/bin/env bash
set -euo pipefail
AGENT_ROOT="${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}"
if [[ -d "$AGENT_ROOT/extensions/forge" ]]; then
  mkdir -p "$AGENT_ROOT/forge-disabled"
  # Keep it OUTSIDE extensions/ so OMP cannot discover the disabled index.ts.
  mv "$AGENT_ROOT/extensions/forge" "$AGENT_ROOT/forge-disabled/forge.$(date +%Y%m%d-%H%M%S)-$$"
fi
for f in "$AGENT_ROOT"/agents/forge-{code-reviewer,plan-critic}.md; do
  if [[ -f "$f" ]]; then mv "$f" "$f.disabled.$(date +%Y%m%d-%H%M%S)-$$"; fi
done
printf 'Forge disabled; old backups remain at %s/forge-backups. Agents parked as *.disabled.* are restored by the next install.sh. Restart OMP.\n' "$AGENT_ROOT"

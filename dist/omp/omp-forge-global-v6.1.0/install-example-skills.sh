#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_ROOT="${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}"
TARGET="$AGENT_ROOT/skills"
mkdir -p "$TARGET"
for src in "$ROOT"/examples/skills/*; do
  [[ -d "$src" ]] || continue
  name="$(basename "$src")"
  if [[ -e "$TARGET/$name" ]]; then
    printf 'Already installed, skipped: %s\n' "$TARGET/$name"
  else
    cp -R "$src" "$TARGET/$name"
    printf 'Installed example skill: %s\n' "$TARGET/$name"
  fi
done
printf 'Restart OMP if your skill catalog does not refresh automatically.\n'

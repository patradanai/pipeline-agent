#!/usr/bin/env bash
# Creates throwaway git projects for the live Claude Code end-to-end test plan.
#   bash scripts/make-e2e-sandbox.sh [target-dir]   (default: ~/forge-e2e)
set -euo pipefail
ROOT="${1:-$HOME/forge-e2e}"
rm -rf "$ROOT"; mkdir -p "$ROOT"

make_repo() {
  local dir="$ROOT/$1"; mkdir -p "$dir/src" "$dir/test"
  cat > "$dir/package.json" <<'JSON'
{ "name": "forge-e2e", "version": "1.0.0", "type": "module", "private": true,
  "scripts": { "test": "node --test" } }
JSON
  cat > "$dir/src/math.js" <<'JS'
export function add(a, b) { return a + b; }
JS
  cat > "$dir/test/math.test.js" <<'JS'
import test from 'node:test';
import assert from 'node:assert/strict';
import { add } from '../src/math.js';
test('add', () => assert.equal(add(2, 3), 5));
JS
  printf 'node_modules\n' > "$dir/.gitignore"
}

# S1/S3 (S3 reuses s1-happy)/S4/S5/S6: healthy project
for s in s1-happy s4-guards s5-resume s6-approve; do make_repo "$s"; done

# S2: QA must FAIL first — a legacy module with a failing test that the requirement forbids touching
make_repo s2-rework
cat > "$ROOT/s2-rework/src/legacy.js" <<'JS'
// Owned by another team. Known bug: missing space.
export function fullName(first, last) { return `${first}${last}`; }
JS
cat > "$ROOT/s2-rework/test/legacy.test.js" <<'JS'
import test from 'node:test';
import assert from 'node:assert/strict';
import { fullName } from '../src/legacy.js';
test('fullName joins with a space', () => assert.equal(fullName('Ada', 'Lovelace'), 'Ada Lovelace'));
JS

for d in "$ROOT"/*/; do (cd "$d" && git init -q && git add . && git -c user.email=e2e@forge -c user.name=forge-e2e commit -qm "initial"); done
printf 'Forge e2e sandbox ready: %s\n' "$ROOT"
ls -1 "$ROOT"

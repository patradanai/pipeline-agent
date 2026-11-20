# Forge v5.26 — Rigor-First Requirement

v5.25 made the requirement gate faster partly by doing less. v5.26 keeps every
check and removes only waiting and duplicated reading.

## Reverted from v5.25

- Default mode is **thorough** again (all 3 steps, all 7 specialist calls).
- Fast mode no longer skips the challenge on the orchestrator's own severity
  judgement: COOKING → summary → CHALLENGE always.
- Removed the "read only listed files" fence and the ≤ 12 / ≤ 8 bullet caps.

## Speed that costs no rigor (applies to thorough)

- CHALLENGE runs `forge-critic` and `forge-architect` as independent tasks in
  ONE parallel batch (was "separately", usually sequential). Neither sees the
  other's report, so independence is kept.
- DISCOVERY now ends with a "Relevant files" list; COOKING pastes the same
  baseline/unknowns/files into all four tasks, so they start from shared
  context instead of re-discovering it. It is a starting point, not a fence:
  specialists read more when needed and say what they read.
- Specialists return complete, structured, evidence-labelled reports (no cap),
  which makes synthesis faster and less error-prone.

## New rigor guard (fast/quick)

- Forge counts the CRITICAL/HIGH labels in each specialist's own task result.
  `forge_requirement_summary` is rejected if specialists reported any
  CRITICAL/HIGH but the summary lists none (duplicates may be merged; severity
  may not vanish). Limitation: matches uppercase labels only.

## Modes

| Mode | Specialist calls | Waits | Rigor |
|---|---|---|---|
| thorough (default) | 7 | 3 (all parallel inside) | full |
| fast (`/forge --fast`) | 6 | 2 + summary | full perspectives + adversarial pass; orchestrator intake instead of discovery agent |
| quick (`/forge quick`) | 2 (4 on CRITICAL/HIGH) | 1 | LOW — warning shown; trivial changes only |

## Tests

205/205; smoke install/uninstall/reinstall PASS.

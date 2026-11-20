# Forge v5.25 — Fast Requirement Mode

## Why

The thorough REQUIREMENT gate ran 3 serial steps and 7 subagent calls, with
`forge-requirement`, `forge-critic` and `forge-architect` each called twice, and
a CHALLENGE prompt that asked for agents "separately".

## New: requirement modes

| Mode | Steps | Subagents (no escalation) | Subagents (escalated) |
|---|---|---|---|
| **fast** (new default) | inline intake → 1 parallel batch → summary → challenge only if needed | 4 | 6 |
| **quick** | inline intake → batch of analyst + QA strategist → summary | 2 | 4 |
| **thorough** (old behaviour) | DISCOVERY → COOKING → CHALLENGE | 7 | 7 |

- The orchestrator does intake itself (no DISCOVERY subagent) and writes one
  compact Requirement Brief with a "Relevant files" list. Every specialist gets
  the same brief, reads only those files plus targeted grep, and returns ≤ 12
  severity-labelled bullets. All specialists run in ONE task batch.
- New tool `forge_requirement_summary` (control-plane, no project writes):
  baseline, findings with severity, open blockers, assumptions, relevant files.
  Forge escalates to a focused CHALLENGE (critic + architect in parallel, only
  on escalated items) when there is any CRITICAL/HIGH finding or open blocker;
  otherwise it goes straight to Planning.
- Planning receives the summary in its instruction, so the planner does not
  re-run discovery.
- `session_stop` nudges for the summary (max 2) instead of stalling.

## Commands

- `/forge mode` shows the default; `/forge mode fast|quick|thorough` saves it.
- One run: `/forge quick <req>`, `/forge thorough <req>`, `/forge --fast <req>`.
  A requirement that merely starts with the word "fast" is not treated as a flag.

## Compatibility

- Existing `config.json` without `requirementMode` → fast for new workflows.
- In-flight workflows without a mode keep the thorough path.
- Human Plan Approval, QA and all write/Git guards are unchanged. Skipping the
  challenge is a speed/depth tradeoff, not a safety boundary: the plan still
  needs native human approval.

## Tests

201/201 (13 new); legacy tests pinned to `requirementMode: thorough`.

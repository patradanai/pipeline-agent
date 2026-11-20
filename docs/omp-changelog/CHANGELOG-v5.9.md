# OMP Forge v5.9 — Create Gate Skills from pasted Markdown

- `/forge skill create [gate]`: native OMP multiline SKILL.md editor and optional Gate selection.
- Validates skill frontmatter name/description, nonempty body, UTF-8 size limits; no existing directory/file is overwritten.
- Saves into global OMP skill directory, automatically assigns to Gate; creation forbidden during active runs.
- Adds Create option to `/forge skill` picker. Preserves v5.8 Agent Routing / Approval / QA / Delivery.
- Native editor integration is mock-tested; verify on the installed OMP version.

# OMP Forge v5.11 — Native Agent Assignment

- Replaced the user-facing Gate → Role → Agent selector with Gate → Assigned Agent → New Agent.
- Uses OMP project/global Agent Markdown discovery and displays declared model aliases without overriding model selection.
- Added role-free commands and autocomplete for Gate Agent assignments and resets.
- Preserves v5.10 role-keyed configuration internally for compatibility and independent QA/critic slots.
- Maintains Gate Skills, Approval, QA, Delivery and no automatic Git Commit/Push.
- 107 Node automated tests passing; OMP Mac TUI integration still needs validation.

# v5.8 — Supplemental Gate Skills

- Add configurable skill packs for requirement/planning/execution/qa/delivery.
- Add `/forge skills` and `/forge skill [list|add|remove|reset]`, plus native UI picker.
- Verify SKILL.md frontmatter, pin SHA256 per workflow, and fail closed on skill drift.
- Inject selected Gate Skill contents into actual flat/batch `task` inputs through supported tool-call argument rewriting.
- Keep all previous Approval, QA and Git manual-delivery policies.
- Add optional, non-overwriting sample skill installer and regression tests.

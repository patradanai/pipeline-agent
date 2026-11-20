# OMP Forge v5.10 — Native Slash-command Auto-complete

- Added synchronous `getArgumentCompletions` to the global `/forge` command using the standard OMP TUI completion contract.
- Multi-level command discovery for agent, skill, and auto; gate/role completions use actual Forge supported gates.
- Installed Agent and Skill names are suggested from the existing global registries; remove only suggests currently attached skills.
- Full-argument completion values preserve existing tokens when a suggestion is accepted.
- Does not change commands, permissions, saved configuration, workflows or multiline requirement editing.
- Regression: 104 automated tests pass; no OMP desktop Mac end-to-end session was available in the build environment.

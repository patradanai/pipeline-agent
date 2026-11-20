# OMP Forge v5.17 — Resume checkpoint safety

## Fixed

- `/forge resume` **always** opens a Forge session picker, even when the current OMP session has an active but unrelated workflow. The current run is displayed as an explicit option instead of being continued implicitly.
- After `switchSession`, Forge reads the **actual selected OMP branch** and compares its phase, slug, requirement, approval status, and available approved-plan fingerprint with the preview checkpoint. If a session has multiple branches and the preview does not match the active branch, Forge **stops without advancing any Gate**. Use OMP `/resume` to select the intended branch.
- Picker labels prioritize the original Forge requirement over unrelated OMP session titles so that `[EXECUTING]` and `[REQUIREMENT]` are easier to distinguish.
- `/forge status` includes the active requirement, plan slug, and approval status to make wrong-session recovery visible.
- Bare `/forge auto` now shows usage instead of silently starting a new requirement literally named `auto`. Use `/forge auto on` or `/forge auto off`.
- `/forge resume current` explicitly continues the current workflow without opening the picker (with autocomplete).
- Resuming `EXECUTING` does **not** automatically replay a potentially non-idempotent executor turn. Check existing changes and test evidence; run `/forge qa` when the implementation is actually complete.

## Safety

- No automatic approval, execution replay, Git commit, push, merge, or tag.
- The approved plan must still be valid for QA and delivery.
- Forge does not promote a REQUIREMENT checkpoint to EXECUTING simply because a session file contains a newer EXECUTING entry on another branch.

## Tests

- Node test suite: 120/120 tests passing, including EXECUTING recovery, mismatch protection, active-current selection, bare `auto`, and compatibility regressions.
- Installer smoke test included.
- Native OMP v19 end-to-end session switching on the user's Mac has **not** been verified; test on a non-production workspace first.

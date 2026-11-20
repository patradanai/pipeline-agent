# OMP Forge v5.16 — OMP 19 Session Picker Compatibility

- Fix TypeError `(native ?? []).filter is not a function` in `/forge resume`.
- OMP `SessionManager.listForPicker` and `listAllForPicker` can now return `PickerListing` (`{ sessions, complete }`) instead of `SessionInfo[]`.
- Await the `complete` scan so Forge checkpoint filtering includes untitled/unindexed sessions, with safe fallback to `sessions` if the scan fails.
- Retain compatibility with older array-returning OMP builds.
- Add regression tests covering v19 current-project and all-project picker results, array behavior, and scan failure.
- Keep all Forge gate, approval, QA, and no-auto-commit policies unchanged.

Automated tests are mocks; not validated end-to-end against the user's installed OMP v19.

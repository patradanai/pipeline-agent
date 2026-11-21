---
name: go-testing
description: Review and test Go changes with unit tests, race checks when feasible, and business-case evidence.
---
# Go Test Quality Supplement

Link every planned BIZ/REQ/TC to a test or explain why NOT_RUN.
Prefer `go test ./...` when the repository supports it, verify relevant error
paths, concurrency, cancellation, and deterministic behavior. Suggest
`go test -race ./...` when appropriate and feasible. Never declare PASS
without observed command, exit status, and test output. Never run Git writes.

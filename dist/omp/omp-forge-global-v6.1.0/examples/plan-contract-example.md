# Example Forge v5 Plan (illustrative, not an actual approved plan)

## Business Topics
- BIZ-001: Booking
- BIZ-002: Approval

## Requirement Traceability
- REQ-001 | BIZ-001 | Create booking | Stored exactly once
- REQ-002 | BIZ-001 | Prevent overlapping booking | Conflicts rejected
- REQ-003 | BIZ-002 | Manager approves booking | Only authorized manager can approve

## Business Test Cases
- TC-001 | BIZ-001 | REQ-001 | Create valid booking | Stored exactly once | Automated integration test
- TC-002 | BIZ-001 | REQ-002 | Create overlapping booking | Conflict rejected | Automated concurrency test
- TC-003 | BIZ-002 | REQ-003 | Unauthorized approval | Forbidden | Automated authorization test

## Code Quality Gates
- QG-001: Unit and integration tests
- QG-002: Lint and static analysis
- QG-003: Security, maintainability and error-handling review

## Execution & QA Handoff
- Keep stable BIZ/REQ/TC/QG IDs throughout execution and QA
- QA must submit exact planned TC cases with outcomes and observed evidence
- NOT_RUN/BLOCKED prevent QA PASS
- Human performs git commit/push only after QA PASS and delivery handoff

# OMP Forge — Post-Execution QA Report

- **Gate:** FAIL
- **Workflow:** example-only
- **Plan:** example-plan.md
- **Generated:** example-only
- **Business topics:** 2
- **Requirements traced:** 2
- **Quality gates:** 2
- **Checks:** 2 PASS / 3 FAIL / 0 BLOCKED / 0 NOT_RUN

## Business Test Cases

### BIZ-001 — Booking

| Test Case | REQ | Scenario | Expected | Actual | Result | Evidence |
|---|---|---|---|---|---|---|
| TC-001 | REQ-001 | Create booking | Booking persisted | Booking persisted | **PASS** | Example-only: booking_test.go:42 |

### BIZ-002 — Approval

| Test Case | REQ | Scenario | Expected | Actual | Result | Evidence |
|---|---|---|---|---|---|---|
| TC-002 | REQ-002 | Unauthorized approval | 403 Forbidden | 200 OK | **FAIL** | Example-only: approval_test.go:88 |

Files: `approval.go:70`


## Code Quality Checks

| Gate | Check | Result | Evidence |
|---|---|---|---|
| QG-001 | go test ./... | FAIL | Example-only: one failing approval test |
| QG-002 | go vet ./... | PASS | Example-only: exit 0 |

## Code Review

**Result:** FAIL

**Evidence:** Example-only: reviewed approval.go:40-95

- **CR-001 [HIGH] Missing authorization check** — Example-only: handler does not validate manager role (approval.go:70)

## Gate Blockers / Coverage Gaps

- None identified by the report validator.

## Limitations

- All data in this sample is illustrative; no real code or tests were inspected.

## Reviewed Changes

- approval.go
- booking.go

> Evidence is reported by the reviewing agent; this tool checks structure and coverage, not whether evidence is truthful.

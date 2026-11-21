# Example — OMP Forge Delivery (simulated)

- QA: PASS
- Plan: `local://forge-example-plan.md`
- Report: `~/.omp/agent/forge-reports/example/qa-report.md`
- Status: READY FOR MANUAL COMMIT

## Delivery Summary

- Booking requests reject overlapping slots
- Approvals require the Manager role
- Business test cases and quality gates verified in this **hypothetical** example

## Suggested Commit Message (copy and paste)

```text
feat(booking): add approval and conflict checks

- Reject overlapping booking periods
- Require manager permissions before approval
- Add acceptance tests for booking and approval
```

OMP Forge does **not** stage, commit, push, tag, merge or release. The user must review the diff and run any Git writes manually.

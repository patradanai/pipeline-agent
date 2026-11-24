export const PLAN = `# Plan
## Context
Users create bookings and managers approve them.
## Approach
1. Add createBooking and approveBooking in booking.ts (REQ-001, REQ-002).
- Open decisions: none
- Migration & rollback: not applicable — no data or API change
## Verification
- node test: TC-001 and TC-002 pass
## Assumptions & contingencies
- none
## Business Topics
- BIZ-001: Booking
- BIZ-002: Approval
## Requirement Traceability
- REQ-001 | BIZ-001 | Create booking | Created
- REQ-002 | BIZ-002 | Approve booking | Approved
## Business Test Cases
- TC-001 | BIZ-001 | REQ-001 | Create booking | Created | node test
- TC-002 | BIZ-002 | REQ-002 | Approve booking | Approved | node test
## Code Quality Gates
- QG-001: Unit tests
- QG-002: Lint
`;
export const SUBMISSION = {
  topicResults:[
    {topicId:'BIZ-001',tests:[{testId:'TC-001',requirementIds:['REQ-001'],scenario:'Create booking',expected:'Created',actual:'Created',status:'PASS',evidence:'test booking passed',severity:'HIGH'}]},
    {topicId:'BIZ-002',tests:[{testId:'TC-002',requirementIds:['REQ-002'],scenario:'Approve booking',expected:'Approved',actual:'Approved',status:'PASS',evidence:'test approval passed',severity:'HIGH'}]},
  ],
  codeQualityChecks:[{gateId:'QG-001',name:'unit tests',status:'PASS',evidence:'tests exit 0'},{gateId:'QG-002',name:'lint',status:'PASS',evidence:'lint exit 0'}],
  codeReview:{status:'PASS',evidence:'Reviewed service.ts:10-90',findings:[]},
  reviewedChanges:['service.ts'],
};
export const FAIL_SUBMISSION = JSON.parse(JSON.stringify(SUBMISSION));
FAIL_SUBMISSION.topicResults[0].tests[0] = { ...FAIL_SUBMISSION.topicResults[0].tests[0], status: 'FAIL', actual: 'Error 500', evidence: 'npm test: booking.spec failed' };

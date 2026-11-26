import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isProhibitedGitCommand, validatePlanContract, extractApprovedCommands, GATE_MODEL_SELECTOR_PATTERN,
  GATE_EFFORT_LEVELS, cloneGateEfforts,
  buildCommitMessage, inlineGateSkills, skillAudience, initialState, phaseInstruction,
} from '../core/core.mjs';
import { executionStopTransition, executionDoneTransition, approvedExecutionState, qaResubmission, MAX_QA_RESUBMITS } from '../core/transitions.mjs';
import { PLAN } from './fixtures.mjs';

test('Git guard blocks working-tree destroyers and hub as a git wrapper', () => {
  for (const cmd of ['git clean -fd', 'git restore .', 'git rm src/a.ts', 'git mv a b', 'hub push', 'git -C sub restore --staged x'])
    assert.equal(isProhibitedGitCommand(cmd), true, cmd);
  for (const cmd of ['git status --short', 'git diff --stat', 'github-cli status', 'npm run clean'])
    assert.equal(isProhibitedGitCommand(cmd), false, cmd);
});

test('plan contract ignores fenced examples and rejects duplicate IDs', () => {
  const fencedOnly = '```markdown\n' + PLAN + '\n```\n';
  assert.equal(validatePlanContract(fencedOnly).valid, false, 'a plan inside a code fence is an example, not a contract');
  const withExample = PLAN.replace('## Business Topics', '```\n## Business Topics\n- BIZ-009: example only\n```\n## Business Topics');
  assert.ok(!validatePlanContract(withExample).topics.some(t => t.id === 'BIZ-009'));
  const duplicated = PLAN.replace(/(- REQ-001 \|[^\n]*\n)/, '$1$1');
  assert.ok(validatePlanContract(duplicated).issues.includes('REQ-001 is duplicated.'));
});

test('approved plan commands exclude destructive commands, installs and Git writes', () => {
  const plan = '## Verification\n- `go test ./pkg -run TestA` passes\n- never `rm -rf tmp`\n- `npm install`\n- `git commit -am x`\n- `TestName` only\n```bash\n$ npm run build\n# a comment\n```\n';
  assert.deepEqual(extractApprovedCommands(plan), ['go test ./pkg -run TestA', 'npm run build']);
});

test('model selectors need a role name after @; commit subjects reject control characters', () => {
  assert.equal(GATE_MODEL_SELECTOR_PATTERN.test('@'), false);
  assert.equal(GATE_MODEL_SELECTOR_PATTERN.test('@plan'), true);
  assert.equal(GATE_MODEL_SELECTOR_PATTERN.test('anthropic/claude-opus-5-5'), true);
  assert.equal(GATE_MODEL_SELECTOR_PATTERN.test('@plan:high'), false);
  assert.equal(GATE_MODEL_SELECTOR_PATTERN.test('@plan:nope'), false);
  assert.ok(GATE_EFFORT_LEVELS.includes('auto'));
  assert.equal(cloneGateEfforts({planning:'auto'}).planning, 'auto');
  assert.equal(cloneGateEfforts().planning, null);
  assert.throws(() => buildCommitMessage('feat: add \u0000 thing'), /control characters/);
});

test('gate skills are inlined in place of the load directive, with their audience respected by the loader', () => {
  const lead = '---\nname: forge-plan-gate\ndescription: d\nforge-audience: lead\n---\nLead body';
  assert.equal(skillAudience(lead), 'lead');
  assert.equal(skillAudience('---\nname: x\ndescription: d\n---\nBody'), 'all');
  const text = phaseInstruction(initialState('Build it', 'forge-x'));
  assert.match(text, /^Load and follow the forge-plan-gate skill\./);
  const inlined = inlineGateSkills(text, names => names.map(name => ({ name, content: lead })));
  assert.match(inlined, /^\[FORGE GATE SKILLS[^\n]*\]\n### Skill: forge-plan-gate\nLead body\n\[END FORGE GATE SKILLS\]/);
  assert.doesNotMatch(inlined, /Load and follow/);
  assert.equal(inlineGateSkills(text, () => []), text, 'nothing to inline keeps the instruction');
});

test('a rework instruction asks for in-place edits only when Forge seeded the rework plan', () => {
  const rework = { ...initialState('Build it', 'forge-x'), reworkBaseHash: 'abc', reworkBasePlanPath: 'local://forge-x-plan.md',
    reworkCycles: 1, reworkReason: 'QA_FAIL', qaStatus: 'FAIL' };
  const fresh = phaseInstruction(rework);
  assert.match(fresh, /Save a revised plan to local:\/\/forge-x-rework-1-plan\.md/);
  assert.doesNotMatch(fresh, /Forge already copied/);
  const seeded = phaseInstruction({ ...rework, reworkPlanSeededPath: 'local://forge-x-rework-1-plan.md' });
  assert.match(seeded, /Edit local:\/\/forge-x-rework-1-plan\.md; never modify the previous approved plan\./);
  assert.match(seeded, /Forge already copied the previous approved plan to local:\/\/forge-x-rework-1-plan\.md/);
  assert.doesNotMatch(seeded, /Save a revised plan/);
});

test('an execution stop enters QA only after forge_execution_done; otherwise it reminds, then pauses', () => {
  let state = approvedExecutionState({ ...initialState('Build it', 'forge-x'), active: true, phase: 'PLAN', planValid: true }, 'test');
  const reminded = executionStopTransition(state);
  assert.equal(reminded.action, 'remind');
  state = executionStopTransition(reminded.state).state;
  assert.equal(executionStopTransition(state).action, 'pause');
  const done = executionDoneTransition(state, { summary: 'ok', changedFiles: ['a.ts'], checksRun: ['npm test: exit 0'] });
  const qa = executionStopTransition(done);
  assert.equal(qa.action, 'qa');
  assert.equal(qa.state.phase, 'QA');
  assert.equal(qa.state.qaResubmits, 0);
  assert.throws(() => executionDoneTransition(qa.state, {}), /approved plan is executing/);
});

test('QA format errors are returned at most MAX_QA_RESUBMITS times per round', () => {
  const report = { formatErrors: ['TC-001: missing; report it as PASS, FAIL, BLOCKED or NOT_RUN.'] };
  let state = { qaResubmits: 0 };
  for (let i = 0; i < MAX_QA_RESUBMITS; i++) {
    const retry = qaResubmission(state, report);
    assert.match(retry.message, /NOT recorded[\s\S]*TC-001: missing/);
    state = retry.state;
  }
  assert.equal(qaResubmission(state, report), null);
  assert.equal(qaResubmission({ qaResubmits: 0 }, { formatErrors: [] }), null);
});

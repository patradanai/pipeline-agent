// End-to-end: runs the BUILT plugin (dist/) exactly as Claude Code would —
// one `node forge-hook.mjs <Event>` process per hook, JSON on stdin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PLAN, SUBMISSION, MINIMAL_SUBMISSION, EXECUTION_DONE } from '../../../core-tests/fixtures.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PLUGIN = join(ROOT, 'dist', 'claude-code', 'forge-marketplace', 'plugins', 'forge');
const HOOK = join(PLUGIN, 'bin', 'forge-hook.mjs');
const MCP = join(PLUGIN, 'bin', 'forge-mcp.mjs');
const P = 'mcp__plugin_forge_forge__';
assert.ok(existsSync(HOOK), 'run `npm run build` first');

const TEMP_DIRS = [];
process.on('exit', () => { for (const d of TEMP_DIRS) rmSync(d, { recursive: true, force: true }); });
function env() {
  const data = mkdtempSync(join(tmpdir(), 'forge-cc-'));
  const cwd = mkdtempSync(join(tmpdir(), 'forge-proj-'));
  TEMP_DIRS.push(data, cwd);
  let n = 0;
  const sid = `sess-${Math.random().toString(36).slice(2)}`;
  // Like Claude Code: ExitPlanMode's `plan` comes from the plan-mode file on disk, whose path is injected too.
  const hostPlan = join(data, 'home', '.claude', 'plans', `${sid}.md`);
  const withPlanFile = (event, payload) => {
    const tin = payload.tool_input;
    if (payload.tool_name !== 'ExitPlanMode' || payload.noPlanFile || typeof tin?.plan !== 'string' || tin.planFilePath) return payload;
    mkdirSync(dirname(hostPlan), { recursive: true });
    writeFileSync(hostPlan, tin.plan);
    const next = { ...payload, tool_input: { ...tin, planFilePath: hostPlan } };
    if (event === 'PostToolUse') next.tool_response = { plan: tin.plan, filePath: hostPlan, ...(payload.tool_response ?? {}) };
    return next;
  };
  const run = (event, payload, session = sid) => {
    const { noPlanFile, ...body } = withPlanFile(event, payload);
    const r = spawnSync('node', [HOOK, event], { input: JSON.stringify({ session_id: session, cwd, hook_event_name: event, permission_mode: 'plan', ...body }), env: { ...process.env, FORGE_DATA_DIR: data }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? JSON.parse(r.stdout) : {};
  };
  const pre = (tool_name, tool_input = {}, extra = {}) => run('PreToolUse', { tool_name, tool_input, tool_use_id: `t${++n}`, ...extra });
  const post = (tool_name, tool_input = {}, tool_response = {}, extra = {}) => run('PostToolUse', { tool_name, tool_input, tool_response, tool_use_id: `t${++n}`, ...extra });
  const forge = args => run('UserPromptExpansion', { expansion_type: 'slash_command', command_name: 'forge', command_args: args, command_source: 'plugin', prompt: `/forge ${args}` });
  const state = (session = sid) => JSON.parse(readFileSync(join(data, 'sessions', `${session}.json`), 'utf8')).state;
  const agent = (name, report = 'Report:\n- [LOW][fact] ok (a.ts:1)') => {
    const input = { subagent_type: `forge:${name}`, description: name, prompt: 'analyze' };
    const p = pre('Agent', input);
    assert.notEqual(p.hookSpecificOutput?.permissionDecision, 'deny', JSON.stringify(p));
    // Claude Code order: SubagentStop (with the report) → PostToolUse(Agent)
    run('SubagentStop', { agent_id: `ag-${++n}`, agent_type: `forge:${name}`, last_assistant_message: report, stop_hook_active: false });
    return post('Agent', input, { content: [{ type: 'text', text: report }] });
  };
  const done = () => { pre(`${P}forge_execution_done`, EXECUTION_DONE); return post(`${P}forge_execution_done`, EXECUTION_DONE, {}); };
  return { data, cwd, sid, run, pre, post, forge, state, agent, done };
}
const ctx = out => out.hookSpecificOutput?.additionalContext ?? '';
/** Context plus the file Forge wrote when the instruction exceeded the inline limit. */
const fullCtx = out => { const c = ctx(out); const f = c.match(/READ THIS FILE COMPLETELY before acting: (\S+\.md)/); return f ? `${c}\n${readFileSync(f[1], 'utf8')}` : c; };
const denied = out => out.hookSpecificOutput?.permissionDecision === 'deny';

test('sessions without Forge are untouched (no state file, no decisions)', () => {
  const x = env();
  assert.deepEqual(x.pre('Bash', { command: 'git push' }), {});
  assert.deepEqual(x.pre('Write', { file_path: 'a.ts' }), {});
  assert.equal(existsSync(join(x.data, 'sessions')), false);
});

test('full workflow through real hook processes: /forge → plan → ExitPlanMode → main executes → QA reviewer → delivery', () => {
  const x = env();
  const start = x.forge('Build a booking system');
  assert.match(ctx(start), /Forge started\. Gates: plan/);
  assert.match(fullCtx(start), /GATE 1\/3: PLAN — Forge plan mode/);
  assert.match(fullCtx(start), /subagent_type "Explore"/); // footer mapping
  assert.match(fullCtx(start), /### Skill: forge-plan-gate\n/); // bundled gate skill inlined
  assert.doesNotMatch(fullCtx(start), /Load and follow the/);
  assert.doesNotMatch(ctx(start), /forge-requirement|forge-planner|forge_requirement_summary/);
  assert.equal(x.state().phase, 'PLAN');
  // pre-approval guards
  assert.ok(denied(x.pre('Write', { file_path: join(x.cwd, 'a.ts'), content: 'x' })));
  assert.ok(denied(x.pre('Bash', { command: 'git commit -am wip' })));
  assert.deepEqual(x.pre('Read', { file_path: 'a' }), {});
  // the main agent researches with Explore; the QA reviewer is not part of PLAN
  assert.deepEqual(x.pre('Agent', { subagent_type: 'Explore', prompt: 'map the booking module' }), {});
  assert.ok(denied(x.pre('Agent', { subagent_type: 'forge:forge-code-reviewer', prompt: 'review' })));
  // ExitPlanMode outside plan mode / invalid / valid
  assert.ok(denied(x.pre('ExitPlanMode', { plan: PLAN }, { permission_mode: 'default' })));
  const bad = x.pre('ExitPlanMode', { plan: '# nope' });
  assert.ok(denied(bad)); assert.match(bad.hookSpecificOutput.permissionDecisionReason, /plan contract is invalid/);
  assert.deepEqual(x.pre('ExitPlanMode', { plan: PLAN }), {});
  assert.equal(x.state().phase, 'PLAN');
  assert.ok(readFileSync(x.state().planPath, 'utf8').includes('BIZ-001'));
  // native approval = ExitPlanMode succeeded
  const approved = x.post('ExitPlanMode', { plan: PLAN }, { result: 'User approved' });
  assert.match(ctx(approved), /APPROVED EXECUTION/);
  assert.equal(x.state().phase, 'EXECUTE');
  // the main agent implements itself
  assert.deepEqual(x.pre('Write', { file_path: join(x.cwd, 'booking.ts'), content: 'x' }), {});
  assert.match(x.run('Stop', { stop_hook_active: false }).reason, /turn ended without forge_execution_done/); // not done yet
  assert.equal(x.state().phase, 'EXECUTE');
  assert.match(ctx(x.done()), /execution recorded as done/);
  const stop = x.run('Stop', { stop_hook_active: false, last_assistant_message: 'done' });
  assert.equal(stop.decision, 'block'); assert.match(stop.reason, /QA REVIEW|POST-EXECUTION|READ THIS FILE/);
  assert.equal(x.state().phase, 'QA');
  assert.ok(denied(x.pre('Edit', { file_path: 'a.ts' })));
  assert.match(ctx(x.post(`${P}forge_qa_scope`, {}, {})), /QA scope/);
  assert.ok(denied(x.pre(`${P}forge_qa_submit`, SUBMISSION))); // PASS review needs the reviewer
  x.agent('forge-code-reviewer');
  assert.ok(denied(x.pre('Agent', { subagent_type: 'forge:forge-code-reviewer', prompt: 'again' }))); // one counted pass
  assert.deepEqual(x.pre(`${P}forge_qa_submit`, MINIMAL_SUBMISSION), {});
  assert.match(ctx(x.post(`${P}forge_qa_submit`, MINIMAL_SUBMISSION, {})), /QA GATE: PASS/);
  assert.equal(x.state().phase, 'QA');
  // delivery: written by the main agent, no further agent
  assert.deepEqual(x.pre(`${P}forge_delivery_submit`, { subject: 'feat(booking): add approvals', body: '- approvals' }), {});
  const delivered = x.post(`${P}forge_delivery_submit`, { subject: 'feat(booking): add approvals', body: '- approvals' }, {});
  assert.match(ctx(delivered), /COPY THIS COMMIT MESSAGE/);
  assert.equal(x.state().phase, 'QA');
  assert.equal(x.state().active, false);
  assert.ok(readdirSync(join(x.data, 'reports', x.sid)).length > 0);
});

test('parallel Agent hooks do not lose updates (state lock)', async () => {
  const x = env();
  toApproved(x, x.sid);
  x.pre('Write', { file_path: join(x.cwd, 'booking.ts'), content: 'x' });
  x.done();
  x.run('Stop', { stop_hook_active: false, last_assistant_message: 'done' });
  assert.equal(x.state().phase, 'QA');
  const runAsync = (event, payload) => new Promise((resolve, reject) => {
    const child = spawn('node', [HOOK, event], { env: { ...process.env, FORGE_DATA_DIR: x.data } });
    let out = ''; child.stdout.on('data', d => { out += d; });
    child.on('close', code => code === 0 ? resolve(out) : reject(new Error(`exit ${code}`)));
    child.stdin.end(JSON.stringify({ session_id: x.sid, cwd: x.cwd, hook_event_name: event, permission_mode: 'plan', ...payload }));
  });
  // Two hooks that each write a different state field run at the same time: both updates must survive.
  await Promise.all([
    runAsync('PreToolUse', { tool_name: 'Agent', tool_input: { subagent_type: 'forge:forge-code-reviewer' }, tool_use_id: 'p1' }),
    runAsync('PreToolUse', { tool_name: 'SubagentHandback', tool_input: { report: 'research notes' }, tool_use_id: 'p2', agent_id: 'r1', agent_type: 'Explore' }),
  ]);
  assert.deepEqual(x.state().gateAgentsSpawned.QA, ['forge-code-reviewer']);
  assert.match(x.state().handbacks.r1, /research notes/);
  await Promise.all([
    runAsync('SubagentStop', { agent_id: 'bg1', agent_type: 'forge:forge-code-reviewer', last_assistant_message: 'ok report' }),
    runAsync('PreToolUse', { tool_name: 'SubagentHandback', tool_input: { report: 'more notes' }, tool_use_id: 'p3', agent_id: 'r2', agent_type: 'Explore' }),
  ]);
  assert.deepEqual(x.state().gateAgents.QA, ['forge-code-reviewer']);
  assert.match(x.state().handbacks.r2, /more notes/);
});

test('the reviewer subagent is read-only: no writes, no shell', () => {
  const x = env();
  x.forge('Build a booking system');
  const reviewer = { agent_id: 'a1', agent_type: 'forge:forge-code-reviewer' };
  assert.ok(denied(x.pre('Write', { file_path: 'a.ts' }, reviewer)));
  assert.ok(denied(x.pre('Edit', { file_path: 'a.ts' }, reviewer)));
  assert.ok(denied(x.pre('Bash', { command: 'npm test' }, reviewer)));
  assert.deepEqual(x.pre('Read', { file_path: 'a.ts' }, reviewer), {});
});

test('/forge status and off', () => {
  const x = env();
  assert.match(ctx(x.forge('status')), /Forge: inactive/);
  x.forge('Build CRM');
  const status = ctx(x.forge('status'));
  assert.match(status, /Forge: PLAN \| requirement: Build CRM/);
  assert.doesNotMatch(status, /internal:|mode:/);
  x.forge('off');
  assert.equal(x.state().active, false);
  assert.deepEqual(x.pre('Write', { file_path: 'a.ts' }), {});
});

test('per-subcommand commands (autocomplete) map to the same engine commands', () => {
  const x = env();
  const cmd = (name, args = '') => x.run('UserPromptExpansion', { expansion_type: 'slash_command', command_name: name, command_args: args, command_source: 'plugin' });
  assert.match(ctx(cmd('forge-status')), /Forge: inactive/);
  cmd('forge:forge', 'quick Rename a label'); // former mode word is plain requirement text
  assert.equal(x.state().phase, 'PLAN'); assert.equal(x.state().requirement, 'quick Rename a label');
  assert.match(ctx(cmd('forge-approve')), /Nothing to approve/);
  cmd('forge-off');
  assert.equal(x.state().active, false);
  cmd('forge', 'Build CRM');
  assert.equal(x.state().active, true);
  assert.deepEqual(cmd('forge-unknownthing'), { hookSpecificOutput: { hookEventName: 'UserPromptExpansion', additionalContext: ctx(cmd('forge-unknownthing')) } });
});

test('/forge-planreview on: ExitPlanMode needs forge-plan-critic and every CRITICAL/HIGH PC-id in the plan', () => {
  const x = env();
  const cmd = (name, args = '') => x.run('UserPromptExpansion', { expansion_type: 'slash_command', command_name: name, command_args: args, command_source: 'plugin' });
  assert.match(ctx(cmd('forge-planreview')), /plan review is OFF/);
  assert.match(ctx(cmd('forge-planreview', 'on')), /plan review ON for new workflows/);
  assert.equal(JSON.parse(readFileSync(join(x.data, 'config.json'), 'utf8')).planReview, true);
  const start = x.forge('Build a booking system');
  assert.equal(x.state().planReview, true);
  assert.match(fullCtx(start), /PLAN REVIEW is ON[\s\S]*forge:forge-plan-critic/);
  assert.match(x.pre('ExitPlanMode', { plan: PLAN }).hookSpecificOutput.permissionDecisionReason, /run forge-plan-critic once/);
  assert.match(ctx(x.agent('forge-plan-critic', '- PC-001 [CRITICAL] Approach — no rollback for refunds — add rollback\n- PC-002 [LOW] wording')), /forge-plan-critic reported/);
  const missing = x.pre('ExitPlanMode', { plan: PLAN });
  assert.ok(denied(missing)); assert.match(missing.hookSpecificOutput.permissionDecisionReason, /PC-001/);
  assert.doesNotMatch(missing.hookSpecificOutput.permissionDecisionReason, /PC-002/);
  const resolved = PLAN.replace('## Assumptions & contingencies\n- none', '## Assumptions & contingencies\n- PC-001: rollback restores the prior refund state');
  assert.deepEqual(x.pre('ExitPlanMode', { plan: resolved }), {});
  assert.equal(x.state().planValid, true);
});

test('every generated command is human-only and has a description', () => {
  const dir = join(PLUGIN, 'commands');
  const files = readdirSync(dir);
  const expected = ['forge', 'forge-status', 'forge-resume', 'forge-trace', 'forge-planreview', 'forge-approve', 'forge-plan', 'forge-qa', 'forge-rework', 'forge-delivery', 'forge-report', 'forge-agents', 'forge-off'];
  assert.deepEqual([...files].sort(), expected.map(n => `${n}.md`).sort());
  for (const n of expected) {
    const body = readFileSync(join(dir, `${n}.md`), 'utf8');
    assert.match(body, /disable-model-invocation: true/); assert.match(body, /^---\ndescription: Forge/);
  }
});

function toApproved(x, session) {
  const run = (event, payload) => x.run(event, payload, session);
  run('UserPromptExpansion', { command_name: 'forge', command_args: 'Build a booking system' });
  run('PreToolUse', { tool_name: 'ExitPlanMode', tool_input: { plan: PLAN } });
  run('PostToolUse', { tool_name: 'ExitPlanMode', tool_input: { plan: PLAN }, tool_response: {} });
}

test('native resume (same session id) keeps the workflow and tells Claude where it is', () => {
  const x = env();
  toApproved(x, x.sid);
  const out = x.run('SessionStart', { source: 'resume' });
  assert.match(ctx(out), /Forge workflow in this session: Forge: EXECUTE/);
  assert.equal(x.state().approved, true);
});

test('/forge-resume lists other sessions of the project and adopts one safely', () => {
  const x = env();
  toApproved(x, 'old-session');
  const cmd = (name, args = '') => x.run('UserPromptExpansion', { command_name: name, command_args: args });
  // a new session in the same project gets a hint, not state
  assert.match(ctx(x.run('SessionStart', { source: 'startup' })), /forge-resume/);
  const list = ctx(cmd('forge-resume'));
  assert.match(list, /1\. EXECUTE \(approved\) · Build a booking system/);
  assert.match(list, /claude --resume <session>/);
  const adopt = ctx(cmd('forge-resume', '1'));
  assert.match(adopt, /Adopted EXECUTE from session old-session as PLAN/);
  assert.match(adopt, /fresh native plan approval is required/);
  assert.equal(x.state().phase, 'PLAN'); assert.equal(x.state().approved, false);
  assert.equal(x.state('old-session').active, false); // retired: never two live copies
  assert.equal(x.state('old-session').movedToSession, x.sid);
  assert.match(ctx(cmd('forge-resume')), /No other session/);
  assert.match(ctx(cmd('forge', 'resume 1')), /No workflow #1|already has an active/);
});

test('/forge-resume ignores other projects', () => {
  const x = env();
  toApproved(x, 'old-session');
  const other = x.run('UserPromptExpansion', { command_name: 'forge-resume', command_args: '', cwd: '/somewhere/else' });
  assert.match(ctx(other), /No other session/);
});

test('trace + coverage report reflect a real run', () => {
  const x = env();
  assert.match(ctx(x.run('UserPromptExpansion', { command_name: 'forge-trace', command_args: 'on' })), /trace ON[\s\S]*forge-coverage\.mjs/);
  x.forge('Build a booking system');
  x.pre('Agent', { subagent_type: 'Explore', prompt: 'map the code' });
  x.pre('ExitPlanMode', { plan: PLAN });
  x.post('ExitPlanMode', { plan: PLAN }, {});
  x.pre('Write', { file_path: join(x.cwd, 'a.ts'), content: 'x' });
  x.done();
  x.run('Stop', { stop_hook_active: false, last_assistant_message: 'done' });
  x.agent('forge-code-reviewer');
  x.pre('Bash', { command: 'git commit -am x' });
  const r = spawnSync('node', [join(PLUGIN, 'bin', 'forge-coverage.mjs'), '--data', x.data, '--json'], { encoding: 'utf8' });
  const report = JSON.parse(r.stdout);
  const ok = Object.fromEntries(report.checks.map(c => [c[0], c[3]]));
  assert.deepEqual(report.checks.map(c => c[0]), Array.from({ length: 19 }, (_, i) => `C${String(i + 1).padStart(2, '0')}`));
  for (const id of ['C01', 'C02', 'C03', 'C06', 'C07', 'C09', 'C15']) assert.equal(ok[id], true, id);
  assert.equal(ok.C13, false);
  const a = Object.fromEntries(report.assumptions.map(x => [x[0], x[2]]));
  assert.equal(a.A2, true); assert.equal(a.A3, true); assert.equal(a.A4, true); assert.equal(a.A5, true);
  const text = spawnSync('node', [join(PLUGIN, 'bin', 'forge-coverage.mjs'), '--data', x.data], { encoding: 'utf8' }).stdout;
  assert.match(text, /✔ C07 Native approval/); assert.match(text, /· C13 .*→ run S2/);
  const log = readFileSync(join(x.data, 'trace', 'events.jsonl'), 'utf8');
  const events = log.trim().split('\n').map(l => JSON.parse(l));
  assert.ok(events.some(e => e.hook === 'SubagentStop' && /forge-code-reviewer$/.test(e.agentType) && e.phaseAfter === 'QA'));
  assert.ok(events.every(e => !('summaryRequested' in e)));
  assert.ok(events.every(e => !('stepBefore' in e) && !('stepAfter' in e) && !('mode' in e)));
  assert.doesNotMatch(log, /BIZ-001/); // never logs plan/file contents
});

test('background agent run (the bug seen live): no false "no report", handback allowed, completion via SubagentStop', () => {
  const x = env();
  toApproved(x, x.sid);
  x.pre('Write', { file_path: join(x.cwd, 'age.ts'), content: 'x' });
  x.done();
  x.run('Stop', { stop_hook_active: false, last_assistant_message: 'done' });
  assert.equal(x.state().phase, 'QA');
  const input = { subagent_type: 'forge:forge-code-reviewer', description: 'Diff review', prompt: 'x', run_in_background: true };
  x.pre('Agent', input);
  const launched = x.post('Agent', input, { status: 'async_launched', agentId: 'bg-1' });
  assert.doesNotMatch(ctx(launched), /no report/);
  assert.deepEqual(x.run('Stop', { stop_hook_active: false }), {}); // waiting for the background agent
  const sub = { agent_id: 'bg-1', agent_type: 'forge:forge-code-reviewer' };
  assert.deepEqual(x.pre('SubagentHandback', { report: 'CR-001 [MEDIUM] age.ts:3 leap years unhandled' }, sub), {});
  assert.deepEqual(x.pre('SendMessage', { to: 'bg-1', message: 'status?' }), {});
  x.run('SubagentStop', { ...sub, last_assistant_message: 'Handed back.', stop_hook_active: false });
  assert.deepEqual(x.state().gateAgents.QA, ['forge-code-reviewer']);
  const next = x.run('UserPromptSubmit', { prompt: '<task-notification>Agent "Diff review" finished</task-notification>' });
  assert.match(ctx(next), /forge-code-reviewer reported\. Merge its findings/);
});

test('plan mode plan file: writing it is allowed, project files stay blocked, ExitPlanMode reads it', () => {
  const x = env();
  x.forge('Build a booking system');
  const planFile = join(x.data, 'claude-config', 'plans', 'quiet-forest.md');
  spawnSync('node', ['-e', `const fs=require('fs');fs.mkdirSync(${JSON.stringify(dirname(planFile))},{recursive:true});fs.writeFileSync(${JSON.stringify(planFile)}, ${JSON.stringify(PLAN)})`]);
  const envCfg = { CLAUDE_CONFIG_DIR: join(x.data, 'claude-config') };
  const runCfg = (event, payload) => { const r = spawnSync('node', [HOOK, event], { input: JSON.stringify({ session_id: x.sid, cwd: x.cwd, hook_event_name: event, ...payload }), env: { ...process.env, FORGE_DATA_DIR: x.data, ...envCfg }, encoding: 'utf8' }); return r.stdout ? JSON.parse(r.stdout) : {}; };
  assert.deepEqual(runCfg('PreToolUse', { tool_name: 'Write', tool_input: { file_path: planFile, content: PLAN }, permission_mode: 'plan' }), {});
  assert.ok(denied(runCfg('PreToolUse', { tool_name: 'Write', tool_input: { file_path: join(x.cwd, 'src', 'a.js'), content: 'x' }, permission_mode: 'plan' })));
  assert.ok(denied(runCfg('PreToolUse', { tool_name: 'Write', tool_input: { file_path: planFile, content: PLAN }, permission_mode: 'default' })));
  assert.deepEqual(runCfg('PreToolUse', { tool_name: 'ExitPlanMode', tool_input: {}, permission_mode: 'plan' }), {});
  assert.equal(x.state().phase, 'PLAN');
  runCfg('PostToolUse', { tool_name: 'ExitPlanMode', tool_input: {}, tool_response: {}, permission_mode: 'plan' });
  assert.equal(x.state().phase, 'EXECUTE');
});

test('trace is off by default', () => {
  const x = env(); x.forge('Build CRM');
  assert.equal(existsSync(join(x.data, 'trace')), false);
});

test('other slash commands are ignored by the Forge hook', () => {
  const x = env();
  assert.deepEqual(x.run('UserPromptExpansion', { command_name: 'review', command_args: 'x' }), {});
});

test('long instructions are written to a file instead of being truncated', () => {
  const x = env();
  const out = x.forge('Build a booking system ' + 'with many detailed requirements. '.repeat(400));
  assert.match(ctx(out), /READ THIS FILE COMPLETELY/);
  const file = ctx(out).match(/: (\/\S+\.md)/)[1];
  assert.match(readFileSync(file, 'utf8'), /GATE 1\/3/);
});

test('plan approved with "clear context": a new session inherits EXECUTING within 2 minutes', () => {
  const x = env();
  x.forge('Build a booking system');
  x.pre('ExitPlanMode', { plan: PLAN });
  x.post('ExitPlanMode', { plan: PLAN }, {});
  const fresh = 'sess-after-clear';
  const start = x.run('SessionStart', { source: 'clear' }, fresh);
  assert.match(ctx(start), /Forge workflow in this session: Forge: EXECUTE/);
  assert.equal(x.state(fresh).phase, 'EXECUTE');
  assert.equal(x.state(fresh).recoveryAudit.at(-1).reason, 'claude-code-clear-context-handoff');
  // a plain new session (startup) never inherits state; it only gets a /forge-resume hint
  assert.match(ctx(x.run('SessionStart', { source: 'startup' }, 'sess-unrelated')), /forge-resume/);
  assert.equal(existsSync(join(x.data, 'sessions', 'sess-unrelated.json')), false);
});

test('hook fails closed for an active workflow when its state is corrupt', () => {
  const x = env();
  x.forge('Build a booking system');
  const f = join(x.data, 'sessions', `${x.sid}.json`);
  const corrupt = readFileSync(f, 'utf8').replace('"phase": "PLAN"', '"phase": "EXECUTE", "approved": true');
  require_write(f, corrupt);
  // EXECUTE without approval evidence → safety conflict → mutation denied
  assert.ok(denied(x.pre('Write', { file_path: 'a.ts' })));
});
function require_write(f, s) { spawnSync('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(f)}, ${JSON.stringify(s)})`]); }

test('MCP server: initialize, tools/list, tools/call', async () => {
  const child = spawn('node', [MCP]);
  const lines = [];
  child.stdout.on('data', d => lines.push(...String(d).split('\n').filter(Boolean)));
  const send = m => child.stdin.write(JSON.stringify(m) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'forge_qa_scope', arguments: {} } });
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} } });
  await new Promise(r => setTimeout(r, 400));
  child.kill();
  const byId = Object.fromEntries(lines.map(l => JSON.parse(l)).map(m => [m.id, m]));
  assert.equal(byId[1].result.serverInfo.name, 'forge');
  assert.deepEqual(byId[2].result.tools.map(t => t.name), ['forge_execution_done', 'forge_qa_scope', 'forge_qa_submit', 'forge_delivery_submit']);
  const qaTests = byId[2].result.tools.find(t => t.name === 'forge_qa_submit').inputSchema.properties.topicResults.items.properties.tests.items;
  assert.deepEqual(qaTests.required, ['testId', 'actual', 'status', 'evidence', 'severity']);
  assert.match(byId[3].result.content[0].text, /Forge received forge_qa_scope/);
  assert.equal(byId[4].error.code, -32602);
  assert.equal(Object.keys(byId).length, 4); // notification got no reply
});

test('plugin layout: manifest, hooks, command, agents with Claude Code frontmatter', () => {
  const manifest = JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'forge');
  const hooks = JSON.parse(readFileSync(join(PLUGIN, 'hooks', 'hooks.json'), 'utf8')).hooks;
  for (const e of ['SessionStart', 'UserPromptExpansion', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop']) assert.ok(hooks[e], e);
  assert.match(readFileSync(join(PLUGIN, 'commands', 'forge.md'), 'utf8'), /disable-model-invocation: true/);
  const agents = readdirSync(join(PLUGIN, 'agents'));
  assert.deepEqual([...agents].sort(), ['forge-code-reviewer.md', 'forge-plan-critic.md']);
  const reviewer = readFileSync(join(PLUGIN, 'agents', 'forge-code-reviewer.md'), 'utf8');
  assert.match(reviewer, /tools: Read, Grep, Glob\n/);
  assert.match(reviewer, /description: Forge · Independent diff-scoped code reviewer/);
  // models follow the profile the plugin was built with (FORGE_MODELS, default rigor)
  const profile = JSON.parse(readFileSync(join(ROOT, 'agents', 'roles.json'), 'utf8')).profiles[process.env.FORGE_MODELS || 'rigor'];
  for (const a of agents) {
    const body = readFileSync(join(PLUGIN, 'agents', a), 'utf8');
    assert.match(body, new RegExp(`model: ${profile[a.replace(/\.md$/, '')]}\\n`), a);
    assert.doesNotMatch(body, /\bOMP\b|local:\/\/|xd:\/\//, a);
  }
  const market = JSON.parse(readFileSync(join(PLUGIN, '..', '..', '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.equal(market.plugins[0].source, './plugins/forge');
});

test('Stop in EXECUTE without forge_execution_done: bounded reminders, then a pause for the user', () => {
  const x = env(); toApproved(x, x.sid);
  assert.match(x.run('Stop', {}).reason, /turn ended without forge_execution_done/);
  assert.equal(x.run('Stop', {}).decision, 'block');
  const paused = x.run('Stop', {});
  assert.equal(paused.decision, undefined);
  assert.match(paused.systemMessage, /execution paused[\s\S]*note: <text>/);
  assert.equal(x.state().phase, 'EXECUTE');
});

test('UserPromptSubmit during an approved run: plain text blocked, note: keeps approval, steer: re-plans', () => {
  const x = env(); toApproved(x, x.sid);
  const blocked = x.run('UserPromptSubmit', { prompt: 'also add CSV' });
  assert.equal(blocked.decision, 'block'); assert.match(blocked.reason, /steer: <text>[\s\S]*note: <text>[\s\S]*\/forge off/);
  assert.equal(x.state().approved, true);
  assert.match(ctx(x.run('UserPromptSubmit', { prompt: 'note: use UTC' })), /clarification during EXECUTE/);
  assert.equal(x.state().approved, true);
  const steer = x.run('UserPromptSubmit', { prompt: 'steer: also export CSV' });
  assert.match(fullCtx(steer), /FORGE STEERING[\s\S]*ExitPlanMode/);
  assert.match(steer.systemMessage, /EXECUTE → PLAN/);
  assert.equal(x.state().phase, 'PLAN'); assert.equal(x.state().approved, false);
});

test('Forge tools are recognized only from this plugin\'s own MCP server', async () => {
  const { canonicalTool } = await import(pathToFileURL(HOOK).href);
  assert.equal(canonicalTool(`${P}forge_qa_submit`), 'forge.qa_submit');
  assert.equal(canonicalTool(`${P}forge_execution_done`), 'forge.execution_done');
  assert.equal(canonicalTool('mcp__evil__forge_qa_submit'), 'other');
  assert.equal(canonicalTool(`mcp__evil__${P}forge_qa_submit`), 'other');
  const x = env(); toApproved(x, x.sid);
  x.pre('mcp__evil__forge_execution_done', EXECUTION_DONE);
  x.post('mcp__evil__forge_execution_done', EXECUTION_DONE, {});
  assert.equal(x.state().executionDone, false);
});

test('QA through hooks: an approved plan command may run; format errors come back for correction', () => {
  const plan = PLAN.replace('- node test: TC-001 and TC-002 pass', '- `make verify-booking` passes TC-001 and TC-002');
  const x = env();
  x.forge('Build a booking system'); x.pre('ExitPlanMode', { plan }); x.post('ExitPlanMode', { plan }, {});
  x.done(); x.run('Stop', {});
  assert.equal(x.state().phase, 'QA');
  assert.deepEqual(x.pre('Bash', { command: 'make verify-booking' }), {});
  assert.ok(denied(x.pre('Bash', { command: 'make deploy' })));
  x.agent('forge-code-reviewer');
  const partial = JSON.parse(JSON.stringify(MINIMAL_SUBMISSION)); partial.topicResults.pop();
  const r = x.pre(`${P}forge_qa_submit`, partial);
  assert.ok(denied(r)); assert.match(r.hookSpecificOutput.permissionDecisionReason, /NOT recorded[\s\S]*TC-002: missing/);
  assert.equal(x.state().qaResubmits, 1); assert.equal(x.state().qaStatus, null);
});

test('corrupt state file: mutations denied naming the file, reads allowed, /forge off resets', () => {
  const x = env(); x.forge('Build a booking system');
  const f = join(x.data, 'sessions', `${x.sid}.json`);
  writeFileSync(f, '{ not json');
  const w = x.pre('Write', { file_path: 'a.ts' });
  assert.ok(denied(w));
  assert.ok(w.hookSpecificOutput.permissionDecisionReason.includes(f));
  assert.match(w.hookSpecificOutput.permissionDecisionReason, /\/forge off/);
  assert.deepEqual(x.pre('Read', { file_path: 'a.ts' }), {});
  const stop = x.run('Stop', {});
  assert.equal(stop.decision, undefined); assert.match(stop.systemMessage, /corrupt/);
  x.forge('off');
  assert.equal(x.state().active, false);
  assert.deepEqual(x.pre('Write', { file_path: 'a.ts' }), {});
});

test('state lock: a stale lock of a live owner is never taken; a dead owner\'s is', async () => {
  const x = env(); x.forge('Build a booking system');
  const lock = join(x.data, 'locks', `${x.sid}.lock`);
  const old = new Date(Date.now() - 60_000);
  const plant = pid => { mkdirSync(lock, { recursive: true }); writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid, token: `t${pid}` })); utimesSync(lock, old, old); };
  plant(process.pid); // this test process: alive
  let finished = false;
  const child = new Promise((resolve, reject) => {
    const c = spawn('node', [HOOK, 'PreToolUse'], { env: { ...process.env, FORGE_DATA_DIR: x.data } });
    let out = ''; c.stdout.on('data', d => { out += d; });
    c.on('close', code => { finished = true; code === 0 ? resolve(out) : reject(new Error(`exit ${code}`)); });
    c.stdin.end(JSON.stringify({ session_id: x.sid, cwd: x.cwd, hook_event_name: 'PreToolUse', permission_mode: 'plan', tool_name: 'Write', tool_input: { file_path: 'a.ts' } }));
  });
  await new Promise(r => setTimeout(r, 800));
  assert.equal(finished, false);
  assert.equal(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).token, `t${process.pid}`);
  rmSync(lock, { recursive: true });
  assert.ok(denied(JSON.parse(await child))); // proceeded once the owner released
  const deadPid = Number(spawnSync('node', ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
  plant(deadPid);
  const started = Date.now();
  assert.match(ctx(x.forge('status')), /Forge: PLAN/);
  assert.ok(Date.now() - started < 5000);
  assert.equal(existsSync(lock), false);
});

test('ExitPlanMode needs the plan-mode plan file; Forge keeps its own copy in the data folder', () => {
  const x = env();
  x.forge('Build a booking system');
  const inline = x.run('PreToolUse', { tool_name: 'ExitPlanMode', tool_input: { plan: PLAN }, noPlanFile: true });
  assert.ok(denied(inline));
  assert.match(inline.hookSpecificOutput.permissionDecisionReason, /only from the plan file/);
  assert.deepEqual(x.pre('ExitPlanMode', { plan: PLAN }), {});
  const copy = join(x.data, 'plans', `${x.state().slug}-plan.md`);
  assert.equal(x.state().planPath, copy);
  assert.equal(readFileSync(copy, 'utf8'), PLAN);
});

// End-to-end: runs the BUILT plugin (dist/) exactly as Claude Code would —
// one `node forge-hook.mjs <Event>` process per hook, JSON on stdin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLAN, SUBMISSION } from '../../../core-tests/fixtures.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PLUGIN = join(ROOT, 'dist', 'claude-code', 'forge-marketplace', 'plugins', 'forge');
const HOOK = join(PLUGIN, 'bin', 'forge-hook.mjs');
const MCP = join(PLUGIN, 'bin', 'forge-mcp.mjs');
const P = 'mcp__plugin_forge_forge__';
const SUMMARY = { baseline: 'Goal: bookings with approvals. Scope: create + approve. Acceptance: both flows work.', findings: [{ severity: 'LOW', title: 'naming' }] };
assert.ok(existsSync(HOOK), 'run `npm run build` first');

const TEMP_DIRS = [];
process.on('exit', () => { for (const d of TEMP_DIRS) rmSync(d, { recursive: true, force: true }); });
function env() {
  const data = mkdtempSync(join(tmpdir(), 'forge-cc-'));
  const cwd = mkdtempSync(join(tmpdir(), 'forge-proj-'));
  TEMP_DIRS.push(data, cwd);
  let n = 0;
  const sid = `sess-${Math.random().toString(36).slice(2)}`;
  const run = (event, payload, session = sid) => {
    const r = spawnSync('node', [HOOK, event], { input: JSON.stringify({ session_id: session, cwd, hook_event_name: event, permission_mode: 'plan', ...payload }), env: { ...process.env, FORGE_DATA_DIR: data }, encoding: 'utf8' });
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
  const summary = (input = SUMMARY) => {
    const p = pre(`${P}forge_requirement_summary`, input);
    assert.notEqual(p.hookSpecificOutput?.permissionDecision, 'deny', JSON.stringify(p));
    return post(`${P}forge_requirement_summary`, input, { content: [{ type: 'text', text: 'Forge received forge_requirement_summary' }] });
  };
  return { data, cwd, sid, run, pre, post, forge, state, agent, summary };
}
const ctx = out => out.hookSpecificOutput?.additionalContext ?? '';
const denied = out => out.hookSpecificOutput?.permissionDecision === 'deny';

test('sessions without Forge are untouched (no state file, no decisions)', () => {
  const x = env();
  assert.deepEqual(x.pre('Bash', { command: 'git push' }), {});
  assert.deepEqual(x.pre('Write', { file_path: 'a.ts' }), {});
  assert.equal(existsSync(join(x.data, 'sessions')), false);
});

test('full workflow through real hook processes: /forge → specialists → ExitPlanMode → QA → delivery', () => {
  const x = env();
  const start = x.forge('Build a booking system');
  assert.match(ctx(start), /Forge started\. Gates: requirement \(one forge-requirement pass\)/);
  assert.match(ctx(start), /GATE 1\/4: REQUIREMENT — single-pass analysis/);
  assert.match(ctx(start), /forge:forge-requirement/); // footer mapping
  assert.equal(x.state().phase, 'REQUIREMENT');
  // pre-approval guards
  assert.ok(denied(x.pre('Write', { file_path: join(x.cwd, 'a.ts'), content: 'x' })));
  assert.ok(denied(x.pre('Bash', { command: 'git commit -am wip' })));
  assert.deepEqual(x.pre('Read', { file_path: 'a' }), {});
  // requirement: one forge-requirement pass, then the orchestrator's summary
  assert.ok(denied(x.pre(`${P}forge_requirement_summary`, SUMMARY))); // report missing
  assert.match(ctx(x.agent('forge-requirement')), /FORGE REQUIREMENT — report received/);
  assert.ok(denied(x.pre('Agent', { subagent_type: 'forge:forge-requirement', prompt: 'again' }))); // one counted pass
  assert.equal(x.state().phase, 'REQUIREMENT');
  const toPlan = x.summary();
  assert.match(ctx(toPlan), /requirement summary recorded[\s\S]*GATE 2\/4: PLAN[\s\S]*Use this requirement synthesis[\s\S]*ExitPlanMode/);
  assert.equal(x.state().phase, 'PLAN');
  x.agent('forge-planner');
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
  x.agent('forge-executor', 'Implemented booking.ts');
  const stop = x.run('Stop', { stop_hook_active: false, last_assistant_message: 'done' });
  assert.equal(stop.decision, 'block'); assert.match(stop.reason, /QA REVIEW|POST-EXECUTION|READ THIS FILE/);
  assert.equal(x.state().phase, 'QA');
  assert.ok(denied(x.pre('Edit', { file_path: 'a.ts' })));
  assert.match(ctx(x.post(`${P}forge_qa_scope`, {}, {})), /QA scope/);
  x.agent('forge-qa'); x.agent('forge-code-reviewer');
  assert.deepEqual(x.pre(`${P}forge_qa_submit`, SUBMISSION), {});
  assert.match(ctx(x.post(`${P}forge_qa_submit`, SUBMISSION, {})), /QA GATE: PASS/);
  assert.equal(x.state().phase, 'QA');
  x.agent('forge-delivery');
  const delivered = x.post(`${P}forge_delivery_submit`, { subject: 'feat(booking): add approvals', body: '- approvals' }, {});
  assert.match(ctx(delivered), /COPY THIS COMMIT MESSAGE/);
  assert.equal(x.state().phase, 'QA');
  assert.equal(x.state().active, false);
  assert.ok(readdirSync(join(x.data, 'reports', x.sid)).length > 0);
});

test('parallel Agent hooks do not lose updates (state lock)', async () => {
  const x = env();
  toApproved(x, x.sid);
  x.agent('forge-executor', 'Implemented booking.ts');
  x.run('Stop', { stop_hook_active: false, last_assistant_message: 'done' });
  assert.equal(x.state().phase, 'QA'); // QA: 2 independent specialists in one batch
  const names = ['forge-qa', 'forge-code-reviewer'];
  const runAsync = (event, payload) => new Promise((resolve, reject) => {
    const child = spawn('node', [HOOK, event], { env: { ...process.env, FORGE_DATA_DIR: x.data } });
    let out = ''; child.stdout.on('data', d => { out += d; });
    child.on('close', code => code === 0 ? resolve(out) : reject(new Error(`exit ${code}`)));
    child.stdin.end(JSON.stringify({ session_id: x.sid, cwd: x.cwd, hook_event_name: event, permission_mode: 'plan', ...payload }));
  });
  await Promise.all(names.map((n, i) => runAsync('PreToolUse', { tool_name: 'Agent', tool_input: { subagent_type: `forge:${n}` }, tool_use_id: `p${i}` })));
  assert.deepEqual([...x.state().gateAgentsSpawned.QA].sort(), [...names].sort());
  await Promise.all(names.map((n, i) => runAsync('SubagentStop', { agent_id: `bg${i}`, agent_type: `forge:${n}`, last_assistant_message: 'ok report' })));
  assert.deepEqual([...x.state().gateAgents.QA].sort(), [...names].sort());
});

test('specialist subagents are read-only; executor has no shell', () => {
  const x = env();
  x.forge('Build a booking system');
  const analyst = { agent_id: 'a1', agent_type: 'forge:forge-requirement' };
  assert.ok(denied(x.pre('Write', { file_path: 'a.ts' }, analyst)));
  assert.ok(denied(x.pre('Bash', { command: 'npm test' }, analyst)));
  assert.deepEqual(x.pre('Read', { file_path: 'a.ts' }, analyst), {});
  const exec = { agent_id: 'a2', agent_type: 'forge:forge-executor' };
  assert.ok(denied(x.pre('Bash', { command: 'ls' }, exec)));
});

test('/forge status and off', () => {
  const x = env();
  assert.match(ctx(x.forge('status')), /Forge: inactive/);
  x.forge('Build CRM');
  const status = ctx(x.forge('status'));
  assert.match(status, /Forge: REQUIREMENT \| requirement: Build CRM/);
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
  assert.equal(x.state().phase, 'REQUIREMENT'); assert.equal(x.state().requirement, 'quick Rename a label');
  assert.match(ctx(cmd('forge-approve')), /Nothing to approve/);
  cmd('forge-off');
  assert.equal(x.state().active, false);
  cmd('forge', 'Build CRM');
  assert.equal(x.state().active, true);
  assert.deepEqual(cmd('forge-unknownthing'), { hookSpecificOutput: { hookEventName: 'UserPromptExpansion', additionalContext: ctx(cmd('forge-unknownthing')) } });
});

test('every generated command is human-only and has a description', () => {
  const dir = join(PLUGIN, 'commands');
  const files = readdirSync(dir);
  const expected = ['forge', 'forge-status', 'forge-resume', 'forge-trace', 'forge-approve', 'forge-plan', 'forge-qa', 'forge-rework', 'forge-delivery', 'forge-report', 'forge-agents', 'forge-off'];
  assert.deepEqual([...files].sort(), expected.map(n => `${n}.md`).sort());
  for (const n of expected) {
    const body = readFileSync(join(dir, `${n}.md`), 'utf8');
    assert.match(body, /disable-model-invocation: true/); assert.match(body, /^---\ndescription: Forge/);
  }
});

function toApproved(x, session) {
  const run = (event, payload) => x.run(event, payload, session);
  const agent = name => {
    const input = { subagent_type: `forge:${name}` };
    run('PreToolUse', { tool_name: 'Agent', tool_input: input });
    run('SubagentStop', { agent_id: `x-${name}-${Math.random()}`, agent_type: `forge:${name}`, last_assistant_message: 'report' });
    run('PostToolUse', { tool_name: 'Agent', tool_input: input, tool_response: { status: 'async_launched' } });
  };
  run('UserPromptExpansion', { command_name: 'forge', command_args: 'Build a booking system' });
  agent('forge-requirement');
  run('PreToolUse', { tool_name: `${P}forge_requirement_summary`, tool_input: SUMMARY });
  run('PostToolUse', { tool_name: `${P}forge_requirement_summary`, tool_input: SUMMARY, tool_response: {} });
  agent('forge-planner');
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
  toApproved(x, x.sid);
  x.pre('Write', { file_path: 'a.ts' }, { agent_id: 'e1', agent_type: 'forge:forge-executor' });
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
  assert.ok(events.some(e => e.hook === 'SubagentStop' && e.summaryRequested === true));
  assert.ok(events.every(e => !('stepBefore' in e) && !('stepAfter' in e) && !('mode' in e)));
  assert.doesNotMatch(log, /BIZ-001/); // never logs plan/file contents
});

test('background agent run (the bug seen live): no false "no report", handback allowed, completion via SubagentStop', () => {
  const x = env();
  x.forge('อยากสร้างโปรแกรมคำนวณอายุ');
  const input = { subagent_type: 'forge:forge-requirement', description: 'Requirement intake', prompt: 'x', run_in_background: true };
  x.pre('Agent', input);
  const launched = x.post('Agent', input, { status: 'async_launched', agentId: 'bg-1' });
  assert.doesNotMatch(ctx(launched), /no report/);
  assert.deepEqual(x.run('Stop', { stop_hook_active: false }), {}); // waiting for the background agent
  const sub = { agent_id: 'bg-1', agent_type: 'forge:forge-requirement' };
  assert.deepEqual(x.pre('SubagentHandback', { report: 'Baseline: age calculator; [MEDIUM][assumption] Gregorian dates' }, sub), {});
  assert.deepEqual(x.pre('SendMessage', { to: 'bg-1', message: 'status?' }), {});
  x.run('SubagentStop', { ...sub, last_assistant_message: 'Handed back.', stop_hook_active: false });
  assert.deepEqual(x.state().gateAgents.REQUIREMENT, ['forge-requirement']);
  const next = x.run('UserPromptSubmit', { prompt: 'Agent "Requirement intake" finished' });
  assert.match(ctx(next), /FORGE REQUIREMENT — report received/);
});

test('plan mode plan file: writing it is allowed, project files stay blocked, ExitPlanMode reads it', () => {
  const x = env();
  x.forge('Build a booking system');
  x.agent('forge-requirement'); x.summary(); x.agent('forge-planner');
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
  assert.match(readFileSync(file, 'utf8'), /GATE 1\/4/);
});

test('plan approved with "clear context": a new session inherits EXECUTING within 2 minutes', () => {
  const x = env();
  x.forge('Build a booking system');
  x.agent('forge-requirement'); x.summary(); x.agent('forge-planner');
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
  const corrupt = readFileSync(f, 'utf8').replace('"phase": "REQUIREMENT"', '"phase": "EXECUTE", "approved": true');
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
  assert.deepEqual(byId[2].result.tools.map(t => t.name), ['forge_requirement_summary', 'forge_qa_scope', 'forge_qa_submit', 'forge_delivery_submit']);
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
  assert.deepEqual([...agents].sort(), ['forge-code-reviewer', 'forge-delivery', 'forge-executor', 'forge-planner', 'forge-qa', 'forge-requirement'].map(a => `${a}.md`));
  const exec = readFileSync(join(PLUGIN, 'agents', 'forge-executor.md'), 'utf8');
  assert.match(exec, /tools: Read, Grep, Glob, Edit, Write/);
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

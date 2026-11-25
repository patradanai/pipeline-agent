#!/usr/bin/env node
/**
 * Forge — Claude Code adapter.
 * One process per hook event: read the event JSON from stdin, translate it to
 * a normalized Forge event, run the shared engine, persist state, print the
 * Claude Code hook JSON. Usage: forge-hook.mjs <HookEventName>
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, '..');
const CORE = join(PLUGIN_ROOT, 'core');
const DATA = process.env.FORGE_DATA_DIR || process.env.CLAUDE_PLUGIN_DATA || join(homedir(), '.claude', 'forge-data');
const MAX_CONTEXT = 9000; // Claude Code caps additionalContext at 10,000 chars
const MCP_PREFIX = 'mcp__plugin_forge_forge__';

const TOOL_MAP = {
  Read: 'read', NotebookRead: 'read', Grep: 'grep', Glob: 'glob', LS: 'ls',
  WebFetch: 'web', WebSearch: 'web', AskUserQuestion: 'ask', TodoWrite: 'todo',
  Skill: 'read', ToolSearch: 'read', BashOutput: 'read', ListMcpResourcesTool: 'read', ReadMcpResourceTool: 'read',
  // Agent/task coordination: no filesystem or repository effect.
  SendMessage: 'coord', SubagentHandback: 'coord', TaskOutput: 'coord', TaskStop: 'coord', TaskCreate: 'coord',
  TaskUpdate: 'coord', TaskList: 'coord', TaskGet: 'coord', ScheduleWakeup: 'coord',
  Task: 'agent', Agent: 'agent',
  Bash: 'bash', PowerShell: 'bash', KillShell: 'bash', Monitor: 'bash',
  Write: 'write', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit',
  EnterPlanMode: 'plan.enter', ExitPlanMode: 'plan.submit',
};
export function canonicalTool(name) {
  const n = String(name ?? '');
  if (TOOL_MAP[n]) return TOOL_MAP[n];
  // Only this plugin's own MCP server ("forge" in .mcp.json) provides the Forge tools.
  const forge = n.startsWith(MCP_PREFIX) && n.slice(MCP_PREFIX.length).match(/^forge_(execution_done|qa_scope|qa_submit|delivery_submit)$/);
  if (forge) return `forge.${forge[1]}`;
  return 'other';
}

/** Collect the text a subagent returned, whatever shape tool_response has. */
export function responseText(value, depth = 0) {
  if (value == null || depth > 6) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(v => responseText(v, depth + 1)).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    for (const key of ['text', 'result', 'content', 'output', 'message']) {
      if (key in value) { const t = responseText(value[key], depth + 1); if (t) return t; }
    }
  }
  return '';
}

const SUBCOMMAND_PREFIX = { resume: 'resume ', trace: 'trace ', planreview: 'planreview ' };
/** "/forge <args>", "/forge-status", "/forge:forge-resume 2" → engine command text. Null for other commands. */
export function commandText(commandName, commandArgs) {
  const m = String(commandName ?? '').match(/^(?:forge:)?forge(?:-([a-z]+))?$/);
  if (!m) return null;
  const args = String(commandArgs ?? '').trim();
  if (!m[1]) return args;
  const prefix = SUBCOMMAND_PREFIX[m[1]];
  if (prefix) return `${prefix}${args}`.trim();
  return m[1];
}

/** Every string inside a tool input (handback field names vary by host version). */
export function allStrings(value, depth = 0, out = []) {
  if (value == null || depth > 6) return out;
  if (typeof value === 'string') { if (value.trim()) out.push(value); return out; }
  if (Array.isArray(value)) { for (const v of value) allStrings(v, depth + 1, out); return out; }
  if (typeof value === 'object') for (const v of Object.values(value)) allStrings(v, depth + 1, out);
  return out;
}

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
/** The plan file Claude Code assigns in plan mode: a .md under the config plans dir,
 * or (custom plansDirectory) a .md in a "plans" folder outside the project. */
export function isHostPlanFile(filePath, cwd, permissionMode) {
  if (permissionMode !== 'plan' || typeof filePath !== 'string' || !isAbsolute(filePath) || !/\.md$/i.test(filePath)) return false;
  const p = resolve(filePath);
  if (p.startsWith(resolve(CONFIG_DIR, 'plans') + sep)) return true;
  const project = cwd ? resolve(cwd) + sep : null;
  return Boolean(project) && !p.startsWith(project) && p.split(sep).includes('plans');
}

const safeId = id => String(id ?? 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128) || 'unknown';
const sessionFile = sid => join(DATA, 'sessions', `${safeId(sid)}.json`);
const projectPointer = cwd => join(DATA, 'projects', `${createHash('sha256').update(String(cwd ?? '')).digest('hex').slice(0, 24)}.json`);

function readJson(path) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } }
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

const LOCK_STALE_MS = 10_000;
const LOCK_REFRESH_MS = 2_000;
const lockOwner = lock => { try { return JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')); } catch { return null; } };
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err?.code !== 'ESRCH'; }
}
/** A lock may be broken only when it was not refreshed for LOCK_STALE_MS AND its owner is gone
 * (dead pid or unreadable owner file). A slow but live holder keeps it. */
function breakStaleLock(lock) {
  let st;
  try { st = statSync(lock); } catch { return true; } // released meanwhile: retry at once
  if (Date.now() - st.mtimeMs <= LOCK_STALE_MS) return false;
  const owner = lockOwner(lock);
  if (owner && pidAlive(owner.pid)) return false;
  // Rename first (atomic), so two waiters never both delete; then make sure we moved the lock we judged.
  const moved = `${lock}.stale-${randomUUID()}`;
  try { renameSync(lock, moved); } catch { return false; }
  const judged = lockOwner(moved);
  if ((judged?.token ?? null) !== (owner?.token ?? null)) { try { renameSync(moved, lock); } catch {} return false; }
  rmSync(moved, { recursive: true, force: true });
  return true;
}

/** Parallel tool calls spawn parallel hooks; serialize state read-modify-write per session.
 * The lock dir holds owner.json {pid, token}; the holder refreshes its mtime while it works. */
async function withLock(sid, fn) {
  const lock = join(DATA, 'locks', `${safeId(sid)}.lock`);
  const token = randomUUID();
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 8000;
  for (;;) {
    try { mkdirSync(lock); writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token }), { mode: 0o600 }); break; }
    catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      if (breakStaleLock(lock)) continue;
      if (Date.now() > deadline) throw new Error('Forge state lock timeout');
      await new Promise(r => setTimeout(r, 25 + Math.random() * 50));
    }
  }
  const refresh = setInterval(() => { try { if (lockOwner(lock)?.token === token) { const now = new Date(); utimesSync(lock, now, now); } } catch {} }, LOCK_REFRESH_MS);
  refresh.unref();
  try { return await fn(); } finally {
    clearInterval(refresh);
    try { if (lockOwner(lock)?.token === token) rmSync(lock, { recursive: true, force: true }); } catch {}
  }
}

/** Gate skills ship with disable-model-invocation, so Claude cannot load them by name: Forge inlines
 * the lead-facing ones from <plugin>/skills/<name>/SKILL.md. Missing or invalid skills are skipped. */
function loadSkills(names, core) {
  const out = [];
  for (const name of names) {
    if (!core.SKILL_NAME_PATTERN.test(String(name))) continue;
    let content;
    try { content = readFileSync(join(PLUGIN_ROOT, 'skills', name, 'SKILL.md'), 'utf8'); } catch { continue; }
    if (core.skillAudience(content) === 'specialist') continue;
    out.push({ name, content });
  }
  return out;
}

/** The session state file exists but is not valid JSON: fail closed for anything that can change things. */
function corruptStateOutput(hookEvent, event, file, readOnlyTools, sid) {
  const fix = `Forge state file ${file} is corrupt (not valid JSON), so Forge cannot enforce its gates. Run /forge off to reset this session's Forge state, or fix or delete that file.`;
  if (hookEvent === 'PreToolUse') {
    if (readOnlyTools.includes(event.tool)) return {};
    return render(hookEvent, { decision: 'deny', reason: `${fix} Ask the user to do this; do not edit the file yourself.` }, sid);
  }
  return render(hookEvent, { message: fix }, sid);
}

function boundedContext(text, sid) {
  if (!text || text.length <= MAX_CONTEXT) return text;
  const path = join(DATA, 'context', `${safeId(sid)}-${Date.now()}.md`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, text, { mode: 0o600 });
  return `[FORGE] The full Forge instruction is long. READ THIS FILE COMPLETELY before acting: ${path}\n\nBeginning:\n${text.slice(0, 1800)}\n…`;
}

function translate(hookEvent, input) {
  const actor = input.agent_id ? { kind: 'sub', agent: input.agent_type ?? null } : { kind: 'main', agent: null };
  if (input.agent_id) actor.agentId = input.agent_id;
  const base = { rawTool: input.tool_name, tool: canonicalTool(input.tool_name), input: input.tool_input ?? {}, actor, cwd: input.cwd, permissionMode: input.permission_mode };
  if ((base.tool === 'write' || base.tool === 'edit') && actor.kind === 'main' && isHostPlanFile(base.input.file_path, input.cwd, input.permission_mode)) {
    base.tool = 'plan.write'; base.planFile = resolve(base.input.file_path);
  }
  if (base.tool === 'plan.submit') {
    // Claude Code injects the plan-mode file path; PostToolUse carries the text the user approved.
    const file = base.input.planFilePath ?? input.tool_response?.filePath;
    if (isHostPlanFile(file, input.cwd, 'plan')) base.planFile = resolve(file);
    if (typeof input.tool_response?.plan === 'string') base.approvedPlan = input.tool_response.plan;
  }
  if (base.tool === 'coord') base.inputText = allStrings(input.tool_input).join('\n');
  switch (hookEvent) {
    case 'PreToolUse': return { type: 'tool.pre', ...base };
    case 'PostToolUse': return { type: 'tool.post', ...base, output: responseText(input.tool_response) };
    case 'PostToolUseFailure': return { type: 'tool.fail', ...base };
    case 'Stop': return { type: 'turn.end', stopHookActive: input.stop_hook_active === true };
    case 'SubagentStop': return { type: 'agent.stop', agent: input.agent_type ?? null, agentId: input.agent_id ?? null, report: typeof input.last_assistant_message === 'string' ? input.last_assistant_message : '', actor };
    case 'UserPromptSubmit': return { type: 'prompt', text: typeof input.prompt === 'string' ? input.prompt : '' };
    case 'SessionStart': return { type: 'session.start', source: input.source };
    case 'UserPromptExpansion': {
      const text = commandText(input.command_name, input.command_args);
      return text == null ? null : { type: 'command', text };
    }
    default: return null;
  }
}

function render(hookEvent, out, sid) {
  const json = {};
  const context = boundedContext(out.context, sid);
  if (hookEvent === 'PreToolUse') {
    if (out.decision === 'deny') json.hookSpecificOutput = { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: out.reason };
    else if (context) json.hookSpecificOutput = { hookEventName: 'PreToolUse', additionalContext: context };
  } else if (hookEvent === 'Stop' || hookEvent === 'SubagentStop') {
    if (out.continueReason) { json.decision = 'block'; json.reason = boundedContext(out.continueReason, sid); }
  } else if (hookEvent === 'UserPromptSubmit' && out.decision === 'deny') {
    json.decision = 'block'; json.reason = out.reason;
  } else if (hookEvent === 'UserPromptExpansion') {
    const text = [out.message ? `Forge: ${out.message}` : '', context ?? ''].filter(Boolean).join('\n\n');
    if (text) json.hookSpecificOutput = { hookEventName: 'UserPromptExpansion', additionalContext: boundedContext(text, sid) };
  } else if (context) {
    json.hookSpecificOutput = { hookEventName: hookEvent, additionalContext: context };
  }
  if (out.message && hookEvent !== 'UserPromptExpansion') json.systemMessage = `Forge: ${out.message}`;
  return json;
}

/** Opt-in event log for live end-to-end validation (/forge-trace on). Never logs tool contents. */
function traceEvent(hookEvent, input, event, before, after, out) {
  try {
    const line = {
      at: new Date().toISOString(), session: input.session_id, hook: hookEvent,
      tool: input.tool_name ?? null, canonical: event?.tool ?? null,
      agentType: input.agent_type ?? null, agentId: input.agent_id ? 'yes' : null,
      subagentType: input.tool_input?.subagent_type ?? null,
      permissionMode: input.permission_mode ?? null, source: input.source ?? null,
      command: input.command_name ?? null, args: input.command_name ? String(input.command_args ?? '').slice(0, 40) : null,
      reportChars: typeof input.last_assistant_message === 'string' ? input.last_assistant_message.length : null,
      responseKeys: input.tool_response && typeof input.tool_response === 'object' ? Object.keys(input.tool_response).slice(0, 8) : null,
      phaseBefore: before?.phase ?? null, phaseAfter: after?.phase ?? null,
      approvedAfter: after?.approved ?? null, planValidAfter: after?.planValid ?? null,
      activeAfter: after?.active ?? null, qaStatus: after?.qaStatus ?? null,
      reworkCycles: after?.reworkCycles ?? null,
      decision: out?.decision ?? (out?.continueReason ? 'continue' : null), reason: out?.reason ? String(out.reason).slice(0, 160) : null,
      context: Boolean(out?.context || out?.continueReason), carried: after?.carriedFromSession ? true : null, adopted: after?.adoptedFromSession ? true : null,
    };
    mkdirSync(join(DATA, 'trace'), { recursive: true, mode: 0o700 });
    appendFileSync(join(DATA, 'trace', 'events.jsonl'), JSON.stringify(line) + '\n', { mode: 0o600 });
  } catch { /* tracing must never affect Forge */ }
}

/** Forge workflows saved by OTHER sessions of the same project directory, newest first. */
function listProjectWorkflows(cwd, currentSid) {
  const dir = join(DATA, 'sessions');
  let names = [];
  try { names = readdirSync(dir).filter(n => n.endsWith('.json')); } catch { return []; }
  return names.map(n => readJson(join(dir, n))).filter(r => r && r.sessionId !== currentSid && r.cwd === cwd && r.state?.phase)
    .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt))).slice(0, 10)
    .map(r => ({ sessionId: r.sessionId, savedAt: r.savedAt, state: r.state }));
}

/** Claude Code may start a fresh session when the user approves a plan with "clear context". */
function carryAcrossClear(input, normalizeForgeState) {
  if (input.source !== 'clear' || existsSync(sessionFile(input.session_id))) return null;
  const pointer = readJson(projectPointer(input.cwd));
  if (!pointer || pointer.sessionId === input.session_id || Date.now() - Date.parse(pointer.at) > 120_000) return null;
  const prev = normalizeForgeState(readJson(sessionFile(pointer.sessionId))?.state);
  const reviewing = prev?.phase === 'PLAN' && prev.planWritten && prev.planValid && !prev.approved;
  const executing = prev?.phase === 'EXECUTE' && prev.approved && prev.planValid && prev.approvedPlanHash;
  if (!prev?.active || (!reviewing && !executing) || prev.slug !== pointer.slug) return null;
  return { ...prev, carriedFromSession: pointer.sessionId, recoveryAudit: [...(prev.recoveryAudit ?? []), { from: prev.phase, to: prev.phase, reason: 'claude-code-clear-context-handoff', reviewedBy: 'native-plan-review', at: new Date().toISOString() }].slice(-20) };
}

export async function main(hookEvent, raw) {
  const input = JSON.parse(raw || '{}');
  const sid = input.session_id;
  const event = translate(hookEvent, input);
  if (!event || !sid) return {};
  // Fast path: sessions without Forge state and non-Forge actors never load the engine.
  const forgeChild = event.actor?.kind === 'sub' && /(?:^|:)forge-[a-z-]+$/.test(String(event.actor.agent ?? ''));
  if (!existsSync(sessionFile(sid)) && event.type !== 'command' && !forgeChild && !(event.type === 'session.start' && ['clear', 'resume', 'fork', 'startup'].includes(input.source))) return {};

  const [{ createEngine, READ_ONLY_TOOLS }, workspace, { normalizeForgeState }, core] = await Promise.all([
    import(pathToFileURL(join(CORE, 'engine.mjs')).href),
    import(pathToFileURL(join(CORE, 'workspace.mjs')).href),
    import(pathToFileURL(join(CORE, 'forge-state.mjs')).href),
    import(pathToFileURL(join(CORE, 'core.mjs')).href),
  ]);
  return withLock(sid, async () => {
    const config = readJson(join(DATA, 'config.json')) ?? {};
    const file = sessionFile(sid);
    let record = null;
    if (existsSync(file)) {
      try { record = JSON.parse(readFileSync(file, 'utf8')); }
      catch {
        // /forge off overwrites the corrupt file with a tombstone; everything else fails closed.
        if (!(event.type === 'command' && core.parseCommand(event.text).type === 'cancel')) return corruptStateOutput(hookEvent, event, file, READ_ONLY_TOOLS, sid);
      }
    }
    let state = normalizeForgeState(record?.state ?? null);
    if (event.type === 'session.start' && !state) state = carryAcrossClear(input, normalizeForgeState);
    if (event.type === 'session.start' && !state) {
      // A forked/new session of a project with saved Forge work: point to /forge-resume (no state change).
      const others = listProjectWorkflows(input.cwd, sid).filter(w => w.state?.active || /_BLOCKED$|QA_FAILED/.test(w.state?.phase ?? ''));
      if (!others.length) return {};
      return render(hookEvent, { context: `Forge: ${others.length} unfinished Forge workflow(s) exist in other sessions of this project (latest: ${others[0].state.phase} — ${String(others[0].state.requirement).slice(0, 60)}). If the user wants to continue one, tell them about /forge-resume.` }, sid);
    }
    const reportDir = state?.slug ? join(DATA, 'reports', safeId(sid), safeId(state.slug)) : join(DATA, 'reports', safeId(sid));
    const save = (name, content) => { mkdirSync(reportDir, { recursive: true, mode: 0o700 }); const p = join(reportDir, name); writeFileSync(p, content, { mode: 0o600 }); return p; };
    const engine = createEngine({
      platform: 'claude-code',
      config,
      profile: {
        agentRef: n => `forge:${n}`,
        toolRef: n => `${MCP_PREFIX}${n}`,
        footer: `[Claude Code mapping] Reviewer (QA only): Agent tool with subagent_type "forge:forge-code-reviewer". Plan critic (only when plan review is on): subagent_type "forge:forge-plan-critic". Read-only research: subagent_type "Explore". Forge tools: ${MCP_PREFIX}forge_execution_done, ${MCP_PREFIX}forge_qa_scope, ${MCP_PREFIX}forge_qa_submit, ${MCP_PREFIX}forge_delivery_submit.`,
      },
      deps: {
        snapshotWorkingTree: workspace.snapshotWorkingTree,
        inspectWorkspaceScope: workspace.inspectWorkspaceScope,
        // Forge's own plan file, named like OMP's (<slug>-plan.md, <slug>-rework-<n>-plan.md).
        savePlan: (s, content) => {
          const p = join(DATA, 'plans', basename(core.forgePlanPath(s)).replace(/[^A-Za-z0-9._-]/g, '_'));
          mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
          writeFileSync(p, content, { mode: 0o600 });
          return p;
        },
        saveQaReport: (s, markdown, json) => { save('qa-report.json', JSON.stringify(json, null, 2) + '\n'); return save('qa-report.md', markdown); },
        saveDelivery: (s, markdown, commitMessage) => ({ deliveryPath: save('delivery.md', markdown), commitMessagePath: save('commit-message.txt', commitMessage) }),
        listWorkflows: () => listProjectWorkflows(input.cwd, sid),
        readPlanFile: path => { try { const st = statSync(path); return st.isFile() && st.size <= 1024 * 1024 ? readFileSync(path, 'utf8') : ''; } catch { return ''; } },
        traceInfo: () => `Data dir: ${DATA}\nTrace log: ${join(DATA, 'trace', 'events.jsonl')}\nCoverage report (in a terminal): node "${join(HERE, 'forge-coverage.mjs')}" --data "${DATA}"`,
        loadSkills: names => loadSkills(names, core),
      },
    });
    const { state: next, out } = engine.handle(state, event);
    if (config.trace || out.configUpdate?.trace) traceEvent(hookEvent, input, event, state, next, out);
    if (out.retireSession) {
      const other = sessionFile(out.retireSession);
      const rec = readJson(other);
      if (rec) writeJson(other, { ...rec, savedAt: new Date().toISOString(), state: { active: false, version: 9, cancelledSlug: rec.state?.slug, movedToSession: sid } });
    }
    if (out.configUpdate) writeJson(join(DATA, 'config.json'), { ...config, ...out.configUpdate });
    if (next !== state || state !== (record?.state ?? null) || (event.type === 'session.start' && next)) {
      writeJson(sessionFile(sid), { schema: 1, sessionId: sid, cwd: input.cwd, savedAt: new Date().toISOString(), state: next });
      if (next?.active && ((next.phase === 'PLAN' && next.planWritten && next.planValid && !next.approved) ||
          (next.phase === 'EXECUTE' && next.approved && next.planValid && next.approvedPlanHash))) {
        writeJson(projectPointer(input.cwd), { sessionId: sid, slug: next.slug, phase: next.phase, at: new Date().toISOString() });
      }
    }
    if (event.type === 'session.start' && next?.carriedFromSession && next.phase === 'PLAN' && !next.approved) {
      out.context = `${out.context ?? ''}\nThe context was cleared right after this plan was submitted, so Forge could not observe the approval. If the user approved the plan, ask them to type /forge approve; otherwise wait.`;
    }
    return render(hookEvent, out, sid);
  });
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

// stdout to a pipe is asynchronous on macOS: exiting before the write callback
// truncates large hook outputs (~8 KB) into invalid JSON.
const emit = obj => new Promise(done => process.stdout.write(JSON.stringify(obj), () => done()));

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const hookEvent = process.argv[2];
  let raw = '';
  try {
    raw = await readStdin();
    const json = await main(hookEvent, raw);
    if (json && Object.keys(json).length) await emit(json);
    process.exit(0);
  } catch (err) {
    // Fail closed only where a Forge workflow is active and the call could change things.
    let active = false;
    try { const input = JSON.parse(raw || '{}'); active = Boolean(readJson(sessionFile(input.session_id))?.state?.active); } catch {}
    if (hookEvent === 'PreToolUse' && active) {
      await emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Forge hook error (failing closed while a workflow is active): ${String(err?.message ?? err)}` } });
    } else {
      await emit({ systemMessage: `Forge hook error: ${String(err?.message ?? err)}` });
    }
    process.exit(0);
  }
}

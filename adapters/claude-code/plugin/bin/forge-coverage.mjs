#!/usr/bin/env node
/**
 * Forge live end-to-end coverage report.
 * Reads the trace log written while `/forge-trace on` was active and reports
 * which Forge flows were observed inside a real Claude Code session, plus the
 * host assumptions the adapter relies on.
 *
 *   node forge-coverage.mjs [--data <plugin data dir>] [--since <ISO time>] [--json]
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

function findDataDir() {
  const explicit = opt('--data') || process.env.FORGE_DATA_DIR || process.env.CLAUDE_PLUGIN_DATA;
  if (explicit) return explicit;
  const candidates = [join(homedir(), '.claude', 'forge-data')];
  const pluginData = join(homedir(), '.claude', 'plugins', 'data');
  try { for (const d of readdirSync(pluginData)) if (/forge/i.test(d)) candidates.push(join(pluginData, d)); } catch {}
  return candidates.find(d => existsSync(join(d, 'trace', 'events.jsonl'))) ?? null;
}

const data = findDataDir();
const file = data ? join(data, 'trace', 'events.jsonl') : null;
if (!file || !existsSync(file)) {
  console.error('No Forge trace found. In Claude Code run /forge-trace on, exercise the flows, then rerun with --data <dir> (shown by /forge-trace).');
  process.exit(2);
}
const since = opt('--since');
const events = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } })
  .filter(e => e && (!since || e.at >= since));

const forgeAgent = e => /(?:^|:)forge-[a-z-]+$/.test(String(e.subagentType ?? ''));
const has = pred => events.some(pred);
const moved = (from, to) => e => e.phaseBefore === from && e.phaseAfter === to;

export const CHECKS = [
  ['C01', 'Human /forge command reaches the hook', 'any scenario', has(e => e.hook === 'UserPromptExpansion' && e.phaseAfter === 'REQUIREMENT')],
  ['C02', 'Single forge-requirement report → summary requested', 'S1', has(e => e.hook === 'SubagentStop' && /forge-requirement$/.test(String(e.agentType ?? '')) && e.summaryRequested)],
  ['C03', 'Requirement summary accepted → PLANNING', 'S1', has(e => e.canonical === 'forge.requirement_summary' && e.hook === 'PostToolUse' && moved('REQUIREMENT', 'PLANNING')(e))],
  ['C04', 'Write blocked before approval', 'S1 step 2', has(e => e.hook === 'PreToolUse' && ['write', 'edit'].includes(e.canonical) && e.decision === 'deny' && ['REQUIREMENT', 'PLANNING', 'AWAITING_APPROVAL'].includes(e.phaseBefore))],
  ['C05', 'Invalid / out-of-plan-mode ExitPlanMode denied', 'S1 (often natural) or S3', has(e => e.tool === 'ExitPlanMode' && e.hook === 'PreToolUse' && e.decision === 'deny')],
  ['C06', 'Valid plan → AWAITING_APPROVAL', 'S1', has(e => e.tool === 'ExitPlanMode' && e.hook === 'PreToolUse' && e.phaseAfter === 'AWAITING_APPROVAL')],
  ['C07', 'Native approval → EXECUTING', 'S1', has(e => e.tool === 'ExitPlanMode' && e.hook === 'PostToolUse' && e.phaseAfter === 'EXECUTING')],
  ['C08', 'Plan rejected keeps execution blocked', 'S3', has(e => e.hook === 'PostToolUseFailure' && e.tool === 'ExitPlanMode')],
  ['C09', 'forge-executor ran and wrote files', 'S1', has(e => e.hook === 'PreToolUse' && /forge-executor$/.test(String(e.agentType ?? '')) && ['write', 'edit'].includes(e.canonical) && !e.decision)],
  ['C10', 'Stop after execution → QA_REVIEW', 'S1', has(e => e.hook === 'Stop' && moved('EXECUTING', 'QA_REVIEW')(e))],
  ['C11', 'QA PASS → DELIVERY_PREP', 'S1', has(e => e.canonical === 'forge.qa_submit' && e.phaseAfter === 'DELIVERY_PREP')],
  ['C12', 'Delivery → DELIVERY (commit message)', 'S1', has(e => e.canonical === 'forge.delivery_submit' && e.phaseAfter === 'DELIVERY')],
  ['C13', 'QA FAIL → REWORK_PLANNING (approval revoked)', 'S2', has(e => e.canonical === 'forge.qa_submit' && e.phaseAfter === 'REWORK_PLANNING')],
  ['C14', 'Rework plan approved → EXECUTING again', 'S2', has(e => e.tool === 'ExitPlanMode' && e.hook === 'PostToolUse' && e.phaseAfter === 'EXECUTING') && has(moved('REWORK_PLANNING', 'AWAITING_APPROVAL'))],
  ['C15', 'Agent git write blocked', 'S4', has(e => e.canonical === 'bash' && e.decision === 'deny' && /Git writes/.test(e.reason ?? ''))],
  ['C16', 'Specialist subagent write blocked', 'S4 (natural if a specialist tries)', has(e => e.agentId && !/forge-executor$/.test(String(e.agentType ?? '')) && ['write', 'edit', 'bash'].includes(e.canonical) && e.decision === 'deny')],
  ['C17', 'Native resume restored the workflow', 'S5', has(e => e.hook === 'SessionStart' && e.source === 'resume' && e.phaseAfter)],
  ['C18', '/forge-resume adopted another session', 'S5', has(e => e.adopted)],
  ['C19', '/forge-approve fallback or clear-context handoff', 'S6', has(e => e.carried || (e.hook === 'UserPromptExpansion' && /approve/.test(String(e.command ?? '') + String(e.args ?? '')) && e.phaseAfter === 'EXECUTING'))],
];

const agentTypes = [...new Set(events.filter(e => e.agentType).map(e => e.agentType))];
const subagentTypes = [...new Set(events.filter(e => e.subagentType).map(e => e.subagentType))];
const agentTools = [...new Set(events.filter(e => e.canonical === 'agent').map(e => e.tool))];
const unknownTools = [...new Set(events.filter(e => e.canonical === 'other').map(e => e.tool))];
const commands = [...new Set(events.filter(e => e.command).map(e => e.command))];
const assumptions = [
  ['A1', 'Plugin subagents report agent_type as "forge:<name>"', agentTypes.some(t => /^forge:forge-/.test(t)), agentTypes.join(', ') || '(no subagent events yet)'],
  ['A2', 'Subagent tool is "Agent" (or "Task")', agentTools.length > 0 && agentTools.every(t => ['Agent', 'Task'].includes(t)), agentTools.join(', ') || '(no Agent calls yet)'],
  ['A3', 'subagent_type for Forge specialists is plugin-scoped', subagentTypes.filter(t => /forge-/.test(t)).every(t => t.includes(':')) && subagentTypes.some(t => /forge-/.test(t)), subagentTypes.join(', ') || '(none yet)'],
  ['A4', '/forge commands arrive via UserPromptExpansion', commands.some(c => /forge/.test(c)), commands.join(', ') || '(none yet)'],
  ['A5', 'ExitPlanMode success is observed (PostToolUse)', has(e => e.tool === 'ExitPlanMode' && e.hook === 'PostToolUse'), ''],
  ['A6', 'SubagentStop carries the specialist report (last_assistant_message)', has(e => e.hook === 'SubagentStop' && /forge-/.test(String(e.agentType ?? '')) && e.reportChars > 0),
    events.filter(e => e.hook === 'SubagentStop').map(e => `${e.agentType}:${e.reportChars ?? 0}ch`).slice(-6).join(', ')],
];

if (args.includes('--json')) {
  console.log(JSON.stringify({ data, events: events.length, checks: CHECKS, assumptions, unknownTools }, null, 2));
  process.exit(0);
}
const mark = ok => (ok ? '✔' : '·');
console.log(`Forge live coverage — ${events.length} hook events from ${file}\n`);
for (const [id, title, scenario, ok] of CHECKS) console.log(`${mark(ok)} ${id} ${title}${ok ? '' : `   → run ${scenario}`}`);
console.log('\nHost assumptions');
for (const [id, title, ok, seen] of assumptions) console.log(`${ok ? '✔' : '✗'} ${id} ${title}${seen ? `   [seen: ${seen}]` : ''}`);
if (unknownTools.length) console.log(`\nTools Forge did not recognise (denied before approval): ${unknownTools.join(', ')}`);
const passed = CHECKS.filter(c => c[3]).length;
console.log(`\n${passed}/${CHECKS.length} flows observed.`);
process.exit(passed === CHECKS.length && assumptions.every(a => a[2]) ? 0 : 1);

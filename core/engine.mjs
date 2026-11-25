/**
 * Forge engine: platform-neutral workflow controller.
 *
 * An adapter translates its host's events into the normalized events below,
 * calls `engine.handle(state, event)`, persists the returned state and maps
 * `out` back to host decisions. The engine performs no I/O itself except
 * through the injected `deps` (workspace inspection, report/plan storage).
 *
 * Events
 *   { type:'command', text }                           human-typed /forge …
 *   { type:'tool.pre',  tool, rawTool, input, actor, permissionMode, cwd }
 *   { type:'tool.post', tool, rawTool, input, output, actor, cwd }
 *   { type:'tool.fail', tool, rawTool, input, actor }
 *   { type:'turn.end' }                                main agent wants to stop
 *   { type:'agent.stop', agent, agentId, report }     a subagent finished (foreground OR background)
 *   { type:'prompt', text? }                           a new main turn starts (user or host-initiated); text = the user's prompt
 *   { type:'session.start', source }
 * actor = { kind:'main'|'sub', agent: string|null }
 * Specialist completion is counted ONLY on agent.stop: hosts may run subagents in
 * the background, so the spawning tool call returns before any report exists.
 * Gate instructions produced at that moment are queued in state.pendingContext
 * and delivered on the next main-agent event.
 * Canonical tools: read grep glob ls web ask todo coord agent bash write edit
 *   plan.enter plan.write (host plan-mode plan file, never a project file) plan.submit forge.qa_scope
 *   forge.execution_done forge.qa_submit forge.delivery_submit other
 *
 * out = { decision?:'deny', reason?, context?, continueReason?, message?, configUpdate? }
 *   decision/reason → block the tool call or (prompt) the user's prompt; reason goes to the model / the user
 *   context         → extra context for the model after the event
 *   continueReason  → (turn.end) keep the agent working with this instruction
 *   message         → text for the human
 */
import {
  parseCommand, initialState, phaseInstruction, executionInstruction, qaInstruction,
  reworkInstruction, deliveryInstruction, requiredAgentsFor, missingGateAgentsFor, validatePlanContract,
  evaluateQaReport, renderQaReport, renderQaSummary, buildCommitMessage, renderDeliveryReport, isProhibitedGitCommand,
  isAllowedDiscoveryCommand, isAllowedQaCommand, extractHighFindings, GATE_AGENTS, executionReminder,
  inlineGateSkills, steeringInstruction,
} from './core.mjs';
import { recoveryProposal } from './state-recovery.mjs';
import {
  markGateAgent, approvedExecutionState, qaReportTransition, assertQaSubmittable,
  assertDeliverySubmittable, deliveryTransition, approveReworkTransition, assertPlanProposable,
  executionDoneTransition, enterQaState, executionStopTransition, qaResubmission, steerTransition,
} from './transitions.mjs';
import { adaptInstruction } from './platform.mjs';
import { isValidRestoreCandidate, prepareHumanRecovery } from './checkpoint-recovery.mjs';
import { normalizeForgeState } from './forge-state.mjs';

export const READ_ONLY_TOOLS = Object.freeze(['read', 'grep', 'glob', 'ls', 'web', 'ask', 'todo', 'coord']);
const READ_ONLY = new Set(READ_ONLY_TOOLS);
const STEER_PROMPT = /^steer\s*:([\s\S]*)$/i;
const NOTE_PROMPT = /^(?:note|reply)\s*:([\s\S]*)$/i;
// Turns the host starts itself (e.g. <task-notification> when a background agent finishes) are not user prompts.
const HOST_PROMPT = /^<[a-z][\w-]*>/i;
const MAX_HANDBACK = 20000;
const PRE_APPROVAL = new Set(['PLAN']);
const QA_PHASES = new Set(['QA']);
const FORGE_AGENTS = new Set(Object.values(GATE_AGENTS).flat());
const PUBLISH_TOOL = /(?:github|gitlab|bitbucket)/i;
const PUBLISH_ACTION = /(?:commit|push|merge|create[_-]?pull|update[_-]?file|create[_-]?file|delete[_-]?file|release|tag)/i;
const MAX_STOP_NUDGES = 2;
const RUNNING_TTL_MS = 30 * 60 * 1000; // a run with no SubagentStop (e.g. interrupted) stops blocking after 30 min

/** "forge:forge-code-reviewer" (plugin-scoped) and "forge-code-reviewer" are the same agent. */
export function normalizeAgentName(value) {
  const s = String(value ?? '').trim();
  return s.includes(':') ? s.slice(s.lastIndexOf(':') + 1) : s;
}

export function createEngine({ platform = 'claude-code', config = {}, deps = {}, profile = {} } = {}) {
  const agentRef = profile.agentRef ?? (name => name);
  const toolRef = profile.toolRef ?? (name => name);
  // Gate skills cannot be loaded by name on every host: an adapter with `deps.loadSkills` gets their text inlined.
  const say = text => {
    const adapted = adaptInstruction(text, platform);
    const body = (deps.loadSkills ? inlineGateSkills(adapted, deps.loadSkills) : adapted)
      .replace(/`(forge-[a-z-]+)`/g, (m, name) => (FORGE_AGENTS.has(name) ? `\`${agentRef(name)}\`` : m));
    return profile.footer ? `${body}\n\n${profile.footer}` : body;
  };
  const deny = (state, reason) => ({ state, out: { decision: 'deny', reason } });
  const keep = (state, out = {}) => ({ state, out });

  // ------------------------------------------------------------------ commands
  function onCommand(state, text) {
    const raw = String(text ?? '').trim();
    if (/^approve$/i.test(raw)) return approveByCommand(state);
    const trace = raw.match(/^trace(?:\s+(on|off))?$/i);
    if (trace) {
      if (!trace[1]) return keep(state, { message: `Forge trace is ${config.trace ? 'ON' : 'OFF'}.${deps.traceInfo ? `\n${deps.traceInfo()}` : ''}` });
      const on = trace[1].toLowerCase() === 'on';
      return keep(state, { configUpdate: { trace: on }, message: `Forge trace ${on ? 'ON — every hook event and decision is logged for the coverage report' : 'OFF'}.${deps.traceInfo ? `\n${deps.traceInfo()}` : ''}` });
    }
    const resume = raw.match(/^resume(?:\s+(current|\d{1,2}))?$/i);
    if (resume) return resumeCommand(state, resume[1]);
    if (/^plan$/i.test(raw)) {
      return keep(state, { message: state?.planPath ? `Submitted plan: ${state.planPath}` : 'No Forge plan has been submitted yet.' });
    }
    const command = parseCommand(raw);
    switch (command.type) {
      case 'start': return start(state, command);
      case 'status': return keep(state, { message: statusLine(state) });
      case 'planReview': {
        if (command.enabled === null) return keep(state, { message: `Forge plan review is ${config.planReview ? 'ON' : 'OFF'} for new workflows. Usage: /forge planreview on|off (on: ${agentRef('forge-plan-critic')} reviews every plan before approval).` });
        return keep(state, { configUpdate: { planReview: command.enabled }, message: `Forge plan review ${command.enabled ? 'ON' : 'OFF'} for new workflows${state?.active ? '; the running workflow keeps its setting' : ''}.` });
      }
      case 'cancel': {
        const cancelledSlug = state?.slug;
        return keep({ active: false, version: 9, ...(cancelledSlug ? { cancelledSlug } : {}) }, { message: 'Forge workflow cancelled. No files or Git state were changed.' });
      }
      case 'qa': {
        if (!state?.approved || !state.planValid || !['EXECUTE', 'QA'].includes(state.phase)) {
          return keep(state, { message: 'No approved execution is available for QA.' });
        }
        const next = enterQaState(state);
        return keep(next, { context: say(qaInstruction(next)), message: 'Forge QA review started.' });
      }
      case 'rework': {
        if (!state || !['FAIL', 'BLOCKED'].includes(state.qaStatus) || !['QA', 'PLAN'].includes(state.phase)) return keep(state, { message: 'Rework requires a previous QA FAIL/BLOCKED.' });
        const next = approveReworkTransition(state);
        return keep(next, { context: say(reworkInstruction(next)), message: 'Forge rework planning started. A new native plan approval is required.' });
      }
      case 'delivery': {
        if (state?.active && state.phase === 'QA' && state.qaStatus === 'PASS') {
          const next = { ...state, deliveryRetries: 0 };
          return keep(next, { context: say(deliveryInstruction(next)) });
        }
        if (state?.deliveryPath) return keep(state, { message: `Delivery: ${state.deliveryPath}\nCommit message: ${state.commitMessagePath}\n\n${state.commitMessage ?? ''}` });
        return keep(state, { message: 'No QA-PASS delivery is available.' });
      }
      case 'report': return keep(state, { message: state?.qaReportPath ? `Last QA report: ${state.qaReportPath}` : 'No Forge QA report in this session yet.' });
      case 'agents': return keep(state, { message: `Forge agents (manage models/prompts with /agents):\n${[...FORGE_AGENTS].map(a => `  ${agentRef(a)}`).join('\n')}` });
      default:
        return keep(state, { message: `"/forge ${raw.split(/\s+/)[0]}" is not available in the ${platform} adapter. Available: <requirement>, status, resume [n], trace [on|off], planreview [on|off], approve, plan, qa, rework, delivery, report, agents, off.` });
    }
  }

  function start(state, command) {
    if (state?.active) return keep(state, { message: `A Forge workflow is active (${state.phase}). Steer it, or use /forge off.` });
    const requirement = String(command.requirement ?? '').trim();
    if (!requirement) return keep(state, { message: 'Usage: /forge <requirement>' });
    const next = initialState(requirement, undefined, null, null, {}, { planReview: config.planReview === true });
    return keep(next, { context: say(phaseInstruction(next)), message: 'Forge started. Gates: plan (you explore and write the plan, read-only) → native approval → execute → QA (+ forge-code-reviewer) → delivery. Forge never runs git writes.' });
  }

  /** List Forge workflows saved by other sessions of this project, or adopt one.
   * Adopting never carries an approval across sessions: it re-enters at the safe
   * gate (approved work → PLAN, fresh native approval required). Resuming the
   * original session with the host's own resume keeps everything. */
  function resumeCommand(state, arg) {
    if (arg && /^current$/i.test(arg)) return keep(state, { message: statusLine(state) });
    const list = (deps.listWorkflows?.() ?? []).filter(w => isValidRestoreCandidate(w.state));
    if (!arg) {
      if (!list.length) return keep(state, { message: `No other session of this project has a resumable Forge workflow.${state?.active ? ` This session: ${statusLine(state)}` : ''}` });
      const rows = list.map((w, i) => `${i + 1}. ${w.state.phase}${w.state.approved ? ' (approved)' : ''} · ${String(w.state.requirement).replace(/[\r\n]+/g, ' ').slice(0, 60)} · saved ${String(w.savedAt ?? '').replace('T', ' ').slice(0, 16)} · session ${w.sessionId}`);
      return keep(state, { message: `Forge workflows in other sessions of this project:\n${rows.join('\n')}\n\nKeep everything (incl. approval): exit and run \`claude --resume <session>\`, or use /resume and pick that session.\nAdopt into THIS session instead: /forge-resume <number> — approved work restarts at PLAN and needs a fresh native approval.` });
    }
    if (state?.active) return keep(state, { message: `This session already has an active Forge workflow (${state.phase}). Use /forge-off first.` });
    const pick = list[Number(arg) - 1];
    if (!pick) return keep(state, { message: `No workflow #${arg}. Run /forge-resume to list them.` });
    const recovered = prepareHumanRecovery(pick.state);
    const next = { ...recovered, adoptedFromSession: pick.sessionId, recoveryAudit: [...(recovered.recoveryAudit ?? []).slice(0, -1), { ...(recovered.recoveryAudit ?? []).at(-1), reason: 'cross-session-adopt' }].slice(-20) };
    const revoked = pick.state.approved ? ' The earlier approval was not carried over: a fresh native plan approval is required.' : '';
    return keep(next, { retireSession: pick.sessionId, context: say(phaseInstruction(next)), message: `Adopted ${pick.state.phase} from session ${pick.sessionId} as ${next.phase}.${revoked}` });
  }

  function approveByCommand(state) {
    if (!state?.active || state.phase !== 'PLAN' || !state.planWritten || state.approved || state.planValid !== true || !state.approvedPlanHash) {
      return keep(state, { message: 'Nothing to approve: /forge approve works only after a VALID plan was submitted and is awaiting approval.' });
    }
    const next = approvedExecutionState(state, 'human-typed-forge-approve');
    return keep(next, { context: say(executionInstruction(next)), message: `Plan approved by you (/forge approve). Plan: ${state.planPath ?? '(stored)'}` });
  }

  function statusLine(state) {
    if (!state?.phase) return 'Forge: inactive';
    return `Forge: ${state.phase} | requirement: ${String(state.requirement ?? '').replace(/[\r\n]/g, ' ').slice(0, 80) || '(none)'} | slug: ${state.slug ?? '-'} | approved: ${state.approved === true ? 'yes' : 'no'} | QA: ${state.qaStatus ?? 'pending'} | rework: ${state.reworkCycles ?? 0} | waiting agents: ${missingGateAgentsFor(state).map(agentRef).join(',') || 'none'}${Object.keys(state.agentsRunning ?? {}).length ? ` | running: ${Object.keys(state.agentsRunning).map(k => agentRef(k.split('|')[1])).join(',')}` : ''}`;
  }

  /** Deliver a queued gate instruction on a main-agent event that can carry context. */
  function flush(result, field = 'context') {
    const st = result.state;
    if (!st?.pendingContext || result.out.decision === 'deny' || result.out[field]) return result;
    return { state: { ...st, pendingContext: null }, out: { ...result.out, [field]: st.pendingContext } };
  }
  const queue = (state, text) => ({ ...state, pendingContext: state.pendingContext ? `${state.pendingContext}\n\n${text}` : text });

  // ------------------------------------------------------------------ tool.pre
  function onToolPre(state, ev) {
    const result = toolPre(state, ev);
    return ev.actor?.kind === 'sub' ? result : flush(result);
  }

  function toolPre(state, ev) {
    const { tool, input = {}, actor = { kind: 'main' } } = ev;
    const agentName = actor.kind === 'sub' ? normalizeAgentName(actor.agent) : null;
    const isForgeChild = agentName != null && FORGE_AGENTS.has(agentName);
    if (!state?.phase && !isForgeChild) return keep(state); // no Forge workflow in this session: unguarded

    // Global guards for every Forge session and Forge child, in every phase.
    if (tool === 'bash' && isProhibitedGitCommand(String(input.command ?? ''))) {
      return deny(state, 'Forge policy: Git writes must be manual. No agent git add/commit/push/tag/merge/rebase.');
    }
    if (tool === 'other' && PUBLISH_TOOL.test(ev.rawTool ?? '') && PUBLISH_ACTION.test(ev.rawTool ?? '')) {
      return deny(state, 'Forge does not allow agent-controlled repository publishing or commits.');
    }
    if ((tool === 'write' || tool === 'edit') && /(?:^|\/)\.git(?:\/|$)/.test(String(input.file_path ?? input.path ?? ''))) {
      return deny(state, 'Forge forbids direct writes to .git internals.');
    }
    if (!state?.active) return keep(state);

    const conflict = recoveryProposal(state);
    if (conflict?.category === 'safety' && !READ_ONLY.has(tool)) {
      return deny(state, `Forge state conflict: ${conflict.explanation} Run /forge status and /forge off or rework.`);
    }

    if (isForgeChild && ['write', 'edit', 'bash'].includes(tool)) return deny(state, 'Forge specialist is read-only: it reviews and reports; no edits, shell or Git writes.');

    // A subagent handing its report back through a host coordination tool.
    if (tool === 'coord' && actor.kind === 'sub' && actor.agentId && /handback/i.test(ev.rawTool ?? '')) {
      const text = typeof ev.inputText === 'string' ? ev.inputText : '';
      if (text) return keep({ ...state, handbacks: { ...(state.handbacks ?? {}), [actor.agentId]: text.slice(0, MAX_HANDBACK) } });
    }

    // executionObserved: the first main-agent action after approval.
    let s = state;
    if (s.phase === 'EXECUTE' && s.approved && !s.executionObserved && actor.kind === 'main') s = { ...s, executionObserved: true };

    if (s.reworkDecisionPending && ['plan.write', 'plan.submit', 'forge.qa_submit'].includes(tool)) {
      return deny(s, `Forge: QA ${s.qaStatus} is waiting for the user's decision. Show the QA summary table and stop; the user runs /forge-rework to plan a fix${s.qaStatus === 'BLOCKED' ? ' or /forge-qa to rerun QA' : ''}.`);
    }
    if (tool === 'plan.write') {
      if (!PRE_APPROVAL.has(s.phase)) return deny(s, `Forge ${s.phase}: the plan file can be edited only before approval.`);
      return keep({ ...s, planDraftPath: ev.planFile ?? s.planDraftPath ?? null,
        ...(s.phase === 'PLAN' ? { planValid: false, approvedPlanHash: null, approved: false } : {}) });
    }
    if (tool === 'agent') return routeAgent(s, input);
    if (tool === 'plan.submit') return preSubmitPlan(s, ev);
    if (tool === 'forge.execution_done') {
      if (actor.kind !== 'main') return deny(s, 'Forge: only the lead agent reports the approved execution as done.');
      try { executionDoneTransition(s, input); }
      catch (err) { return deny(s, `Forge: ${err.message}`); }
      return keep(s);
    }
    if (tool === 'forge.qa_scope') {
      if (!s.approved || !QA_PHASES.has(s.phase)) return deny(s, 'QA scope is only available for an approved execution under review.');
      return keep(s);
    }
    if (tool === 'forge.qa_submit') {
      let report;
      try { assertQaSubmittable(s, input); report = evaluateQaReport(input, s.businessTopics, s.requirements, s.qualityGates, s.testCases); }
      catch (err) { return deny(s, `Forge QA report rejected: ${err.message}`); }
      const retry = qaResubmission(s, report);
      if (retry) return deny(retry.state, retry.message);
      return keep(s);
    }
    if (tool === 'forge.delivery_submit') {
      try { assertDeliverySubmittable(s, deps.snapshotWorkingTree?.(ev.cwd)); buildCommitMessage(input.subject, input.body); }
      catch (err) { return deny(s, `Forge delivery rejected: ${err.message}`); }
      return keep(s);
    }

    if (PRE_APPROVAL.has(s.phase)) return preApprovalPolicy(s, tool, input);
    if (QA_PHASES.has(s.phase)) {
      if (READ_ONLY.has(tool)) return keep(s);
      if (tool === 'bash' && isAllowedQaCommand(String(input.command ?? ''), s.approvedCommands)) return keep(s);
      return deny(s, `Forge ${s.phase} is read-only: QA never edits code. Safe test/lint/typecheck commands and git status/diff are allowed.`);
    }
    return keep(s); // Git/publish guards above still apply.
  }

  function preApprovalPolicy(s, tool, input) {
    if (READ_ONLY.has(tool) || tool === 'plan.enter') return keep(s);
    if (tool === 'bash') {
      if (isAllowedDiscoveryCommand(String(input.command ?? ''))) return keep(s);
      return deny(s, `Forge ${s.phase} permits only safe read-only inspection commands before approval.`);
    }
    if (tool === 'write' || tool === 'edit') {
      return deny(s, `Forge ${s.phase} is read-only: implementation writes require explicit native plan approval.`);
    }
    return deny(s, `Forge ${s.phase}: ${tool === 'other' ? 'this tool' : tool} cannot run before native approval. Use Read/Grep/Glob, the Agent tool and AskUserQuestion.`);
  }

  function routeAgent(s, input) {
    const name = normalizeAgentName(input.subagent_type ?? input.agent ?? input.agentType);
    const required = requiredAgentsFor(s);
    if (required.length && FORGE_AGENTS.has(name) && !required.includes(name)) {
      return deny(s, `Forge ${s.phase} requires ${required.map(agentRef).join(', ')}; ${agentRef(name)} is not part of this gate.`);
    }
    if (!required.length && FORGE_AGENTS.has(name)) {
      return deny(s, `Forge ${s.phase} does not run specialists.`);
    }
    if (required.includes(name)) {
      const key = s.phase;
      // Token guard without cutting rigor: one counted report per specialist per gate.
      if ((s.gateAgents?.[key] ?? []).includes(name)) {
        return deny(s, `Forge: ${agentRef(name)} already reported for ${key}. Use its report; a duplicate run adds cost, not coverage.`);
      }
      const startedAt = s.agentsRunning?.[`${key}|${name}`];
      if (startedAt && Date.now() - Date.parse(startedAt) < RUNNING_TTL_MS) {
        return deny(s, `Forge: ${agentRef(name)} is still running for ${key} (started ${startedAt}). Wait for its result instead of starting another run.`);
      }
      const spawned = new Set(s.gateAgentsSpawned?.[key] ?? []);
      spawned.add(name);
      s = { ...s, gateAgentsSpawned: { ...(s.gateAgentsSpawned ?? {}), [key]: [...spawned] },
        agentsRunning: { ...(s.agentsRunning ?? {}), [`${key}|${name}`]: new Date().toISOString() } };
    }
    return keep(s);
  }

  function preSubmitPlan(s, ev) {
    if (s.phase !== 'PLAN') {
      return deny(s, `Forge ${s.phase}: a plan can be submitted only during planning.`);
    }
    if (ev.permissionMode && ev.permissionMode !== 'plan') {
      return deny(s, 'Native plan approval requires plan mode. Call EnterPlanMode (or ask the user to press Shift+Tab until plan mode is shown), then call ExitPlanMode again.');
    }
    // Like OMP, the plan lives in a file: Forge reads the plan-mode plan file, never inline text.
    const file = ev.planFile ?? s.planDraftPath ?? null;
    if (!file) return deny(s, 'Forge reads the plan only from the plan file. In plan mode, write the complete plan to the plan file Claude Code assigns (create it early and keep updating it), then call ExitPlanMode again. A plan passed only as text is not accepted.');
    const content = planFileText(file);
    if (!content.trim()) return deny(s, `Forge found no plan text in ${file}. Write the complete plan to that file, then call ExitPlanMode again.`);
    const contract = validatePlanContract(content);
    if (s.reworkBaseHash && contract.hash === s.reworkBaseHash) {
      contract.valid = false;
      contract.issues.push('Rework submission is identical to the previously approved plan. Revise it to address the QA failures.');
    }
    if (!contract.valid) {
      return deny({ ...s, planIssues: contract.issues, planValid: false }, `Forge plan contract is invalid. Fix before approval:\n${contract.issues.join('\n')}`);
    }
    try { assertPlanProposable(s, content); }
    catch (err) { return deny({ ...s, planValid: false }, `Forge plan review: ${err.message}`); }
    const planPath = deps.savePlan ? deps.savePlan(s, content) : s.planPath;
    const next = {
      ...s, phase: 'PLAN', planWritten: true, planValid: true, approvedPlanHash: contract.hash,
      businessTopics: contract.topics, requirements: contract.requirements, testCases: contract.testCases,
      qualityGates: contract.qualityGates, approvedCommands: contract.commands, planPath, planDraftPath: file, planIssues: [], approved: false,
    };
    return keep(next); // no decision: the host's native approval prompt decides
  }

  // ------------------------------------------------------------------ tool.post / tool.fail
  function onToolPost(state, ev) {
    const result = toolPost(state, ev);
    return ev.actor?.kind === 'sub' ? result : flush(result);
  }

  function toolPost(state, ev) {
    if (!state?.active) return keep(state);
    const { tool, input = {} } = ev;
    if (tool === 'agent') return keep(state); // completion is counted on agent.stop (works for background agents)
    if (tool === 'plan.submit') return planApproved(state, ev);
    if (tool === 'plan.write') {
      // Keep Forge's own copy of the draft current, so the plan always exists as a Forge file.
      const text = state.phase === 'PLAN' && ev.planFile ? planFileText(ev.planFile) : '';
      if (text.trim() && deps.savePlan) deps.savePlan(state, text);
      return keep(state);
    }
    if (tool === 'forge.qa_scope') {
      const scope = deps.inspectWorkspaceScope ? deps.inspectWorkspaceScope(ev.cwd) : { available: false, files: [] };
      return keep(state, { context: `Forge QA scope (read-only git inventory):\n${JSON.stringify(scope, null, 2)}` });
    }
    if (tool === 'forge.execution_done') {
      let next;
      try { next = executionDoneTransition(state, input); }
      catch (err) { return keep(state, { context: `Forge: ${err.message}` }); }
      return keep(next, { context: 'Forge: execution recorded as done. End your turn now; Forge starts the QA review when the turn ends.' });
    }
    if (tool === 'forge.qa_submit') return qaSubmitted(state, ev);
    if (tool === 'forge.delivery_submit') return deliverySubmitted(state, ev);
    return keep(state);
  }

  function onToolFail(state, ev) {
    if (!state?.active || ev.tool !== 'plan.submit' || state.phase !== 'PLAN' || !state.planValid || state.approved) return keep(state);
    return keep({ ...state, approved: false }, { context: 'Forge: the plan was NOT approved. Read the user\'s feedback, revise the plan, and call ExitPlanMode again. Do not implement.' });
  }

  /** A subagent finished. Returns { state, out } where out.continueReason (optional)
   * keeps THAT subagent working (used once to ask for a missing report). Gate
   * instructions for the main agent are queued, not returned. */
  function onAgentStop(state, ev) {
    if (!state?.active) return keep(state);
    const name = normalizeAgentName(ev.agent);
    const key = state.phase;
    if (!(state.gateAgentsSpawned?.[key] ?? []).includes(name)) return keep(state);
    if ((state.gateAgents?.[key] ?? []).includes(name)) return keep(state); // already counted (duplicate run)
    const stillRunning = state; // a nudged subagent keeps working, so it stays marked as running
    const running = { ...(state.agentsRunning ?? {}) }; delete running[`${key}|${name}`];
    state = { ...state, agentsRunning: running };
    const handback = ev.agentId ? state.handbacks?.[ev.agentId] ?? '' : '';
    const text = [handback, typeof ev.report === 'string' ? ev.report : ''].filter(t => t.trim()).join('\n\n');
    const nudgeKey = `report:${ev.agentId ?? name}`;
    if (!text.trim()) {
      if (!(state.agentRetries?.[nudgeKey])) {
        return keep({ ...stillRunning, agentRetries: { ...(stillRunning.agentRetries ?? {}), [nudgeKey]: 1 } },
          { continueReason: 'Forge: finish by writing your complete structured report as your final message (Gate status, Scope reviewed, Findings with severity, Traceability, Remaining risks). The orchestrator cannot see your work otherwise.' });
      }
      return keep(queue(state, `Forge: ${agentRef(name)} finished without a report, so it does not count for ${key}. Run it once more and wait for its result.`));
    }
    const handbacks = { ...(state.handbacks ?? {}) }; if (ev.agentId) delete handbacks[ev.agentId];
    let s = markGateAgent({ ...state, handbacks }, name);
    s = { ...s, agentCompletions: [...(s.agentCompletions ?? []), { gate: key, agent: name, reportedAt: new Date().toISOString(), resultPreview: text.slice(0, 800), highFindings: extractHighFindings(text) }].slice(-60) };
    const missing = missingGateAgentsFor(s);
    if (missing.length) return keep(queue(s, `Forge: ${agentRef(name)} reported for ${key}. Still waiting for: ${missing.map(agentRef).join(', ')}. Do not re-run agents that are still working.`));
    const gate = gateTransitionAfterAgents(s);
    return keep(gate.context ? queue(gate.state, gate.context) : gate.state);
  }

  /** All required specialists of the current gate reported: instruct the main agent. */
  function gateTransitionAfterAgents(s) {
    if (s.phase === 'PLAN') return { state: s, context: `Forge: ${agentRef('forge-plan-critic')} reported. Resolve each CRITICAL/HIGH finding and cite its PC-id in the plan, then submit it with ExitPlanMode.` };
    if (s.phase === 'QA' && s.qaStatus !== 'PASS') return { state: s, context: `Forge: ${agentRef('forge-code-reviewer')} reported. Merge its findings into codeReview (every CRITICAL/HIGH CR-id at CRITICAL/HIGH or marked "Disputed:"), finish your own TC checks, then call ${toolRef('forge_qa_submit')} exactly once with evidence-backed results.` };
    return { state: s };
  }

  /** Text of the plan-mode plan file (bounded read by the adapter). */
  function planFileText(path) {
    return path && deps.readPlanFile ? String(deps.readPlanFile(path) ?? '') : '';
  }

  function planApproved(state, ev) {
    if (state.phase !== 'PLAN' || !state.planWritten || state.approved || state.planValid !== true || !state.approvedPlanHash) return keep(state);
    // The approved text can differ from the submitted one if the user edited it in the approval dialog.
    const content = typeof ev.approvedPlan === 'string' && ev.approvedPlan.trim() ? ev.approvedPlan : planFileText(ev.planFile ?? state.planDraftPath);
    const contract = content ? validatePlanContract(content) : null;
    if (contract && contract.hash !== state.approvedPlanHash) {
      if (!contract.valid) {
        return keep({ ...state, planValid: false, approved: false, planIssues: contract.issues, phase: 'PLAN' },
          { context: `Forge: the approved plan text no longer satisfies the plan contract, so execution is NOT authorized:\n${contract.issues.join('\n')}\nFix the plan and submit it again with ExitPlanMode.` });
      }
      const planPath = deps.savePlan ? deps.savePlan(state, content) : state.planPath;
      state = { ...state, approvedPlanHash: contract.hash, businessTopics: contract.topics, requirements: contract.requirements, testCases: contract.testCases, qualityGates: contract.qualityGates, approvedCommands: contract.commands, planPath };
    }
    const next = approvedExecutionState(state, 'native-plan-approval');
    return keep(next, { context: say(executionInstruction(next)), message: 'Forge: plan approved (native). EXECUTE 2/3.' });
  }

  function qaSubmitted(state, ev) {
    let report;
    try { assertQaSubmittable(state, ev.input); report = evaluateQaReport(ev.input, state.businessTopics, state.requirements, state.qualityGates, state.testCases); }
    catch (err) { return keep(state, { context: `Forge QA report rejected: ${err.message}` }); }
    const retry = qaResubmission(state, report);
    if (retry) return keep(retry.state, { context: retry.message });
    const workingTree = report.status === 'PASS' ? deps.snapshotWorkingTree?.(ev.cwd) ?? null : null;
    const meta = { slug: state.slug, planPath: state.planPath, approvedPlanHash: state.approvedPlanHash, generatedAt: new Date().toISOString() };
    const reportPath = deps.saveQaReport ? deps.saveQaReport(state, renderQaReport(report, meta), { ...meta, ...report }) : null;
    const next = qaReportTransition(state, report, { reportPath, workingTree });
    const summary = `Forge QA GATE: ${report.status}\n\n${renderQaSummary(report, { reportPath })}`;
    const decide = 'Show the user the QA summary table above exactly as written, then stop and wait. Do NOT draft a fix plan, edit code or rerun checks:';
    const follow = report.status === 'PASS' ? say(deliveryInstruction(next))
      : report.status === 'FAIL' ? `${decide} the user decides with /forge-rework (plan a fix; the fix plan needs approval again) or /forge-off.`
      : `QA is BLOCKED by missing evidence, not an observed failure; the approved plan is retained. ${decide} the user collects the evidence and runs /forge-qa, or runs /forge-rework to plan a fix.`;
    return keep(next, { context: `${summary}\n\n${follow}`, message: `Forge QA: ${report.status}` });
  }

  function deliverySubmitted(state, ev) {
    let commitMessage;
    try { assertDeliverySubmittable(state, deps.snapshotWorkingTree?.(ev.cwd)); commitMessage = buildCommitMessage(ev.input.subject, ev.input.body); }
    catch (err) { return keep(state, { context: `Forge delivery rejected: ${err.message}` }); }
    const payload = {
      slug: state.slug, planPath: state.planPath, approvedPlanHash: state.approvedPlanHash, qaReportPath: state.qaReportPath,
      generatedAt: new Date().toISOString(), commitMessage,
      diffAudit: state.workingTreeAtQa?.available ? 'MATCHED QA SNAPSHOT' : 'NOT_AVAILABLE — MANUAL DIFF REVIEW REQUIRED',
      highlights: ev.input.highlights ?? [], changedFiles: ev.input.changedFiles ?? [],
    };
    const paths = deps.saveDelivery ? deps.saveDelivery(state, renderDeliveryReport(payload), commitMessage) : { deliveryPath: null, commitMessagePath: null };
    const next = deliveryTransition(state, { ...paths, commitMessage });
    return keep(next, { context: `Forge DELIVERY ready — QA PASS.\nDelivery: ${paths.deliveryPath}\nCommit message file: ${paths.commitMessagePath}\n\nCOPY THIS COMMIT MESSAGE:\n\n\`\`\`text\n${commitMessage.trimEnd()}\n\`\`\`\n\nNo git add/commit/push was executed. The user commits manually after reviewing the diff.`, message: 'Forge DELIVERY ready.' });
  }

  // ------------------------------------------------------------------ turn.end
  function onTurnEnd(state) {
    if (!state?.active) return keep(state);
    if (state.pendingContext) return keep({ ...state, pendingContext: null }, { continueReason: state.pendingContext });
    const running = Object.entries(state.agentsRunning ?? {}).filter(([k, at]) => k.startsWith(`${state.phase}|`) && Date.now() - Date.parse(at) < RUNNING_TTL_MS);
    if (running.length) return keep(state); // specialists still working (e.g. background): wait, never re-run
    if (state.reworkDecisionPending) return keep(state); // QA FAIL/BLOCKED: the human decides; never nudge
    const nudge = (key, reason) => {
      const retries = state.agentRetries?.[key] ?? 0;
      if (retries >= MAX_STOP_NUDGES) return keep(state);
      return keep({ ...state, agentRetries: { ...(state.agentRetries ?? {}), [key]: retries + 1 } }, { continueReason: reason });
    };
    if (state.phase === 'EXECUTE' && state.approved) {
      const settled = executionStopTransition(state);
      if (settled.action === 'qa') return keep(settled.state, { continueReason: say(qaInstruction(settled.state)), message: 'Forge: execution done → QA 3/3.' });
      if (settled.action === 'remind') return keep(settled.state, { continueReason: say(executionReminder()) });
      return keep(state, { message: `execution paused: the approved plan is not marked done (${toolRef('forge_execution_done')} was not called). Reply with \`note: <text>\` to let it continue, or run /forge-qa to start QA now.` });
    }
    if (state.phase === 'QA' && state.qaStatus !== 'PASS') return nudge('QA:stop', `Forge QA is incomplete: call ${toolRef('forge_qa_submit')} with evidence-backed results. If checks cannot run, submit BLOCKED/NOT_RUN; never fabricate PASS.`);
    if (state.phase === 'QA' && state.qaStatus === 'PASS') return nudge('QA:delivery', `Forge delivery is incomplete: call ${toolRef('forge_delivery_submit')} once, then print the commit message for the user.`);
    return keep(state);
  }

  /** A new main turn. While an approved plan runs (EXECUTE/QA), a typed prompt must say what it is:
   * `steer: …` re-plans (approval revoked), `note: …`/`reply: …` clarifies (approval kept); anything
   * else is blocked so a stray prompt never silently changes approved scope. */
  function onPrompt(state, ev = {}) {
    const text = String(ev.text ?? '').trim();
    const guarded = state?.active && !state.deliveryPath && state.approved === true && ['EXECUTE', 'QA'].includes(state.phase);
    if (guarded && text && !text.startsWith('/') && !HOST_PROMPT.test(text)) {
      const steer = text.match(STEER_PROMPT);
      if (steer) {
        if (!steer[1].trim()) return deny(state, 'Forge: `steer:` needs the new direction, e.g. `steer: also export contacts as CSV`.');
        const from = state.phase;
        const next = { ...steerTransition(state, steer[1].trim()), pendingContext: null };
        return keep(next, { context: say(steeringInstruction(next, { from, revoked: true })),
          message: `steering #${next.steeringRevision}: ${from} → PLAN. Approval revoked; the revised plan needs your approval.` });
      }
      if (NOTE_PROMPT.test(text)) {
        const note = `Forge: the user's message is a clarification during ${state.phase}; the approval and the approved scope are unchanged. Apply it within the approved plan and continue the gate. If it would change the approved scope, stop and tell the user to send \`steer: <text>\` to re-plan.`;
        const base = state.phase === 'EXECUTE' ? { ...state, executionReminders: 0 } : state;
        return keep({ ...base, pendingContext: null }, { context: state.pendingContext ? `${state.pendingContext}\n\n${note}` : note });
      }
      return deny(state, `Forge is running an approved plan (${state.phase}), so this prompt was not sent. Prefix it: \`steer: <text>\` changes the requirement (re-plans and revokes the approval), \`note: <text>\` sends a clarification (keeps the approval). /forge off cancels the workflow.`);
    }
    if (!state?.active || !state.pendingContext) return keep(state);
    return keep({ ...state, pendingContext: null }, { context: state.pendingContext });
  }

  function onSessionStart(state) {
    if (!state?.active) return keep(state);
    return keep(state, { context: `Forge workflow in this session: ${statusLine(state)}. Continue from this gate; /forge status shows details.` });
  }

  return {
    handle(state, event) {
      state = normalizeForgeState(state);
      switch (event?.type) {
        case 'command': return onCommand(state, event.text);
        case 'tool.pre': return onToolPre(state, event);
        case 'tool.post': return onToolPost(state, event);
        case 'tool.fail': return onToolFail(state, event);
        case 'turn.end': return onTurnEnd(state);
        case 'agent.stop': return onAgentStop(state, event);
        case 'prompt': return onPrompt(state, event);
        case 'session.start': return onSessionStart(state);
        default: return keep(state);
      }
    },
  };
}

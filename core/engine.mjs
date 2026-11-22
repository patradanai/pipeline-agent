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
 *   { type:'prompt' }                                  a new main turn starts (user or host-initiated)
 *   { type:'session.start', source }
 * actor = { kind:'main'|'sub', agent: string|null }
 * Specialist completion is counted ONLY on agent.stop: hosts may run subagents in
 * the background, so the spawning tool call returns before any report exists.
 * Gate instructions produced at that moment are queued in state.pendingContext
 * and delivered on the next main-agent event.
 * Canonical tools: read grep glob ls web ask todo coord agent bash write edit
 *   plan.enter plan.write (host plan-mode plan file, never a project file) plan.submit forge.requirement_summary forge.qa_scope
 *   forge.qa_submit forge.delivery_submit other
 *
 * out = { decision?:'deny', reason?, context?, continueReason?, message?, configUpdate? }
 *   decision/reason → block the tool call (reason goes to the model)
 *   context         → extra context for the model after the event
 *   continueReason  → (turn.end) keep the agent working with this instruction
 *   message         → text for the human
 */
import {
  parseCommand, initialState, phaseInstruction, requirementSummaryInstruction, executionInstruction, qaInstruction,
  reworkInstruction, deliveryInstruction, requiredAgentsFor, missingGateAgentsFor, validatePlanContract,
  evaluateQaReport, renderQaReport, buildCommitMessage, renderDeliveryReport, isProhibitedGitCommand,
  isAllowedDiscoveryCommand, isAllowedQaCommand, countReportedSeverities, GATE_AGENTS,
} from './core.mjs';
import { recoveryProposal } from './state-recovery.mjs';
import {
  hasGateAgents, markGateAgent, approvedExecutionState, qaReportTransition, assertQaSubmittable,
  assertDeliverySubmittable, deliveryTransition, reworkTransition, applyRequirementSummary,
} from './transitions.mjs';
import { adaptInstruction } from './platform.mjs';
import { isValidRestoreCandidate, prepareHumanRecovery } from './checkpoint-recovery.mjs';
import { normalizeForgeState } from './forge-state.mjs';

const READ_ONLY = new Set(['read', 'grep', 'glob', 'ls', 'web', 'ask', 'todo', 'coord']);
const MAX_HANDBACK = 20000;
const PRE_APPROVAL = new Set(['REQUIREMENT', 'PLAN']);
const QA_PHASES = new Set(['QA']);
const FORGE_AGENTS = new Set(Object.values(GATE_AGENTS).flat());
const PUBLISH_TOOL = /(?:github|gitlab|bitbucket)/i;
const PUBLISH_ACTION = /(?:commit|push|merge|create[_-]?pull|update[_-]?file|create[_-]?file|delete[_-]?file|release|tag)/i;
const MAX_STOP_NUDGES = 2;
const RUNNING_TTL_MS = 30 * 60 * 1000; // a run with no SubagentStop (e.g. interrupted) stops blocking after 30 min

/** "forge:forge-planner" (plugin-scoped) and "forge-planner" are the same agent. */
export function normalizeAgentName(value) {
  const s = String(value ?? '').trim();
  return s.includes(':') ? s.slice(s.lastIndexOf(':') + 1) : s;
}

export function createEngine({ platform = 'claude-code', config = {}, deps = {}, profile = {} } = {}) {
  const agentRef = profile.agentRef ?? (name => name);
  const toolRef = profile.toolRef ?? (name => name);
  const say = text => {
    const body = adaptInstruction(text, platform)
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
      case 'cancel': {
        const cancelledSlug = state?.slug;
        return keep({ active: false, version: 9, ...(cancelledSlug ? { cancelledSlug } : {}) }, { message: 'Forge workflow cancelled. No files or Git state were changed.' });
      }
      case 'qa': {
        if (!state?.approved || !state.planValid || !['EXECUTE', 'QA'].includes(state.phase)) {
          return keep(state, { message: 'No approved execution is available for QA.' });
        }
        const next = { ...state, active: true, phase: 'QA', qaStatus: null, qaRetries: 0, qaEvidencePending: false, gateAgents: { ...(state.gateAgents ?? {}), QA: [] } };
        return keep(next, { context: say(qaInstruction(next)), message: 'Forge QA review started.' });
      }
      case 'rework': {
        if (!state || !['FAIL', 'BLOCKED'].includes(state.qaStatus) || !['QA', 'PLAN'].includes(state.phase)) return keep(state, { message: 'Rework requires a previous QA FAIL/BLOCKED.' });
        const next = state.phase === 'PLAN' ? state : reworkTransition(state);
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
        return keep(state, { message: `"/forge ${raw.split(/\s+/)[0]}" is not available in the ${platform} adapter. Available: <requirement>, status, resume [n], trace [on|off], approve, plan, qa, rework, delivery, report, agents, off.` });
    }
  }

  function start(state, command) {
    if (state?.active) return keep(state, { message: `A Forge workflow is active (${state.phase}). Steer it, or use /forge off.` });
    const requirement = String(command.requirement ?? '').trim();
    if (!requirement) return keep(state, { message: 'Usage: /forge <requirement>' });
    const next = initialState(requirement);
    return keep(next, { context: say(phaseInstruction(next)), message: 'Forge started. Gates: requirement (one forge-requirement pass) → plan → native approval → execute → QA → delivery. Forge never runs git writes.' });
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

    const conflict = recoveryProposal(state, 'unknown');
    if (conflict?.category === 'safety' && !READ_ONLY.has(tool)) {
      return deny(state, `Forge state conflict: ${conflict.explanation} Run /forge status and /forge off or rework.`);
    }

    if (isForgeChild) {
      const executor = agentName === 'forge-executor';
      if (!executor && ['write', 'edit', 'bash'].includes(tool)) return deny(state, 'Forge specialist is read-only. Only forge-executor may edit approved code; no Git writes.');
      if (executor && tool === 'bash') return deny(state, 'forge-executor has no shell. The main orchestrator runs safe build/test commands.');
      if (executor && ['write', 'edit'].includes(tool) && (state.phase !== 'EXECUTE' || !state.approved)) return deny(state, `Forge ${state.phase}: implementation writes require the approved EXECUTE gate.`);
    }

    // A subagent handing its report back through a host coordination tool.
    if (tool === 'coord' && actor.kind === 'sub' && actor.agentId && /handback/i.test(ev.rawTool ?? '')) {
      const text = typeof ev.inputText === 'string' ? ev.inputText : '';
      if (text) return keep({ ...state, handbacks: { ...(state.handbacks ?? {}), [actor.agentId]: text.slice(0, MAX_HANDBACK) } });
    }

    // executionObserved: the first main-agent action after approval.
    let s = state;
    if (s.phase === 'EXECUTE' && s.approved && !s.executionObserved && actor.kind === 'main') s = { ...s, executionObserved: true };

    if (tool === 'plan.write') {
      if (!PRE_APPROVAL.has(s.phase)) return deny(s, `Forge ${s.phase}: the plan file can be edited only before approval.`);
      return keep({ ...s, planDraftPath: ev.planFile ?? s.planDraftPath ?? null,
        ...(s.phase === 'PLAN' ? { planValid: false, approvedPlanHash: null, approved: false } : {}) });
    }
    if (tool === 'agent') return routeAgent(s, input);
    if (tool === 'plan.submit') return preSubmitPlan(s, ev);
    if (tool === 'forge.requirement_summary') {
      try { applyRequirementSummary(s, input); } catch (err) { return deny(s, `Forge requirement summary rejected: ${err.message}`); }
      return keep(s);
    }
    if (tool === 'forge.qa_scope') {
      if (!s.approved || !QA_PHASES.has(s.phase)) return deny(s, 'QA scope is only available for an approved execution under review.');
      return keep(s);
    }
    if (tool === 'forge.qa_submit') {
      try { assertQaSubmittable(s, input); evaluateQaReport(input, s.businessTopics, s.requirements, s.qualityGates, s.testCases); }
      catch (err) { return deny(s, `Forge QA report rejected: ${err.message}`); }
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
      if (tool === 'bash' && isAllowedQaCommand(String(input.command ?? ''))) return keep(s);
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
      const pending = s.phase === 'REQUIREMENT' ? ` Finish the requirement analysis: ${missingGateAgentsFor(s).map(agentRef).join(', ') || `call ${toolRef('forge_requirement_summary')}`}.` : '';
      return deny(s, `Forge ${s.phase} is read-only: implementation writes require explicit native plan approval.${pending}`);
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
    const plannerGate = s;
    if (!hasGateAgents(plannerGate)) {
      return deny(s, `Run ${requiredAgentsFor(plannerGate).map(agentRef).join(', ')} through the Agent tool and await its report before submitting the plan.`);
    }
    if (ev.permissionMode && ev.permissionMode !== 'plan') {
      return deny(s, 'Native plan approval requires plan mode. Call EnterPlanMode (or ask the user to press Shift+Tab until plan mode is shown), then call ExitPlanMode again.');
    }
    const content = planText(s, ev);
    if (!content.trim()) return deny(s, 'Forge could not find the plan text. Write the complete plan to the plan file (or pass it as the `plan` argument), then call ExitPlanMode again.');
    const contract = validatePlanContract(content);
    if (s.reworkBaseHash && contract.hash === s.reworkBaseHash) {
      contract.valid = false;
      contract.issues.push('Rework submission is identical to the previously approved plan. Revise it to address the QA failures.');
    }
    if (!contract.valid) {
      return deny({ ...s, planIssues: contract.issues, planValid: false }, `Forge plan contract is invalid. Fix before approval:\n${contract.issues.join('\n')}`);
    }
    const planPath = deps.savePlan ? deps.savePlan(s, content) : s.planPath;
    const next = {
      ...s, phase: 'PLAN', planWritten: true, planValid: true, approvedPlanHash: contract.hash,
      businessTopics: contract.topics, requirements: contract.requirements, testCases: contract.testCases,
      qualityGates: contract.qualityGates, planPath, planIssues: [], approved: false,
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
    if (tool === 'forge.requirement_summary') {
      let applied;
      try { applied = applyRequirementSummary(state, input); } catch (err) { return keep(state, { context: `Forge requirement summary rejected: ${err.message}` }); }
      const next = applied.state;
      const head = `Forge: requirement summary recorded (${applied.summarizedHigh} CRITICAL/HIGH, ${applied.summary.blockers.length} open blocker(s)) → PLAN.`;
      return keep(next, { context: `${head}\n\n${say(phaseInstruction(next))}` });
    }
    if (tool === 'forge.qa_scope') {
      const scope = deps.inspectWorkspaceScope ? deps.inspectWorkspaceScope(ev.cwd) : { available: false, files: [] };
      return keep(state, { context: `Forge QA scope (read-only git inventory):\n${JSON.stringify(scope, null, 2)}` });
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
    s = { ...s, agentCompletions: [...(s.agentCompletions ?? []), { gate: key, agent: name, reportedAt: new Date().toISOString(), resultPreview: text.slice(0, 800), reportedSeverities: countReportedSeverities(text) }].slice(-60) };
    const missing = missingGateAgentsFor(s);
    if (missing.length) return keep(queue(s, `Forge: ${agentRef(name)} reported for ${key}. Still waiting for: ${missing.map(agentRef).join(', ')}. Do not re-run agents that are still working.`));
    const gate = gateTransitionAfterAgents(s);
    return keep(gate.context ? queue(gate.state, gate.context) : gate.state);
  }

  /** All required specialists of the current gate reported: advance or instruct. */
  function gateTransitionAfterAgents(s) {
    if (s.phase === 'REQUIREMENT') {
      return { state: { ...s, requirementSummaryRequested: true }, context: say(requirementSummaryInstruction(s)) };
    }
    if (s.phase === 'PLAN') {
      return { state: s, context: say('[FORGE PLANNER REPORT RECEIVED]\nCompose the complete plan now (all mandatory contract sections) and submit it with ExitPlanMode while in plan mode. Do not implement.') };
    }
    if (s.phase === 'QA' && s.qaStatus !== 'PASS') return { state: s, context: `Forge: both independent QA reports arrived. Run safe checks, then call ${toolRef('forge_qa_submit')} exactly once with evidence-backed results.` };
    if (s.phase === 'QA' && s.qaStatus === 'PASS') return { state: s, context: `Forge: delivery report arrived. Call ${toolRef('forge_delivery_submit')} once, then print the commit message for the user.` };
    return { state: s };
  }

  /** Plan text from the ExitPlanMode argument, else from the host's plan file. */
  function planText(s, ev) {
    const inline = String(ev.input?.plan ?? '');
    if (inline.trim()) return inline;
    const path = ev.input?.planFilePath ?? ev.input?.plan_file_path ?? s.planDraftPath;
    return path && deps.readPlanFile ? String(deps.readPlanFile(path) ?? '') : '';
  }

  function planApproved(state, ev) {
    if (state.phase !== 'PLAN' || !state.planWritten || state.approved || state.planValid !== true || !state.approvedPlanHash) return keep(state);
    // The approved text can differ from the submitted one if the user edited it in the approval dialog.
    const content = planText(state, ev);
    const contract = content ? validatePlanContract(content) : null;
    if (contract && contract.hash !== state.approvedPlanHash) {
      if (!contract.valid) {
        return keep({ ...state, planValid: false, approved: false, planIssues: contract.issues, phase: 'PLAN' },
          { context: `Forge: the approved plan text no longer satisfies the plan contract, so execution is NOT authorized:\n${contract.issues.join('\n')}\nFix the plan and submit it again with ExitPlanMode.` });
      }
      const planPath = deps.savePlan ? deps.savePlan(state, content) : state.planPath;
      state = { ...state, approvedPlanHash: contract.hash, businessTopics: contract.topics, requirements: contract.requirements, testCases: contract.testCases, qualityGates: contract.qualityGates, planPath };
    }
    const next = approvedExecutionState(state, 'native-plan-approval');
    return keep(next, { context: say(executionInstruction(next)), message: 'Forge: plan approved (native). EXECUTE 3/4.' });
  }

  function qaSubmitted(state, ev) {
    let report;
    try { assertQaSubmittable(state, ev.input); report = evaluateQaReport(ev.input, state.businessTopics, state.requirements, state.qualityGates, state.testCases); }
    catch (err) { return keep(state, { context: `Forge QA report rejected: ${err.message}` }); }
    const workingTree = report.status === 'PASS' ? deps.snapshotWorkingTree?.(ev.cwd) ?? null : null;
    const meta = { slug: state.slug, planPath: state.planPath, approvedPlanHash: state.approvedPlanHash, generatedAt: new Date().toISOString() };
    const reportPath = deps.saveQaReport ? deps.saveQaReport(state, renderQaReport(report, meta), { ...meta, ...report }) : null;
    const next = qaReportTransition(state, report, { reportPath, workingTree });
    const failures = report.topics.flatMap(t => t.tests.filter(x => x.status !== 'PASS').map(x => `- ${t.id} ${t.name} / ${x.testId}: ${x.status} — ${x.scenario}`));
    const summary = `Forge QA GATE: ${report.status}\nPASS: ${report.counts.pass}, FAIL: ${report.counts.fail}, BLOCKED: ${report.counts.blocked}, NOT_RUN: ${report.counts.notRun}\nReport: ${reportPath ?? '(not saved)'}${failures.length ? `\nNon-passing:\n${failures.join('\n')}` : ''}${report.problems.length ? `\nGate blockers:\n${report.problems.join('\n')}` : ''}`;
    const follow = report.status === 'PASS' ? say(deliveryInstruction(next))
      : report.status === 'FAIL' ? say(reworkInstruction(next))
      : 'QA is BLOCKED by missing evidence, not an observed failure. The approved plan is retained. Tell the user to collect the evidence and run /forge qa, or /forge rework if code changes are needed. Do NOT edit code.';
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
    const nudge = (key, reason) => {
      const retries = state.agentRetries?.[key] ?? 0;
      if (retries >= MAX_STOP_NUDGES) return keep(state);
      return keep({ ...state, agentRetries: { ...(state.agentRetries ?? {}), [key]: retries + 1 } }, { continueReason: reason });
    };
    if (state.phase === 'EXECUTE' && state.approved && state.executionObserved) {
      if (!hasGateAgents(state)) return nudge('EXECUTE:stop', say(`Forge: the approved plan must be implemented by ${agentRef('forge-executor')} through the Agent tool. Invoke it now (or report execution blocked). Do not claim completion.`));
      const next = { ...state, phase: 'QA', qaStatus: null, qaRetries: 0, gateAgents: { ...(state.gateAgents ?? {}), QA: [] } };
      return keep(next, { continueReason: say(qaInstruction(next)), message: 'Forge: execution settled → independent QA 4/5.' });
    }
    if (state.phase === 'REQUIREMENT' && hasGateAgents(state)) return nudge('REQUIREMENT:summary', say(requirementSummaryInstruction(state)));
    if (state.phase === 'REQUIREMENT') {
      return nudge('REQUIREMENT:stop', say(`Forge REQUIREMENT: ${missingGateAgentsFor(state).map(agentRef).join(', ')} has not reported. Invoke it once through the Agent tool and await its report, or report the gate BLOCKED. Ask the user only for genuine business decisions.`));
    }
    if (state.phase === 'QA' && state.qaStatus !== 'PASS') return nudge('QA:stop', `Forge QA is incomplete: call ${toolRef('forge_qa_submit')} with evidence-backed results. If checks cannot run, submit BLOCKED/NOT_RUN; never fabricate PASS.`);
    if (state.phase === 'QA' && state.qaStatus === 'PASS') return nudge('QA:delivery', `Forge delivery is incomplete: run ${agentRef('forge-delivery')} if it has not reported, then call ${toolRef('forge_delivery_submit')}.`);
    return keep(state);
  }

  function onPrompt(state) {
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
        case 'prompt': return onPrompt(state);
        case 'session.start': return onSessionStart(state);
        default: return keep(state);
      }
    },
  };
}

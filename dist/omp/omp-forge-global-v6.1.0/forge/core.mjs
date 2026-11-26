/** Pure workflow and QA report logic; independent of the OMP runtime. */
import { createHash } from 'node:crypto';
import { normalizeForgeState } from './forge-state.mjs';

/** Forge agents per gate. The plan critic runs only when plan review is on for the run. */
export const GATE_AGENTS = Object.freeze({ PLAN: ['forge-plan-critic'], EXECUTE: [], QA: ['forge-code-reviewer'] });

/** Gate/role assignments are global operator settings, copied into each run. */
export const DEFAULT_AGENT_ASSIGNMENTS = Object.freeze({
  planning: Object.freeze({ critic: 'forge-plan-critic' }),
  qa: Object.freeze({ reviewer: 'forge-code-reviewer' }),
});
/** Portable config used by OMP today and a future Claude Code adapter. */
export const SKILL_GATES = Object.freeze(['planning','execution','qa','delivery']);
export const SKILL_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
export const MAX_SKILLS_PER_GATE = 6;
/** Validate a pasted SKILL.md before saving it into a global Gate Skill pack.
 *  Supports the portable, single-line name/description frontmatter subset.
 *  Complex YAML (aliases, nested objects, folded description) is deliberately
 *  not interpreted by Forge: create those packs manually and use skill add.
 */
export function validateSkillMarkdown(input, maxBytes = 24 * 1024) {
  if (typeof input !== 'string') throw new Error('SKILL.md must be text.');
  const content = input.replace(/\r\n/g, '\n');
  const size = Buffer.byteLength(content, 'utf8');
  if (!size || size > maxBytes) throw new Error(`SKILL.md must be 1–${maxBytes} UTF-8 bytes.`);
  if (content.includes('\0')) throw new Error('SKILL.md cannot contain NUL bytes.');
  const match = content.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) throw new Error('SKILL.md must start with YAML frontmatter delimited by --- lines.');
  const values = new Map();
  for (const line of match[1].split('\n')) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!field) throw new Error('Unsupported frontmatter syntax. Use single-line name: and description: fields.');
    const key = field[1].toLowerCase();
    if (values.has(key)) throw new Error(`Duplicate frontmatter field: ${key}.`);
    let value = field[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values.set(key, value);
  }
  const name = values.get('name');
  const description = values.get('description');
  if (typeof name !== 'string' || !SKILL_NAME_PATTERN.test(name)) throw new Error('Frontmatter name must be lowercase kebab-case (1–64 chars), starting with a letter.');
  if (typeof description !== 'string' || !description.trim() || /^[>|]$/.test(description) || description.length > 1024) {
    throw new Error('Frontmatter description must be a single, non-empty line (max 1024 characters).');
  }
  if (!content.slice(match[0].length).trim()) throw new Error('SKILL.md needs instructions after the YAML frontmatter.');
  return { name, description, content, size };
}

export function normalizeSkillGate(value) {
  const name = String(value ?? '').trim().toLowerCase();
  return ({req:'planning',requirement:'planning',requirements:'planning',cook:'planning',plan:'planning',exec:'execution',execute:'execution',review:'qa',deliver:'delivery'})[name]
    ?? (SKILL_GATES.includes(name) ? name : null);
}
export function cloneGateSkills(source) {
  const defaults = { planning: ['forge-plan-gate'], execution: ['forge-execute-gate'], qa: ['forge-qa-gate'], delivery: [] };
  const result = Object.fromEntries(SKILL_GATES.map(g => [g, [...defaults[g]]]));
  for (const gate of SKILL_GATES) {
    const values = source?.[gate];
    if (values == null) continue;
    if (!Array.isArray(values) || values.length > MAX_SKILLS_PER_GATE) throw new Error(`Invalid skills for ${gate}: expected at most ${MAX_SKILLS_PER_GATE} names.`);
    const set = new Set();
    for (const item of values) {
      if (typeof item !== 'string' || !SKILL_NAME_PATTERN.test(item)) throw new Error(`Invalid skill name for ${gate}: ${String(item)}`);
      if (set.has(item)) throw new Error(`Duplicate skill ${item} on ${gate}.`);
      set.add(item);
    }
    result[gate] = [...set];
  }
  // `requirement` is a legacy gate (removed in v6.2); old configs and checkpoints drop it silently.
  for (const gate of Object.keys(source ?? {})) if (!SKILL_GATES.includes(gate) && gate !== 'requirement') throw new Error(`Unknown skill gate ${gate}.`);
  return result;
}
export function addGateSkill(source, gateInput, name) {
  const gate = normalizeSkillGate(gateInput);
  if (!gate) throw new Error('Unknown skill gate. Use planning, execution, qa or delivery.');
  if (!SKILL_NAME_PATTERN.test(String(name ?? ''))) throw new Error('Skill name must be kebab-case, up to 64 characters.');
  const next = cloneGateSkills(source);
  if (!next[gate].includes(name)) next[gate].push(name);
  return cloneGateSkills(next);
}
export function removeGateSkill(source, gateInput, name) {
  const gate = normalizeSkillGate(gateInput);
  if (!gate) throw new Error('Unknown skill gate.');
  const next = cloneGateSkills(source);
  if (!next[gate].includes(name)) throw new Error(`Skill '${name}' is not attached to ${gate}.`);
  next[gate] = next[gate].filter(x => x !== name);
  return next;
}
export function resetGateSkills(source, gateInput = 'all') {
  if (gateInput === 'all') return cloneGateSkills();
  const gate = normalizeSkillGate(gateInput);
  if (!gate) throw new Error('Unknown skill gate.');
  const next = cloneGateSkills(source);
  next[gate] = [];
  return next;
}
export function formatGateSkills(source) {
  const mapping = cloneGateSkills(source);
  return SKILL_GATES.map(g => `${g.toUpperCase().padEnd(12)} ${mapping[g].length ? mapping[g].join(', ') : '(none)'}`).join('\n');
}
export function currentSkillGate(phase, qaStatus = null) {
  if (String(phase) === 'QA' && qaStatus === 'PASS') return 'delivery';
  return ({ PLAN:'planning', EXECUTE:'execution', QA:'qa' })[String(phase)] ?? null;
}
/** Main-session model per gate: `@role` alias, `provider/model-id`, or null (keep the current model). */
export const DEFAULT_GATE_MODELS = Object.freeze({ planning: '@plan', execution: '@default', qa: '@default', delivery: '@default' });
export const GATE_MODEL_SELECTOR_PATTERN = /^(?:@[A-Za-z0-9][\w.-]{0,63}|[A-Za-z0-9][A-Za-z0-9@._:\/+-]{0,127})$/;
export function cloneGateModels(source) {
  const result = { ...DEFAULT_GATE_MODELS };
  if (!source || typeof source !== 'object' || Array.isArray(source)) return result;
  for (const gate of SKILL_GATES) {
    const value = source[gate];
    if (value === undefined) continue;
    if (value === null) result[gate] = null;
    else if (typeof value === 'string' && GATE_MODEL_SELECTOR_PATTERN.test(value)) result[gate] = value;
    else throw new Error(`Invalid model for ${gate}: ${String(value)}`);
  }
  return result;
}
/** Main-session thinking level (effort) per gate; null keeps the session's current level. */
export const GATE_EFFORT_LEVELS = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto']);
export function cloneGateEfforts(source) {
  const result = Object.fromEntries(SKILL_GATES.map(g => [g, null]));
  if (!source || typeof source !== 'object' || Array.isArray(source)) return result;
  for (const gate of SKILL_GATES) {
    const value = source[gate];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && GATE_EFFORT_LEVELS.includes(value)) result[gate] = value;
    else throw new Error(`Invalid effort for ${gate}: ${String(value)}`);
  }
  return result;
}
export function formatGateModels(source, efforts) {
  const m = cloneGateModels(source);
  const e = cloneGateEfforts(efforts);
  return SKILL_GATES.map(g => `${g.toUpperCase().padEnd(12)} ${(m[g] ?? '(keep current model)').padEnd(36)} effort: ${e[g] ?? 'keep'}`).join('\n');
}
/** Apply skill text to every named subagent task, not just the lead orchestrator prompt. */
export function injectGateSkillsIntoTask(input, phase, skillBrief) {
  if (!skillBrief || !skillBrief.trim()) return input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const tag = '[FORGE GATE SKILLS — VERIFIED SNAPSHOT]';
  const append = task => typeof task === 'string' && !task.includes(tag) ? `${task}\n\n${tag}\n${skillBrief}\n[END FORGE GATE SKILLS]` : task;
  if (Array.isArray(input.tasks)) {
    if (!input.tasks.length || input.tasks.some(t => !t || typeof t !== 'object' || typeof t.task !== 'string' || !t.task.trim())) return null;
    return { ...input, tasks: input.tasks.map(t => ({ ...t, task: append(t.task) })) };
  }
  if (typeof input.task === 'string') return { ...input, task: append(input.task) };
  // Stepped tasks are not auto-enhanced: callers must provide a plain task string.
  return null;
}

/** Legacy run snapshots may include custom agents; new runs always use fixed OMP names. */
export function cloneAgentAssignments(source) {
  const clone = {};
  for (const [gate, defaults] of Object.entries(DEFAULT_AGENT_ASSIGNMENTS)) {
    clone[gate] = {};
    for (const [slot, fallback] of Object.entries(defaults)) {
      const value = source?.[gate]?.[slot];
      clone[gate][slot] = typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value) ? value : fallback;
    }
  }
  return clone;
}
/** Validate legacy snapshots; this is NOT a user-facing assignment API. */
export function validateAgentAssignments(assignments) {
  const value = cloneAgentAssignments(assignments);
  const used = new Set();
  for (const slots of Object.values(value)) for (const agent of Object.values(slots)) {
    if (used.has(agent)) throw new Error(`Duplicate Forge agent '${agent}' in workflow snapshot.`);
    used.add(agent);
  }
  return value;
}
export function effectiveAgentAssignments(state) {
  return cloneAgentAssignments(state?.agentAssignments);
}
export function agentNameFor(state, gate, role) {
  return effectiveAgentAssignments(state)[gate][role];
}
export function listAssignedAgentNames(assignments) {
  return Object.values(cloneAgentAssignments(assignments)).flatMap(roles => Object.values(roles));
}
export function formatAgentAssignments(assignments) {
  const current = cloneAgentAssignments(assignments);
  return Object.entries(current).flatMap(([gate, agents]) => [gate.toUpperCase(), ...Object.values(agents).map(name => `  ${name}`)]).join('\n');
}
const DEFAULT_NAMES_TO_ROLE = new Map(Object.entries(DEFAULT_AGENT_ASSIGNMENTS).flatMap(([gate, roles]) =>
  Object.entries(roles).map(([role, name]) => [name, [gate, role]])));
const DEFAULT_NAMES_RE = new RegExp('\\b(?:' + [...DEFAULT_NAMES_TO_ROLE.keys()].sort((a,b)=>b.length-a.length).join('|') + ')\\b', 'g');
export function routeAgentNames(instruction, state) {
  const values = effectiveAgentAssignments(state);
  return instruction.replace(DEFAULT_NAMES_RE, name => {
    const [gate, role] = DEFAULT_NAMES_TO_ROLE.get(name);
    return values[gate][role];
  });
}

/**
 * Minimal, always-on terminal progress: three work stages, no approval node.
 * Forge's own plan review shows 'Plan review' while a proposed plan awaits the human.
 * This is presentation-only; it never modifies the workflow state or gating.
 */
export function renderForgeWidget(state) {
  if (!state?.active) return null;
  const phase = String(state.phase ?? '');
  const awaitingReview = phase === 'PLAN' && state.planWritten && state.planValid && !state.approved;
  const decision = state.reworkDecisionPending === true;
  const stages = {
    PLAN: decision ? [2, 'QA failed · your decision'] : [0, awaitingReview ? 'Plan review' : 'Planning'],
    EXECUTE: [1, 'Execution'],
    QA: [2, state.qaStatus === 'PASS' ? 'Delivery' : decision ? 'QA blocked · your decision' : state.qaEvidencePending ? 'QA evidence needed' : 'QA review'],
  };
  const stage = stages[phase];
  if (!stage) return null;
  const [index, label] = stage;
  const meter = '▰'.repeat(index + 1) + '▱'.repeat(2 - index);
  const rework = phase === 'PLAN' && Number(state.reworkCycles) > 0
    ? `  ·  Rework ${Math.max(1, Math.trunc(Number(state.reworkCycles)))}` : '';
  const steering = Number(state.steeringRevision) > 0 ? `  ·  Steering ${Math.trunc(Number(state.steeringRevision))}` : '';
  return [`FORGE  ${meter}  ${label}  ${index + 1}/3${rework}${steering}`];
}

/** Prompts the user typed while a workflow ran. Each amends the original requirement (newest last). */
export function formatRequirementSteering(state) {
  const entries = Array.isArray(state?.requirementSteering) ? state.requirementSteering : [];
  if (!entries.length) return '';
  return `Requirement steering — prompts from the user while Forge was running (newest last). Each amends the original requirement and wins where they conflict; carry every one into the analysis, the plan and its traceability:\n${entries.map(e => `${e.revision ?? '-'}. [during ${e.phase}] ${e.text}`).join('\n')}`;
}
const steeringBlock = state => {
  const text = formatRequirementSteering(state);
  return text ? `\n\n${text}` : '';
};
export function requiredAgentsFor(state) {
  if (state?.phase === 'PLAN') return state.planReview === true ? [agentNameFor(state, 'planning', 'critic')] : [];
  if (state?.phase !== 'QA' || state.qaStatus === 'PASS') return [];
  return [agentNameFor(state, 'qa', 'reviewer')];
}
/** CRITICAL/HIGH finding IDs in a specialist report. Findings are one per line,
 * `CR-001 [HIGH] …` (code reviewer) or `PC-001 [CRITICAL] …` (plan critic). */
export function extractHighFindings(text) {
  const ids = new Set();
  for (const m of String(text ?? '').matchAll(/\b((?:CR|PC)-\d{3,})\b\W{0,6}(?:CRITICAL|HIGH)\b/gi)) ids.add(m[1].toUpperCase());
  return [...ids];
}
/** CRITICAL/HIGH IDs from the latest counted report of `agent` in `gate`, or [] when it has not reported in this cycle. */
export function latestHighFindings(state, gate, agent) {
  if (!(state?.gateAgents?.[gate] ?? []).includes(agent)) return [];
  const record = [...(state.agentCompletions ?? [])].reverse().find(c => c?.gate === gate && c.agent === agent);
  return Array.isArray(record?.highFindings) ? record.highFindings : [];
}
export function missingGateAgentsFor(state) {
  return requiredAgentsFor(state).filter(name => !(state?.gateAgents?.[state.phase] ?? []).includes(name));
}
/** Normalize legacy checkpoints before shared-core consumers inspect them. */
export function migrateLegacyRequirementState(state) {
  return normalizeForgeState(state);
}
export function missingGateAgents(phase, seen = []) {
  return (GATE_AGENTS[phase] ?? []).filter(agent => !seen.includes(agent));
}
export const PHASES = Object.freeze(['PLAN', 'EXECUTE', 'QA']);

export const NEXT_PHASE = Object.freeze({
  PLAN: 'EXECUTE',
  EXECUTE: 'QA',
});

export function planSlug() {
  return `forge-${Date.now().toString(36)}`;
}

export function initialState(requirement, slug = planSlug(), assignments = null, skills = null, skillPins = {}, { planReview = false } = {}) {
  if (!requirement || !requirement.trim()) throw new Error('Requirement must not be empty');
  return {
    version: 8,
    gateAgents: {},
    agentAssignments: validateAgentAssignments(assignments),
    gateSkills: cloneGateSkills(skills),
    skillPins: { ...skillPins },
    agentRetries: {},
    active: true,
    planReview: planReview === true,
    phase: 'PLAN',
    requirement: requirement.trim(),
    slug,
    proposalRetries: 0,
    approved: false,
    executionObserved: false,
    businessTopics: [],
    testCases: [],
    approvedCommands: [],
    reworkPlanSeededPath: null,
    planValid: false,
    approvedPlanHash: null,
    requirements: [],
    qualityGates: [],
    planPath: null,
    planWritten: false,
    qaStatus: null,
    qaEvidencePending: false,
    qaReportPath: null,
    reworkCycles: 0,
    deliveryPath: null,
    commitMessagePath: null,
    commitMessage: null,
  };
}

export function nextPhase(phase) {
  return NEXT_PHASE[phase] ?? null;
}

const HEADER = `[OMP FORGE — GLOBAL REQUIREMENT HARNESS]
You are the Forge lead: you plan, implement after approval, and verify. Forge runs its own plan mode: a read-only safety boundary holds until the human approves the plan in Forge's approval dialog. Do not edit the project, run mutating commands, commit, install dependencies, or create implementation code before explicit approval. Work with any domain, project, or no repository at all.
Never run git add, git commit, git push, git tag, git merge, git rebase, or publish changes on behalf of the user, at any stage. The user performs Git writes manually after delivery. Existing user constraints override your suggestions. Never invent evidence, tests, subagent calls, approvals, or locked decisions.
Submit the plan for approval only after writing a real local:// plan file: call forge_plan_propose. Forge validates the plan contract and opens its own approval dialog; only the human can approve.`;

/** Gate skills bound to the current gate; the main agent does the gate work, so it loads them. */
function skillDirective(state) {
  const gate = currentSkillGate(state?.phase, state?.qaStatus);
  const bound = gate ? state?.gateSkills?.[gate] : null;
  const names = (Array.isArray(bound) ? bound : gate ? cloneGateSkills()[gate] : [])
    .filter(n => typeof n === 'string' && SKILL_NAME_PATTERN.test(n));
  return names.length ? `Load and follow the ${names.join(', ')} skill${names.length > 1 ? 's' : ''}.\n\n` : '';
}

/** Optional plan critic (plan review on): run once on the written plan, before proposing it. */
function planReviewNote(state) {
  return state?.planReview === true ? `\nPLAN REVIEW is ON for this run: once the plan file is written, run \`forge-plan-critic\` ONCE through the native task tool; its task text gives the plan file path and the original requirement. Resolve every CRITICAL/HIGH finding it reports and cite its PC-id in the plan where it is resolved (or under Assumptions & contingencies with why it stands); Forge rejects the proposal until every such ID appears in the plan.` : '';
}

function phaseInstructionTemplate(state) {
  const { phase, requirement, slug } = state;
  if (phase === 'PLAN' && state.planWritten && state.planValid) return `${HEADER}\nThe plan is awaiting explicit operator approval. Do not implement.`;
  if (phase === 'PLAN' && state.planWritten) return `${HEADER}

[GATE 1/3: FORGE PLAN APPROVAL]
Review ${state.planPath ?? forgePlanPath(state)} for completeness and unresolved blockers. If ready, call forge_plan_propose: Forge validates the plan contract and opens the human approval dialog when this turn ends. Never self-approve. If the plan file was not written, write it first. Do not finish with just a textual 'ready' response.`;
  if (phase === 'PLAN' && state.reworkBaseHash) return reworkInstructionTemplate(state);

  if (phase === 'PLAN') {
    const delta = state.requirementSteering?.length && state.planPath ? `\nDELTA RUN: an earlier draft exists at ${state.planPath}. Read it, change only what the steering changes, and keep unaffected sections and stable BIZ/REQ/TC/QG IDs.` : '';
    return `${HEADER}

[GATE 1/3: PLAN — Forge plan mode]
Original user requirement:
${requirement}${steeringBlock(state)}${delta}

<critical>
- Working tree/system read-only: NEVER create, edit, delete, or rename working-tree files; NEVER run state-changing commands (installs, migrations, writing builds, git writes).
- The only writable file is Forge's plan file local://${slug}-plan.md (OMP session storage, not a workspace file): create it with write, then update it with edit as you learn; NEVER defer all writing to the end.
- Approval: call forge_plan_propose after a successful plan write; NEVER ask the user to approve in prose or with the native ask tool. After forge_plan_propose succeeds, end your turn: Forge opens its approval dialog.
</critical>

## What a plan is
Execution spec, not design doc. Approval may compact the conversation; another engineer or a fresh agent implements solely from the file. A competent implementer unfamiliar with this conversation MUST execute it top-to-bottom with ZERO design decisions; the file contains every choice.
Detail removes implementer decisions, not padding: a padded plan with an open decision, or a brief one that forces a choice, FAILED. Decision-completeness beats brevity.

## Plan file
edit: incremental changes only; write: create or full replacement only. Use ##/### sections.
Hashline edit: heading locator N* spans the section, deeper headings included, through the next same-or-higher heading: \`PUT N*:\` replaces it, \`CUT N*\` removes it, \`PUT >N*:\` appends a section after it (end the body with a blank line). N* needs a multi-line section; for a bare heading use \`PUT >N:\`/\`CUT N\`/\`PUT N:\`.

## Ground every claim
Resolve unknowns by discovery, not questions.
- Discoverable facts (locations, behavior, signatures, configs): discover them with glob, grep, read, or parallel \`scout\` subagents via the native task tool. Every path, symbol, signature and behavior you assert must be read in this session; mark anything unconfirmed inline as \`unverified — confirm first\`; NEVER state guesses as settled. Ask only when several real candidates remain; recommend one.
- Preferences and tradeoffs (intent, UX, scope edges, performance vs. simplicity) are not code-derivable: ask early with the native ask tool, 2–4 mutually exclusive options, recommended default preselected. Unanswered → use the default and record it under Assumptions. Every question must change the plan; batch them; never ask what exploration answers.

## Workflow
1. Understand — read the request and the supporting code. When the scope spans several areas, spawn parallel \`scout\` subagents with distinct focuses in ONE task call instead of reading everything yourself. Find reusable code before proposing new code.
2. Design — draft the approach from the findings, weigh tradeoffs briefly, commit to one.
3. Review — read the files you intend to change; validate the approach against the code and the literal request; resolve remaining preferences with the native ask tool.
4. Write — complete the plan per Plan contents, then call forge_plan_propose.${planReviewNote(state)}

## Plan contents
Scannable markdown; depth follows the change. Forge rejects a plan without ## Context, ## Approach, ## Verification and ## Assumptions & contingencies, or without the two Approach lines below.
- ## Context — the literal ask, the need and the intended end state in 2–4 sentences. Every requested outcome maps to a step; add nothing beyond the ask.
- ## Approach — ordered, load-bearing change steps grouped by behavior (NEVER by file), each tagged with the REQ IDs it satisfies. The tree builds and existing tests pass after each step; state dependencies and independencies. Each step names:
  - the concrete edit: verb, exact target, new behavior; never just an area to update;
  - existing functions/utilities to reuse, with paths; new code only when no equivalent exists;
  - exact signatures for new or changed symbols and exact literals for load-bearing values (enum member, error/log string, config key, wire/JSON field);
  - for a rename, signature change or removal: every callsite (or the exact grep returning them) plus deletions; clean cutover, no aliases;
  - the pattern to copy and the rival pattern to avoid, when both exist;
  - empty, missing, conflict and error handling for every new path, or why none is needed.
  It MUST contain the line 'Open decisions:' ('none', or one indented sub-bullet per decision, each with 'default: …'; no BLOCKER may remain — ask the user first) and the line 'Migration & rollback:' (data/schema/API/config migration and rollback steps, or 'not applicable — <reason>').
- ## Critical files & anchors — at most 5 files that disambiguate non-obvious work: path, symbol or region, one-line reason. Line numbers are hints. Omit files the Approach makes obvious.
- ## Verification — for every TC: the exact command or manual check, its prerequisites (cwd, env, fixtures, UI/state) and the expected observable output. Include at least one new-behavior check (concrete input → expected output) beyond build/typecheck/existing suite; tie risky steps to their checks.
- ## Assumptions & contingencies — only user-overridable decisions, each with a pre-decided fallback ('if reality is X, do Y instead'). Implementer decisions belong in Approach, never here.
- Forge QA contract — Forge parses these four sections; use this exact syntax, one item per line:
  - '## Business Topics': '- BIZ-001: <business capability>' (capabilities, not technical layers).
  - '## Requirement Traceability': '- REQ-001 | BIZ-001 | <expected behavior> | <acceptance criteria>'.
  - '## Business Test Cases': '- TC-001 | BIZ-001 | REQ-001,REQ-002 | <scenario> | <expected> | <verification method>'. Every REQ has at least one TC under the same BIZ; include negative and edge cases; IDs are unique.
  - '## Code Quality Gates': '- QG-001: <gate>' for tests, lint/static analysis, typecheck/build where applicable; mark not-applicable gates explicitly.
Cut decision-free material: restated invariants, unaffected behavior, mechanical repetition, narration. Specify what the implementer would otherwise invent.
Never add decision-free sections (Non-Goals, Out of Scope, Alternatives Considered, Risks/Mitigations, Future Work); state a material scope boundary as one inline line at the temptation point. Never plan a mechanical cleanup tail as Approach steps (changelog, doc updates, formatter/linter runs, scaffold removal); quality gates and behavior tests stay in Verification and the QA contract. Never invent unrequested schema, precedence or fallback policy unless it prevents a concrete mistake; then state the decision. Never reference this conversation ("as discussed"); state each choice inline.

<critical>
Before submitting: an engineer unfamiliar with this conversation can execute every step without a design decision and can tell success at each step; otherwise deepen the step.
Your turn ends ONLY by (1) the native ask tool gathering a required decision, or (2) forge_plan_propose after a successful plan write. Do not implement.
</critical>`;
  }

  return `${HEADER}\nThe plan is awaiting explicit operator approval. Do not implement.`;
}

/** An approved QA fix plan: the earlier plan steps already sit in the working tree. */
function isQaRework(state) {
  return Number(state.reworkCycles) > 0 && (state.reworkReason === 'QA_FAIL' || state.reworkReason === 'QA_BLOCKED');
}

function executionInstructionTemplate(state) {
  const planRef = state.planPath ?? `local://${state.slug}-plan.md`;
  const rework = isQaRework(state);
  const fixScope = rework ? `
QA REWORK cycle #${state.reworkCycles}: the earlier plan steps are already implemented in the working tree. Implement only the remediation steps for the open items below; do not redo or re-verify earlier steps unless a remediation step changes them. Verify each fix with the checks of its TCs and gates; leave the full regression run to QA.
Open items from the last QA report:
${formatOpenItems(state.qaOpenItems)}` : '';
  return `[OMP FORGE — APPROVED EXECUTION]
The operator approved the plan. Execute it yourself, step by step, with full tool access; MUST verify each step before the next. Before you start, initialize todo tracking with one item per ${rework ? 'remediation' : 'plan'} step; update it after each completed step. NEVER re-read the plan file while the inline plan is intact; read ${planRef} only if the inline plan is compressed or missing.${fixScope}
Stay within the approved scope. If material scope drift is required, stop and report it; a revised plan needs new approval. You may delegate independent slices to subagents through the native task tool; you own integration and verification. NEVER run git add/commit/push, create PRs, tag or publish; Git commits stay a manual user action.
When every step is done or blocked, call forge_execution_done once with the changed files, the checks actually run with their exact results, unfinished work and deviations from the plan; then end your turn. Forge starts QA only after forge_execution_done: ending a turn without it does not start QA, so never end the turn with a question or a progress note; ask the user with the native ask tool when you need a decision. Do not claim tests passed that you did not run.
Plan reference: ${planRef}
Business topics captured: ${formatTopics(state.businessTopics)}.`;
}

/** What the executor reported through forge_execution_done; QA treats it as a lead, not as evidence. */
function formatExecutionReport(report) {
  if (!report || typeof report !== 'object') return '';
  const list = (label, items) => Array.isArray(items) && items.length ? `\n- ${label}: ${items.slice(0, 40).join('; ')}` : '';
  return `\nExecutor report (unverified; verify it yourself):${report.summary ? `\n- Summary: ${report.summary}` : ''}${list('Changed files', report.changedFiles)}${list('Checks run', report.checksRun)}${list('Unfinished', report.unfinished)}${list('Deviations', report.deviations)}\n`;
}

function qaInstructionTemplate(state) {
  const planRef = state.planPath ?? `local://${state.slug}-plan.md`;
  return `[OMP FORGE — POST-EXECUTION QA REVIEW — READ-ONLY]
The approved implementation turn has settled. Verify it against the approved plan yourself while one independent reviewer runs in parallel. Enforce the EXACT test IDs from the approved plan; never invent replacement TC IDs. Do NOT edit code, install dependencies, run migrations, commit, or auto-fix.

1. Call forge_qa_scope for the read-only Git diff inventory; use it instead of chaining git status/diff yourself.
2. In ONE response, issue in parallel: (a) the native task call for \`forge-code-reviewer\`, whose task text contains the approved plan reference, the changed files from forge_qa_scope, the QG IDs, and "review only these changed files and their direct callers; report severity-ranked findings with file:line"; (b) the check commands written in the plan's Verification and Code Quality Gates. QA may run those commands verbatim, read-only inspection, and test/lint/typecheck runners with arguments; steps may be chained with && and piped into head/tail/grep. File redirects, installs, mutating flags (--fix, --write, -u) and multi-line scripts are refused. Run each check in this QA turn; results from the implementation turn are not QA evidence.
3. While the reviewer works, check every approved TC yourself: read the changed code and match each acceptance criterion to observed evidence (command output, file:line). Code inspection is not evidence that a runtime test ran; unrun checks are NOT_RUN. If the diff is empty, verify the approved end state against the existing sources and run feasible checks; an empty diff alone is not proof.
4. Call forge_qa_submit once: for every approved TC its testId, the actual observed result, PASS/FAIL/BLOCKED/NOT_RUN, evidence and severity (Forge fills in its BIZ, REQ, scenario and expected text from the plan); one codeQualityChecks entry per QG ID; codeReview with the reviewer's findings (severity, file:line) plus your own. Every CRITICAL/HIGH reviewer finding must appear in codeReview.findings under its CR-id, either at CRITICAL/HIGH or with evidence starting "Disputed:" and your counter-evidence; Forge rejects a submission that drops one. If Forge reports format errors (missing, unplanned or duplicate IDs, PASS without evidence), nothing is recorded: fix them and submit again. Forge computes the gate; never declare PASS yourself. If the tool is unavailable, report that QA could not be completed.

Original requirement: ${state.requirement}
Approved plan reference: ${planRef}${formatExecutionReport(state.executionReport)}
Business topics from the plan review:
${formatTopics(state.businessTopics)}
Approved test cases (every one is mandatory):
${formatTestCases(state.testCases)}
Mapped requirements from the plan review:
${formatRequirements(state.requirements)}
Code quality gates from the plan review:
${formatQualityGates(state.qualityGates)}

After forge_qa_submit, Forge shows the user a QA summary table. On FAIL or BLOCKED, end your turn: the user decides whether to plan a fix (the fix plan needs approval again) or, for BLOCKED, to rerun QA after collecting evidence; never draft a fix plan or touch code before that decision. On PASS, prepare delivery. Never stage, commit or push.`;
}

function reworkPlanPath(state) {
  const cycle = Math.max(1, Number(state.reworkCycles) || 1);
  const basePlanPath = state.reworkBasePlanPath ?? `local://${state.slug}-plan.md`;
  return state.planPath && state.planPath !== basePlanPath
    ? state.planPath
    : `local://${state.slug}-rework-${cycle}-plan.md`;
}

/** The only plan file Forge's own plan mode accepts in the current PLAN gate. */
export function forgePlanPath(state) {
  return state?.reworkBaseHash ? reworkPlanPath(state) : `local://${state.slug}-plan.md`;
}

function reworkInstructionTemplate(state) {
  const nextPlanPath = reworkPlanPath(state);
  const seeded = state.reworkPlanSeededPath === nextPlanPath;
  const steered = state.reworkReason === 'STEERING';
  const trigger = steered
    ? `[OMP FORGE — USER STEERING: REWORK PLAN, NEW APPROVAL REQUIRED]
Trigger: a prompt from the user while the approved plan was running; its approval is revoked. Rework cycle #${state.reworkCycles ?? 1}.
Original requirement: ${state.requirement}
Previous approved plan: ${state.reworkBasePlanPath ?? `local://${state.slug}-plan.md`}`
    : `[OMP FORGE — QA FAILED: REWORK PLAN, NEW APPROVAL REQUIRED]
QA gate: ${state.qaStatus ?? 'BLOCKED'}; rework cycle #${state.reworkCycles ?? 1}.
Original requirement: ${state.requirement}
Previous approved plan: ${state.reworkBasePlanPath ?? `local://${state.slug}-plan.md`}
QA failure evidence (read this report): ${state.qaReportPath ?? 'not available'}`;
  const compare = steered
    ? 'Compare the requirement steering with the previous approved plan, the original requirement and the work already in the working tree. DELTA RUN: read the previous approved plan and change only the sections the steering changes; keep what still holds and its stable IDs unchanged, and add BIZ/REQ/TC entries for new scope.'
    : 'Read the QA report and the previous approved plan; trace each fix-scope item to its root cause.';
  const explore = steered
    ? 'explore with glob, grep, read or parallel \`scout\` subagents via the native task tool'
    : `targeted lookup only: the previous approved plan already holds the codebase findings, so read just the QA report, ${seeded ? `${nextPlanPath} (Forge's copy of that plan)` : 'that plan'} and the files the fix-scope items name, with glob, grep and read; spawn \`scout\` subagents only when a root cause lies outside those files`;
  const revise = seeded
    ? (steered
      ? `Forge already copied the previous approved plan to ${nextPlanPath}. Revise that copy in place with small edit calls for the steering, add remediation tasks and a new test matrix, and NEVER rewrite the whole file with write. Do NOT erase unfinished or blocked tests.`
      : `Forge already copied the previous approved plan to ${nextPlanPath}. Revise that copy in place with small edit calls: add remediation steps for the fix-scope items to ## Approach, change only their TCs and Verification lines, add ## QA Rework Changes, and keep every other section, passing BIZ/REQ/TC/QG and ID verbatim. NEVER rewrite the whole file with write. Keep the full test matrix; do NOT erase unfinished or blocked tests.`)
    : (steered
      ? 'The revised plan must include remediation tasks and a new test matrix. Do NOT erase unfinished or blocked tests.'
      : 'Build the revision from the previous approved plan\'s full text, not from scratch: add remediation steps for the fix-scope items to ## Approach, change only their TCs and Verification lines, and keep every other section, passing BIZ/REQ/TC/QG and ID verbatim. Keep the full test matrix; do NOT erase unfinished or blocked tests.');
  const saveSentence = seeded
    ? `Edit ${nextPlanPath}; never modify the previous approved plan.`
    : `Save a revised plan to ${nextPlanPath}; never overwrite the previous approved plan.`;
  const scope = steered ? '' : `\n\nFix scope (non-PASS items from the QA report; fix only these):\n${formatOpenItems(state.qaOpenItems)}`;
  const notes = state.reworkNotes ? `\n\nOperator notes for this fix (given when the operator chose to plan it):\n${state.reworkNotes}` : '';
  return `${trigger}${steeringBlock(state)}${scope}${notes}

Re-plan in Forge plan mode yourself; there is no planner agent. The PLAN gate rules apply: read-only working tree; ${explore}; use the native ask tool only for real preferences. Forge PLAN owns rework drafting. Keep the revision in Forge's own plan mode; do not enter OMP's native Plan Mode, and do not ask the user to change modes. Absolutely no implementation, code edits, test fixes, git add/commit/push or mutating commands. ${compare} Group repairs by Business Topic and Test Case (BIZ/REQ/TC/QG), identify root causes, and preserve stable IDs. ${saveSentence} ${revise} Explicitly explain what changes, why, and what will be reverified.

Keep the sections ## Context, ## Approach, ## Critical files & anchors, ## Verification, ## Assumptions & contingencies, the Forge QA contract sections ## Business Topics, ## Requirement Traceability, ## Business Test Cases, ## Code Quality Gates, and add ## QA Rework Changes; Approach keeps its 'Open decisions:' and 'Migration & rollback:' lines. If the user selects Refine, keep editing the same rework revision at ${nextPlanPath}. After a successful rework-plan write, call forge_plan_propose; Forge opens the human approval dialog when this turn ends. Do not ask the user to submit or advance a gate. Do NOT auto-approve or implement.${planReviewNote(state)}`;
}

function deliveryInstructionTemplate(state) {
  const planRef = state.planPath ?? `local://${state.slug}-plan.md`;
  return `[OMP FORGE — DELIVERY PREPARATION — QA PASSED]
All planned business QA and code quality gates passed according to the structured QA report. Prepare delivery yourself: read the QA report and inspect git status --short and git diff --stat (read-only). This is DELIVERY ONLY, not implementation.
Requirement: ${state.requirement}
Approved plan: ${planRef}
QA report: ${state.qaReportPath ?? 'missing'}
Business topics: ${formatTopics(state.businessTopics)}

Do not stage, commit, push, tag, merge, rebase, publish, or change project files. Base the Conventional Commits message ONLY on actual changes and verified QA evidence. If there are no changes, or git metadata is unavailable, say so; do not invent changed files. Do not claim deploy/release completed.

Submit once using forge_delivery_submit with:
- subject: Conventional Commits '<type>(<scope>): <summary>', at most ${COMMIT_SUBJECT_MAX} characters in total. Pick the type that matches the actual change (the dominant one when mixed):
${Object.entries(COMMIT_TYPES).map(([type, use]) => `  - ${type}: ${use}`).join('\n')}
  Scope is optional: one lowercase word for the area (e.g. auth, booking). Add ! after the type or scope for a breaking change. Summary: imperative mood, lowercase start, no trailing period. Count the characters before submitting, e.g. feat(booking): add room approvals.
- body: concise newline-separated bullet points about real changes, avoid unproven claims
- highlights: user-facing delivery summary
- changedFiles: actual filenames from inspection where available
Forge answers with a delivery summary table and the copy-ready commit message; finish as that result tells you.`;
}

// Prompt routing uses the same immutable per-workflow roster as task gates and QA validation.
export const phaseInstruction = state => {
  if (state.phase === 'EXECUTE') return executionInstruction(state);
  if (state.phase === 'QA') return state.qaStatus === 'PASS' ? deliveryInstruction(state) : qaInstruction(state);
  return `${skillDirective(state)}${routeAgentNames(phaseInstructionTemplate(state), state)}`;
};
export const planDecisionReminder = state => `[FORGE PLAN — turn ended without a required tool call]
Choose exactly one next action now: (1) call the native ask tool to gather a required decision, OR (2) write the complete plan to ${forgePlanPath(state)} if it is not written yet, then call forge_plan_propose. Do not end the turn with plain text.`;
export const executionReminder = () => `[FORGE EXECUTE — turn ended without forge_execution_done]
The approved plan is not marked complete, so QA has not started. Continue the remaining steps now. When every step is done or blocked, call forge_execution_done, then end your turn. If you need a decision from the user, use the native ask tool; never end the turn with a question or a progress note.`;

const SKILL_DIRECTIVE = /^Load and follow the ([a-z0-9-]+(?:, [a-z0-9-]+)*) skills?\.\n\n/m;
/** SKILL.md body without its YAML frontmatter. */
export function stripFrontmatter(content) {
  return String(content ?? '').replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
}
/** Who a gate skill is written for (`forge-audience` frontmatter): the main agent doing the gate
 * work (`lead`), the gate's specialist subagents (`specialist`), or both (`all`, the default). */
export function skillAudience(content) {
  const front = String(content ?? '').match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
  const value = front.match(/^forge-audience\s*:\s*["']?(lead|specialist|all)["']?\s*$/mi)?.[1]?.toLowerCase();
  return value ?? 'all';
}
/** Replace the "Load and follow the … skill" line with the skills' text, so the agent needs no
 * extra tool call and gets exactly the content the adapter verified. `load(names)` returns
 * `[{ name, content }]`; an empty result keeps the instruction unchanged. */
export function inlineGateSkills(text, load) {
  const value = String(text ?? '');
  const match = value.match(SKILL_DIRECTIVE);
  if (!match) return value;
  const skills = (load(match[1].split(', ')) ?? []).filter(s => s && stripFrontmatter(s.content).trim());
  if (!skills.length) return value;
  const block = `[FORGE GATE SKILLS — apply to the current gate; Forge policies and the gate instruction take precedence]\n${skills.map(s => `### Skill: ${s.name}\n${stripFrontmatter(s.content).trim()}`).join('\n\n')}\n[END FORGE GATE SKILLS]\n\n`;
  return value.slice(0, match.index) + block + value.slice(match.index + match[0].length);
}
export const executionInstruction = state => `${skillDirective(state)}${routeAgentNames(executionInstructionTemplate(state), state)}`;
export const qaInstruction = state => `${skillDirective(state)}${routeAgentNames(qaInstructionTemplate(state), state)}`;
export const reworkInstruction = state => `${skillDirective(state)}${routeAgentNames(reworkInstructionTemplate(state), state)}`;
export const deliveryInstruction = state => `${skillDirective(state)}${routeAgentNames(deliveryInstructionTemplate(state), state)}`;
const STEERING_EFFECT = {
  PLAN: 'Any proposed plan is withdrawn; plan again with this steering before approval.',
  REVOKED: 'Approval of the running plan is revoked: stop implementation and QA work now. A revised plan needs new human approval.',
};
/** Replaces a prompt the user typed while a workflow ran: the steering status, then the
 * re-entered gate. The prompt itself appears once, verbatim, in that gate's steering list. */
export const steeringInstruction = (state, { from, revoked = false }) => `[FORGE STEERING — PROMPT FROM USER]
Steering status: #${state.steeringRevision ?? 1} · ${from} → ${state.phase}. ${revoked ? STEERING_EFFECT.REVOKED : STEERING_EFFECT[state.phase] ?? STEERING_EFFECT.PLAN}
The user's prompt is steering #${state.steeringRevision ?? 1} in the list below. Start your reply with the steering status line. If the prompt asks a question, answer it briefly, then continue the gate with the steering applied.

${phaseInstruction(state)}`;

/** This guard covers obvious agent-authored Git writes, not subprocesses or arbitrary user scripts. */
export function isProhibitedGitCommand(command) {
  const text = String(command ?? '').replace(/\\\s*\n/g, ' ');
  // Detect git, absolute git paths and common shell wrappers. Conservative by design.
  // `hub` wraps every git subcommand. clean/restore/rm/mv destroy or stage working-tree state.
  const git = /(?:^|[^\w-])(?:git|hub|\/(?:usr\/)?(?:local\/)?bin\/git)(?:\s+(?:-C\s+\S+|--git-dir(?:=|\s+)\S+|--work-tree(?:=|\s+)\S+|-c\s+\S+))*\s+(?:add|commit|push|tag|merge|rebase|reset|checkout|switch|cherry-pick|am|apply|stash|pull|clean|restore|rm|mv|fetch\s+--update-head-ok)\b/i;
  const cli = /(?:^|[^\w-])(?:gh|hub|glab)\s+(?:pr\s+(?:create|merge)|mr\s+(?:create|merge)|release\s+create|repo\s+(?:sync|fork))\b/i;
  const plumbing = /(?:^|[^\w-])git\s+(?:update-ref|write-tree|commit-tree|update-index|push|send-pack)\b/i;
  const releaseScripts = /(?:^|[^\w-])(?:npm|pnpm|yarn|bun)\s+(?:(?:run|run-script)\s+)?(?:release|publish|deploy|commit|push|version|tag)(?:\s|$)/i;
  const releaseTools = /(?:^|[^\w-])(?:semantic-release|standard-version|changeset\s+publish|lerna\s+publish|npm\s+publish|make\s+(?:release|publish)|npx\s+semantic-release)\b/i;
  // Catch basic subprocess array calls such as subprocess.run(['git','commit',...]).
  const arrayCall = /[\[,(]\s*['"]git['"]\s*,\s*['"](?:add|commit|push|tag|merge|rebase|reset|checkout|switch|cherry-pick|clean|restore|rm|mv|commit-tree|update-ref)['"]/i;
  return git.test(text) || cli.test(text) || plumbing.test(text) || releaseScripts.test(text) || releaseTools.test(text) || arrayCall.test(text);
}

/** Conventional Commits types Forge accepts, with when each one fits. */
export const COMMIT_TYPES = Object.freeze({
  feat: 'a new user-facing capability',
  fix: 'a bug fix',
  docs: 'documentation only',
  style: 'formatting only, no behavior change',
  refactor: 'restructured code, no behavior change',
  perf: 'a performance improvement',
  test: 'tests only',
  build: 'build system or dependencies',
  ci: 'CI configuration',
  chore: 'maintenance with no product behavior change',
  revert: 'reverts an earlier commit',
});
export const COMMIT_SUBJECT_MAX = 72;
const COMMIT_SUBJECT = new RegExp(`^(${Object.keys(COMMIT_TYPES).join('|')})(?:\\(([a-z0-9][a-z0-9._/-]*)\\))?(!)?: ([^\\r\\n]{4,})$`, 'i');

/** Split a Conventional Commits subject into its parts; null when it does not follow the format. */
export function parseCommitSubject(subject) {
  const line = String(subject ?? '').replace(/[\r\n]+/g, ' ').trim();
  const m = COMMIT_SUBJECT.exec(line);
  return m ? { line, type: m[1].toLowerCase(), scope: m[2] ?? null, breaking: Boolean(m[3]), summary: m[4] } : null;
}

/** A suggestion only: it is never used as a shell command by Forge. */
export function buildCommitMessage(subject, body = '') {
  const parsed = parseCommitSubject(subject);
  if (!parsed) {
    throw new Error(`Commit subject must follow Conventional Commits '<type>(<scope>): <summary>' with type one of ${Object.keys(COMMIT_TYPES).join(', ')}; e.g. feat(booking): add room approvals.`);
  }
  const { line, summary } = parsed;
  if (line.length > COMMIT_SUBJECT_MAX) {
    throw new Error(`Commit subject is ${line.length} characters; the limit is ${COMMIT_SUBJECT_MAX} characters including '${line.slice(0, line.length - summary.length)}'. Shorten the summary by at least ${line.length - COMMIT_SUBJECT_MAX} characters.`);
  }
  if (/[\x00-\x1f\x7f]/.test(line)) throw new Error('Invalid control characters in commit subject.');
  const rawBody = String(body ?? '').replace(/\r/g, '').trim();
  if (rawBody.length > 4000) throw new Error('Commit body is too long.');
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(rawBody)) throw new Error('Invalid control characters in commit message.');
  return line + (rawBody ? `\n\n${rawBody}` : '') + '\n';
}

export function renderDeliveryReport(payload) {
  const { slug, planPath, qaReportPath, generatedAt, commitMessage, highlights, changedFiles, diffAudit } = payload;
  const lines = [
    '# OMP Forge — Delivery', '',
    '- **Status:** QA PASS — READY FOR MANUAL COMMIT',
    `- **Workflow:** ${slug}`,
    `- **Approved plan:** ${planPath ?? 'unknown'}`,
    `- **QA evidence:** ${qaReportPath ?? 'unknown'}`,
    `- **Generated:** ${generatedAt}`,
    `- **Post-QA working-tree audit:** ${diffAudit ?? 'UNAVAILABLE'}`,
    '', '## Delivery Summary', '',
    ...(Array.isArray(highlights) && highlights.length ? highlights.map(x => `- ${x}`) : ['- No highlights supplied.']),
    '', '## Changed Files', '',
    ...(Array.isArray(changedFiles) && changedFiles.length ? changedFiles.map(x => `- \`${x}\``) : ['- No changed files reported; inspect git status before committing.']),
    '', '## Suggested Commit Message (copy & paste)', '', '```text', String(commitMessage ?? '').trimEnd(), '```',
    '', '> Forge has NOT staged, committed, pushed, tagged, or released any changes. Review the diff and run Git manually.',
  ];
  return lines.join('\n') + '\n';
}

function formatQualityGates(gates) {
  return Array.isArray(gates) && gates.length
    ? gates.map(g => `- ${g.id}: ${g.name}`).join('\n')
    : '- NONE CAPTURED: QA must BLOCK if no quality gates were planned.';
}

function formatRequirements(requirements) {
  return Array.isArray(requirements) && requirements.length
    ? requirements.map(r => `- ${r.id} -> ${r.topicId}: ${r.expected}`).join('\n')
    : '- NONE CAPTURED: the QA gate must BLOCK until requirements are mapped.';
}

function formatTopics(topics) {
  return Array.isArray(topics) && topics.length
    ? topics.map(t => `- ${t.id}: ${t.name}`).join('\n')
    : '- NONE CAPTURED: the QA gate must BLOCK until the plan has traceable BIZ IDs.';
}

/** Lines of the first `## <heading>` section (until the next #/## heading), or null when absent.
 * Fenced code blocks never open or close a section; their lines come back with `fenced: true`. */
function sectionEntries(planContent, heading) {
  let fence = null;
  let inSection = false;
  const entries = [];
  for (const line of String(planContent ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    const marker = trimmed.match(/^(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1][0];
      else if (marker[1][0] === fence) fence = null;
      continue;
    }
    if (fence) { if (inSection) entries.push({ line, fenced: true }); continue; }
    if (!inSection) { if (heading.test(trimmed)) inSection = true; continue; }
    if (/^#{1,2}\s+/.test(trimmed)) break;
    entries.push({ line, fenced: false });
  }
  return inSection ? entries : null;
}
/** Contract rows (regex matches) of a section, ignoring fenced examples. */
function contractRows(planContent, heading, row) {
  return (sectionEntries(planContent, heading) ?? []).filter(e => !e.fenced).map(e => e.line.match(row)).filter(Boolean);
}
function firstById(matches, build) {
  const seen = new Set();
  return matches.flatMap(m => { const id = m[1].toUpperCase(); if (seen.has(id)) return []; seen.add(id); return [build(id, m)]; });
}
function duplicateIds(matches) {
  const seen = new Set(), dup = new Set();
  for (const m of matches) { const id = m[1].toUpperCase(); if (seen.has(id)) dup.add(id); seen.add(id); }
  return [...dup];
}
const CONTRACT = Object.freeze({
  topics: [/^##\s+Business Topics\s*$/i, /^\s*(?:[-*]\s+|#{3,6}\s+)(BIZ-\d{3,})\s*[:\-–—]\s*(.+?)\s*$/i],
  requirements: [/^##\s+Requirement Traceability\s*$/i, /^\s*[-*]\s*(REQ-\d{3,})\s*(?:\|\s*(BIZ-\d{3,})\s*\|\s*(.+?)\s*\|\s*(.+?)|->\s*(BIZ-\d{3,}))\s*$/i],
  testCases: [/^##\s+Business Test Cases\s*$/i, /^\s*[-*]\s*(TC-\d{3,})\s*\|\s*(BIZ-\d{3,})\s*\|\s*([A-Za-z0-9,\s-]+)\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*(.+?)\s*$/i],
  qualityGates: [/^##\s+Code Quality Gates\s*$/i, /^\s*[-*]\s*(QG-\d{3,})\s*[:\-–—]\s*(.+?)\s*$/i],
});

/** Extract topics only from the explicit contract section; avoid incidental BIZ references. */
export function extractBusinessTopics(planContent) {
  return firstById(contractRows(planContent, ...CONTRACT.topics), (id, m) => ({ id, name: m[2].trim() }));
}

/** Exact approved test cases are the post-execution QA contract (no replacing TC IDs). */
export function extractBusinessTestCases(planContent) {
  return contractRows(planContent, ...CONTRACT.testCases).map(m => ({
    id: m[1].toUpperCase(), topicId: m[2].toUpperCase(),
    requirementIds: m[3].split(',').map(x => x.trim().toUpperCase()).filter(Boolean),
    scenario: m[4].trim(), expected: m[5].trim(), method: m[6].trim(),
  }));
}

/** Plan sections Forge enforces besides the four QA-contract sections. `&` also matches "and". */
const PLAN_SECTIONS = Object.freeze(['Context', 'Approach', 'Verification', 'Assumptions & contingencies']);
/** Body lines of a `## <name>` section outside fenced code, or null when absent. */
function planSectionLines(planContent, name) {
  const heading = new RegExp(`^##\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('&', '(?:&|and)')}\\s*$`, 'i');
  const entries = sectionEntries(planContent, heading);
  return entries ? entries.filter(e => !e.fenced).map(e => e.line) : null;
}
/** Items of a `Label: value` line plus its sub-bullets, or null when the line is absent. */
function labeledItems(lines, label) {
  const pattern = new RegExp(`^(\\s*)([-*]\\s+)?\\**${label}\\**\\s*:\\**\\s*(.*)$`, 'i');
  const index = lines.findIndex(line => pattern.test(line));
  if (index < 0) return null;
  const [, indent, bullet, value] = lines[index].match(pattern);
  const items = value.trim() ? [value.trim()] : [];
  // Sub-bullets must be nested under the label, except under a bare heading-style "Label:" line.
  const nestedOnly = Boolean(bullet) || items.length > 0;
  for (const line of lines.slice(index + 1)) {
    const item = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (!item || (nestedOnly ? item[1].length <= indent.length : item[1].length < indent.length)) break;
    items.push(item[2].trim());
  }
  return items;
}
function decisionIssues(planContent) {
  const issues = [];
  for (const name of PLAN_SECTIONS) if (!planSectionLines(planContent, name)) issues.push(`Missing ## ${name} section.`);
  const approach = planSectionLines(planContent, 'Approach');
  if (!approach) return issues;
  const decisions = labeledItems(approach, 'Open decisions');
  if (!decisions) issues.push('## Approach needs an "Open decisions:" line: "none", or each open decision with "default: …".');
  else if (!decisions.length) issues.push('"Open decisions:" is empty: write "none" or list each decision with "default: …".');
  else for (const item of decisions) {
    if (/^none\b/i.test(item)) continue;
    const shown = item.length > 80 ? `${item.slice(0, 80)}…` : item;
    if (/\bBLOCKER\b/i.test(item)) issues.push(`Open decision "${shown}" is a BLOCKER: resolve it with the user before proposing.`);
    else if (!/\bdefault\s*:/i.test(item)) issues.push(`Open decision "${shown}" needs "default: …".`);
  }
  const rollback = labeledItems(approach, 'Migration\\s*(?:&|and)\\s*rollback');
  if (!rollback) issues.push('## Approach needs a "Migration & rollback:" line: the steps, or "not applicable — <reason>".');
  else if (!rollback.length) issues.push('"Migration & rollback:" is empty: give the steps, or "not applicable — <reason>".');
  return issues;
}

export function validatePlanContract(planContent) {
  const topics = extractBusinessTopics(planContent);
  const requirements = extractRequirementTraceability(planContent);
  const qualityGates = extractCodeQualityGates(planContent);
  const testCases = extractBusinessTestCases(planContent);
  const issues = [];
  if (!topics.length) issues.push('Missing ## Business Topics section or BIZ IDs.');
  if (!requirements.length) issues.push('Missing ## Requirement Traceability section or REQ IDs.');
  if (!testCases.length) issues.push('Missing ## Business Test Cases with required TC | BIZ | REQ | scenario | expected | method format.');
  if (!qualityGates.length) issues.push('Missing ## Code Quality Gates or QG IDs.');
  const topicIds = new Set(topics.map(x=>x.id));
  const reqIds = new Set(requirements.map(x=>x.id));
  const seenTests = new Set();
  for (const req of requirements) {
    if (!topicIds.has(req.topicId)) issues.push(`${req.id} references unknown ${req.topicId}.`);
    if (!req.expected || !req.acceptance) issues.push(`${req.id} requires behavior and acceptance criteria.`);
    if (!testCases.some(t=>t.topicId===req.topicId && t.requirementIds.includes(req.id))) issues.push(`${req.id} has no test case under ${req.topicId}.`);
  }
  for (const t of testCases) {
    if (seenTests.has(t.id)) issues.push(`${t.id} is duplicated.`);
    seenTests.add(t.id);
    if (!topicIds.has(t.topicId)) issues.push(`${t.id} references unknown ${t.topicId}.`);
    if (!t.requirementIds.length) issues.push(`${t.id} has no requirement IDs.`);
    for (const id of t.requirementIds) {
      if (!reqIds.has(id)) issues.push(`${t.id} references unknown ${id}.`);
      else if (requirements.find(x=>x.id===id)?.topicId !== t.topicId) issues.push(`${t.id} maps ${id} to the wrong business topic.`);
    }
    if (!t.scenario || !t.expected || !t.method) issues.push(`${t.id} is missing scenario, expected outcome, or method.`);
  }
  for (const key of ['topics', 'requirements', 'qualityGates']) {
    for (const id of duplicateIds(contractRows(planContent, ...CONTRACT[key]))) issues.push(`${id} is duplicated.`);
  }
  issues.push(...decisionIssues(planContent));
  return { valid: issues.length===0, issues, topics, requirements, qualityGates, testCases,
    commands: extractApprovedCommands(planContent),
    hash: createHash('sha256').update(String(planContent ?? '')).digest('hex') };
}

/** Requirement IDs and their business ownership are part of the approved QA contract. */
export function extractRequirementTraceability(planContent) {
  return firstById(contractRows(planContent, ...CONTRACT.requirements), (id, m) => ({
    id, topicId: (m[2] ?? m[5]).toUpperCase(), expected: (m[3] ?? '').trim(), acceptance: (m[4] ?? '').trim(),
  }));
}

export function extractCodeQualityGates(planContent) {
  return firstById(contractRows(planContent, ...CONTRACT.qualityGates), (id, m) => ({ id, name: m[2].trim() }));
}

const normalizeCommand = command => String(command ?? '').trim().replace(/\s+/g, ' ');
// Commands a plan may mention without authorizing QA to run them.
const UNSAFE_PLAN_COMMAND = /(?:^|[\s;&|(])(?:rm|rmdir|mv|dd|mkfs|chmod|chown|sudo|su|kill|pkill|killall|shutdown|reboot|truncate|shred)(?=\s|$)|(?:^|[\s;&|])(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|remove|uninstall|ci|update|link)\b|(?:^|[\s;&|])(?:pip3?|brew|apt|apt-get|gem|cargo)\s+(?:install|uninstall|remove)\b/i;
const SINGLE_WORD_RUNNERS = /^(?:pytest|jest|vitest|mocha|tsc|eslint|make|ctest|rspec|phpunit|mypy|flake8|ruff)$/;
/** Shell commands written in the approved plan's Verification, Business Test Cases and Code
 * Quality Gates (inline `code` spans and fenced blocks). The human approved them, so QA may
 * run them verbatim; destructive commands and Git writes are never collected. */
export function extractApprovedCommands(planContent) {
  const out = new Set();
  const add = raw => {
    const cmd = normalizeCommand(String(raw).replace(/^\s*\$\s+/, ''));
    if (!cmd || cmd.length > 300) return;
    if (!/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:\.{0,2}\/)?[A-Za-z0-9_][\w.\/-]*(?:\s|$)/.test(cmd)) return;
    if (!/\s/.test(cmd) && !SINGLE_WORD_RUNNERS.test(cmd)) return;
    if (isProhibitedGitCommand(cmd) || UNSAFE_PLAN_COMMAND.test(cmd)) return;
    out.add(cmd);
  };
  for (const heading of [/^##\s+Verification\s*$/i, CONTRACT.testCases[0], CONTRACT.qualityGates[0]]) {
    for (const { line, fenced } of sectionEntries(planContent, heading) ?? []) {
      if (fenced) { if (!/^\s*#/.test(line)) add(line); continue; }
      for (const m of line.matchAll(/`([^`\n]+)`/g)) add(m[1]);
    }
  }
  return [...out].slice(0, 80);
}

const QA_STATUSES = new Set(['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN']);
const SEVERITIES = new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
const norm = (v, fallback = '') => String(v ?? fallback).trim();
const normalizeStatus = v => QA_STATUSES.has(norm(v).toUpperCase()) ? norm(v).toUpperCase() : 'BLOCKED';
const normalizeSeverity = v => SEVERITIES.has(norm(v).toUpperCase()) ? norm(v).toUpperCase() : 'MEDIUM';

function formatTestCases(tests) {
  return Array.isArray(tests) && tests.length
    ? tests.map(t => `- ${t.id} | ${t.topicId} | ${t.requirementIds.join(',')} | ${t.scenario} | ${t.expected} | ${t.method}`).join('\n')
    : '- NONE CAPTURED: QA must BLOCK if plan has no parseable test cases.';
}

/** Compact list of what a non-PASS QA report left open; a QA rework plan fixes only these. */
export function qaOpenItems(report) {
  const clip = s => { const t = norm(s).replace(/\s+/g, ' '); return t.length > 240 ? `${t.slice(0, 239)}…` : t; };
  return [
    ...(report?.topics ?? []).flatMap(t => t.tests.filter(x => x.status !== 'PASS').map(x => ({
      id: x.testId, status: x.status, scope: [t.id, ...x.requirementIds].join(','), detail: clip(x.actual), fileRefs: x.fileRefs }))),
    ...(report?.qualityChecks ?? []).filter(c => c.status !== 'PASS').map(c => ({
      id: c.gateId || 'QG', status: c.status, scope: '', detail: clip(c.name), fileRefs: [] })),
    ...(report?.codeReview?.findings ?? []).filter(f => ['CRITICAL', 'HIGH'].includes(f.severity)).map(f => ({
      id: f.id, status: f.severity, scope: '', detail: clip(f.title), fileRefs: f.fileRefs })),
    ...(report?.problems ?? []).map(p => ({ id: 'CONTRACT', status: 'BLOCKED', scope: '', detail: clip(p), fileRefs: [] })),
  ].slice(0, 30);
}

function formatOpenItems(items) {
  return Array.isArray(items) && items.length
    ? items.map(i => `- ${i.id} ${i.status}${i.scope ? ` (${i.scope})` : ''}: ${i.detail}${i.fileRefs?.length ? ` [${i.fileRefs.slice(0, 5).join(', ')}]` : ''}`).join('\n')
    : '- Not captured: take the non-PASS items from the QA report.';
}

const countStatuses = statuses => ({
  pass: statuses.filter(s => s === 'PASS').length,
  fail: statuses.filter(s => s === 'FAIL').length,
  blocked: statuses.filter(s => s === 'BLOCKED').length,
  notRun: statuses.filter(s => s === 'NOT_RUN').length,
});

/** Calculate a fail-closed result. The tool cannot prove the model's evidence is genuine.
 * The approved plan owns each TC's BIZ, REQ, scenario and expected text: Forge fills them in,
 * so the submission only reports status, actual result and evidence per TC ID.
 * `formatErrors` lists submission mistakes the agent can fix and resubmit (unplanned, duplicate
 * or missing IDs, PASS without evidence, missing actual results or review evidence). */
export function evaluateQaReport(submission, expectedTopics, expectedRequirements = [], expectedQualityGates = [], expectedTestCases = []) {
  const expected = Array.isArray(expectedTopics) ? expectedTopics : [];
  const plannedTests = Array.isArray(expectedTestCases) ? expectedTestCases : [];
  const raw = submission ?? {};
  const problems = [];
  const formatErrors = [];
  if (!expected.length) problems.push('Approved plan has no parseable Business Topics; traceability cannot be verified.');
  if (!expectedRequirements.length) problems.push('Approved plan has no parseable Requirement Traceability; requirement compliance cannot be verified.');
  if (!expectedQualityGates.length) problems.push('Approved plan has no parseable Code Quality Gates; code quality cannot be verified.');
  if (!plannedTests.length) problems.push('Approved plan has no parseable Business Test Cases; exact TC coverage cannot be verified.');

  // Submitted tests are matched by TC ID, whatever topic group they were filed under.
  const plannedIds = new Set(plannedTests.map(t => t.id));
  const submitted = new Map();
  for (const group of Array.isArray(raw.topicResults) ? raw.topicResults : []) {
    for (const t of Array.isArray(group?.tests) ? group.tests : []) {
      const id = norm(t?.testId).toUpperCase();
      if (!plannedIds.has(id)) formatErrors.push(`${id || '(empty TC)'}: not an approved test case; report only the approved TC IDs.`);
      else if (submitted.has(id)) formatErrors.push(`${id}: submitted more than once.`);
      else submitted.set(id, t);
    }
  }
  const topics = expected.map(planned => {
    const tests = plannedTests.filter(tc => tc.topicId === planned.id).map(tc => {
      const base = { testId: tc.id, requirementIds: [...tc.requirementIds], scenario: tc.scenario, expected: tc.expected };
      const t = submitted.get(tc.id);
      if (!t) {
        formatErrors.push(`${tc.id}: missing; report it as PASS, FAIL, BLOCKED or NOT_RUN.`);
        return { ...base, actual: 'Not reported', status: 'BLOCKED', evidence: '', severity: 'HIGH', fileRefs: [] };
      }
      let status = normalizeStatus(t.status);
      const evidence = norm(t.evidence);
      const actual = norm(t.actual);
      if (status === 'PASS' && !evidence) { status = 'BLOCKED'; formatErrors.push(`${tc.id}: PASS needs evidence.`); }
      if (!actual) { status = 'BLOCKED'; formatErrors.push(`${tc.id}: missing actual result.`); }
      return { ...base, actual, status, evidence, severity: normalizeSeverity(t.severity),
        fileRefs: Array.isArray(t.fileRefs) ? t.fileRefs.map(String) : [] };
    });
    if (!tests.length) {
      problems.push(`${planned.id}: the approved plan has no test case for this topic.`);
      tests.push({ testId: 'TC-MISSING', requirementIds: [], scenario: 'Business topic coverage missing', expected: 'Mapped acceptance tests', actual: 'No planned test cases', status: 'BLOCKED', evidence: '', severity: 'HIGH', fileRefs: [] });
    }
    return { id: planned.id, name: planned.name, tests };
  });
  for (const requirement of expectedRequirements) {
    if (!plannedTests.some(t => t.topicId === requirement.topicId && t.requirementIds.includes(requirement.id))) {
      problems.push(`${requirement.id}: no test case mapped under ${requirement.topicId}.`);
    }
  }

  // Quality gates are matched by QG ID; the plan owns their names.
  const plannedGates = new Map((expectedQualityGates ?? []).map(g => [g.id, g]));
  const seenGates = new Set();
  const qualityChecks = [];
  for (const c of Array.isArray(raw.codeQualityChecks) ? raw.codeQualityChecks : []) {
    const gateId = norm(c?.gateId).toUpperCase();
    if (!plannedGates.has(gateId)) { formatErrors.push(`${gateId || '(empty QG)'}: not an approved quality gate.`); continue; }
    if (seenGates.has(gateId)) { formatErrors.push(`${gateId}: submitted more than once.`); continue; }
    seenGates.add(gateId);
    const check = { gateId, name: norm(c.name) || plannedGates.get(gateId).name, status: normalizeStatus(c.status), evidence: norm(c.evidence) };
    if (check.status === 'PASS' && !check.evidence) { check.status = 'BLOCKED'; formatErrors.push(`${gateId}: PASS needs evidence.`); }
    qualityChecks.push(check);
  }
  for (const gate of plannedGates.values()) {
    if (!seenGates.has(gate.id)) {
      formatErrors.push(`${gate.id}: missing quality gate (${gate.name}).`);
      qualityChecks.push({ gateId: gate.id, name: gate.name, status: 'BLOCKED', evidence: '' });
    }
  }

  const codeReview = raw.codeReview ?? {};
  const codeReviewStatus = normalizeStatus(codeReview.status);
  const reviewEvidence = norm(codeReview.evidence);
  const findings = (Array.isArray(codeReview.findings) ? codeReview.findings : []).map((f, i) => ({
    id: norm(f?.id, `CR-${i + 1}`), title: norm(f?.title),
    severity: normalizeSeverity(f?.severity), evidence: norm(f?.evidence),
    fileRefs: Array.isArray(f?.fileRefs) ? f.fileRefs.map(String) : [],
  }));
  if (!reviewEvidence) formatErrors.push('Code review has no observed evidence.');
  if (findings.some(f => !f.title || !f.evidence)) formatErrors.push('Some code review findings lack title/evidence.');

  problems.push(...formatErrors);
  const testStatuses = topics.flatMap(t => t.tests.map(x => x.status));
  const gateStatuses = qualityChecks.map(x => x.status);
  const allStatuses = [...testStatuses, ...gateStatuses, codeReviewStatus];
  let status = 'PASS';
  if (allStatuses.includes('FAIL') || findings.some(f => ['CRITICAL', 'HIGH'].includes(f.severity))) status = 'FAIL';
  else if (problems.length || allStatuses.some(x => x !== 'PASS')) status = 'BLOCKED';

  return {
    status, topics, qualityChecks,
    codeReview: { status: codeReviewStatus, evidence: reviewEvidence, findings },
    reviewedChanges: Array.isArray(raw.reviewedChanges) ? raw.reviewedChanges.map(String) : [],
    limitations: Array.isArray(raw.limitations) ? raw.limitations.map(String) : [],
    problems,
    formatErrors,
    counts: {
      tests: countStatuses(testStatuses),
      gates: countStatuses(gateStatuses),
      codeReview: codeReviewStatus,
      businessTopics: expected.length,
      requirements: expectedRequirements.length,
      qualityGates: expectedQualityGates.length,
      plannedTestCases: plannedTests.length,
    },
  };
}

/** One line, each kind counted separately: test cases, quality gates, code review. */
export function formatQaCounts(counts) {
  const part = c => `${c.pass} PASS / ${c.fail} FAIL / ${c.blocked} BLOCKED / ${c.notRun} NOT_RUN`;
  return `Test cases (${counts.plannedTestCases}): ${part(counts.tests)} · Quality gates (${counts.qualityGates}): ${part(counts.gates)} · Code review: ${counts.codeReview}`;
}

export function renderQaReport(report, meta = {}) {
  const lines = [
    '# OMP Forge — Post-Execution QA Report', '',
    `- **Gate:** ${report.status}`,
    `- **Workflow:** ${meta.slug ?? 'unknown'}`,
    `- **Plan:** ${meta.planPath ?? 'unknown'}`,
    `- **Generated:** ${meta.generatedAt ?? new Date().toISOString()}`,
    `- **Business topics:** ${report.counts.businessTopics}`,
    `- **Requirements traced:** ${report.counts.requirements}`,
    `- **Quality gates:** ${report.counts.qualityGates}`,
    `- **Planned test cases:** ${report.counts.plannedTestCases ?? 0}`, 
    `- **Results:** ${formatQaCounts(report.counts)}`, '',
    '## Business Test Cases', '',
  ];
  for (const topic of report.topics) {
    lines.push(`### ${topic.id} — ${topic.name}`, '', '| Test Case | REQ | Scenario | Expected | Actual | Result | Evidence |', '|---|---|---|---|---|---|---|');
    for (const t of topic.tests) {
      const cell = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
      lines.push(`| ${cell(t.testId)} | ${cell(t.requirementIds.join(', '))} | ${cell(t.scenario)} | ${cell(t.expected)} | ${cell(t.actual)} | **${t.status}** | ${cell(t.evidence || 'No evidence')} |`);
      if (t.fileRefs.length) lines.push(`\nFiles: ${t.fileRefs.map(f => `\`${f}\``).join(', ')}\n`);
    }
    lines.push('');
  }
  lines.push('## Code Quality Checks', '', '| Gate | Check | Result | Evidence |', '|---|---|---|---|');
  for (const c of report.qualityChecks) lines.push(`| ${c.gateId} | ${c.name.replace(/\|/g, '\\|')} | ${c.status} | ${c.evidence.replace(/\|/g, '\\|')} |`);
  lines.push('', '## Code Review', '', `**Result:** ${report.codeReview.status}`, '', `**Evidence:** ${report.codeReview.evidence || 'None'}`, '');
  for (const f of report.codeReview.findings) lines.push(`- **${f.id} [${f.severity}] ${f.title}** — ${f.evidence}${f.fileRefs.length ? ` (${f.fileRefs.join(', ')})` : ''}`);
  if (!report.codeReview.findings.length) lines.push('No findings submitted.');
  lines.push('', '## Gate Blockers / Coverage Gaps', '');
  lines.push(...(report.problems.length ? report.problems.map(p => `- ${p}`) : ['- None identified by the report validator.']));
  lines.push('', '## Limitations', '');
  lines.push(...(report.limitations.length ? report.limitations.map(p => `- ${p}`) : ['- None reported.']));
  lines.push('', '## Reviewed Changes', '');
  lines.push(...(report.reviewedChanges.length ? report.reviewedChanges.map(p => `- ${p}`) : ['- No changed files recorded.']));
  lines.push('', '> Evidence is reported by the reviewing agent; this tool checks structure and coverage, not whether evidence is truthful.');
  return lines.join('\n') + '\n';
}

const QA_ICON = Object.freeze({ PASS: '✅', FAIL: '❌', BLOCKED: '⚠️', NOT_RUN: '⏸️' });
const SEVERITY_ICON = Object.freeze({ CRITICAL: '🔴', HIGH: '🟠', MEDIUM: '🟡', LOW: '⚪' });
const summaryCell = (value, max = 60) => {
  const text = String(value ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
  return !text ? '—' : text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
/** Compact, human-first QA result: one status table per approved TC, quality gates and
 * review findings. Shown to the user after every QA submission; the full report stays on disk. */
export function renderQaSummary(report, { reportPath = null } = {}) {
  const c = report.counts.tests;
  const g = report.counts.gates;
  const lines = [
    `### Forge QA ${QA_ICON[report.status] ?? ''} ${report.status}`, '',
    `Test cases: ✅ ${c.pass} PASS · ❌ ${c.fail} FAIL · ⚠️ ${c.blocked} BLOCKED · ⏸️ ${c.notRun} NOT RUN — Quality gates: ${g.pass}/${report.counts.qualityGates} PASS${reportPath ? ` · Full report: ${reportPath}` : ''}`, '',
    '| | Test case | Business topic | Scenario | Actual | Evidence |', '|:-:|---|---|---|---|---|',
  ];
  for (const topic of report.topics) for (const t of topic.tests) {
    lines.push(`| ${QA_ICON[t.status] ?? t.status} | ${summaryCell(t.testId, 16)} | ${summaryCell(`${topic.id} ${topic.name ?? ''}`, 32)} | ${summaryCell(t.scenario)} | ${summaryCell(t.actual)} | ${summaryCell(t.evidence)} |`);
  }
  if (report.qualityChecks.length) {
    lines.push('', '| | Quality gate | Check | Evidence |', '|:-:|---|---|---|');
    for (const q of report.qualityChecks) lines.push(`| ${QA_ICON[q.status] ?? q.status} | ${summaryCell(q.gateId, 12)} | ${summaryCell(q.name, 40)} | ${summaryCell(q.evidence)} |`);
  }
  lines.push('', `**Code review** ${QA_ICON[report.codeReview.status] ?? ''} ${report.codeReview.status}`);
  if (report.codeReview.findings.length) {
    lines.push('', '| Severity | ID | Finding | Evidence |', '|---|---|---|---|');
    for (const f of report.codeReview.findings) lines.push(`| ${SEVERITY_ICON[f.severity] ?? ''} ${f.severity} | ${summaryCell(f.id, 12)} | ${summaryCell(f.title, 48)} | ${summaryCell(f.evidence)} |`);
  } else lines.push('', 'No review findings.');
  if (report.problems.length) {
    lines.push('', '**Gate blockers**', ...report.problems.slice(0, 8).map(p => `- ${p}`));
    if (report.problems.length > 8) lines.push(`- … ${report.problems.length - 8} more in the full report`);
  }
  return lines.join('\n');
}

const DELIVERY_FILES_SHOWN = 15;
/** Human-first delivery result: commit anatomy, highlights and changed files as tables, then the
 * copy-ready commit message. The full delivery report stays on disk. */
export function renderDeliverySummary(payload, { deliveryPath = null, commitMessagePath = null } = {}) {
  const message = String(payload.commitMessage ?? '').trimEnd();
  const commit = parseCommitSubject(message.split('\n', 1)[0]);
  const highlights = Array.isArray(payload.highlights) ? payload.highlights : [];
  const files = Array.isArray(payload.changedFiles) ? payload.changedFiles : [];
  const lines = [
    '### Forge Delivery ✅ QA PASS — ready for manual commit', '',
    '| Field | Value |', '|---|---|',
    `| Type | \`${commit?.type ?? '?'}\` — ${COMMIT_TYPES[commit?.type] ?? 'unknown'}${commit?.breaking ? ' · ⚠️ BREAKING CHANGE' : ''} |`,
    `| Scope | ${commit?.scope ? `\`${commit.scope}\`` : '—'} |`,
    `| Subject | ${summaryCell(commit?.line, 100)} (${commit?.line.length ?? 0}/${COMMIT_SUBJECT_MAX}) |`,
    `| Changed files | ${files.length} |`,
    `| Post-QA audit | ${summaryCell(payload.diffAudit)} |`,
    ...(deliveryPath ? [`| Delivery report | ${summaryCell(deliveryPath, 300)} |`] : []),
    ...(commitMessagePath ? [`| Commit message file | ${summaryCell(commitMessagePath, 300)} |`] : []),
  ];
  if (highlights.length) lines.push('', '| # | Highlight |', '|:-:|---|', ...highlights.map((h, i) => `| ${i + 1} | ${summaryCell(h, 120)} |`));
  if (files.length) {
    lines.push('', '| Changed file |', '|---|', ...files.slice(0, DELIVERY_FILES_SHOWN).map(f => `| ${summaryCell(f, 120)} |`));
    if (files.length > DELIVERY_FILES_SHOWN) lines.push(`| … ${files.length - DELIVERY_FILES_SHOWN} more in the delivery report |`);
  }
  lines.push('', 'COPY THIS COMMIT MESSAGE:', '', '```text', message, '```', '',
    'Forge ran no git add, commit, push, tag or release. Review the diff and commit manually.');
  return lines.join('\n');
}

/** Bounded read-only exploration before approval. No shell chaining, redirects,
 * substitutions, mutation flags, or arbitrary scripts. Not an OS sandbox. */
export function isAllowedDiscoveryCommand(command) {
  const cmd = String(command ?? '').trim();
  if (!cmd || /[;&|`<>\n\r]/.test(cmd) || /\$\s*\(|\$\{|\\\n/.test(cmd)) return false;
  if (isProhibitedGitCommand(cmd)) return false;
  // Small allowlist; native read/grep/glob/task are preferred for everything else.
  return [
    /^pwd$/,
    /^git\s+status(?:\s+--(?:short|porcelain(?:=v1)?))?$/,
    /^git\s+diff(?:\s+--(?:check|stat|name-only))?$/,
    /^git\s+ls-files(?:\s+--cached)?$/,
    /^git\s+rev-parse\s+--(?:show-toplevel|is-inside-work-tree)$/,
    /^rg(?:\s+(?:-n|-l|--line-number|--files|--no-heading)){0,3}(?:\s+[\w./+*?\-\[\]\(\)"'\^$]+){1,8}$/,
  ].some(re => re.test(cmd));
}

/** Split a one-line shell command into `&&`/`||`/`;` steps and `|` stages, honoring quotes.
 * Returns null for syntax Forge does not vet: substitutions, file redirects, background jobs. */
function splitShellCommand(command) {
  if (/[`]|\$\s*\(|\$\{|[<>]\(/.test(command)) return null;
  // Harmless redirections: merge stderr, discard output.
  const cmd = command.replace(/\s*(?:[12]?>\s*\/dev\/null|2>&1)(?=\s|$|[;&|])/g, '');
  const segments = [];
  let current = '', quote = null, piped = false;
  const push = nextPiped => {
    const text = current.trim();
    if (!text) return false;
    segments.push({ text, piped });
    current = ''; piped = nextPiped;
    return true;
  };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) { if (ch === quote) quote = null; current += ch; continue; }
    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue; }
    if (ch === '<' || ch === '>') return null;
    if ((ch === '&' || ch === '|') && cmd[i + 1] === ch) { if (!push(false)) return null; i++; continue; }
    if (ch === ';') { if (!push(false)) return null; continue; }
    if (ch === '|') { if (!push(true)) return null; continue; }
    if (ch === '&') return null;
    current += ch;
  }
  return quote || !push(false) ? null : segments;
}

const ENV_PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s'"]*\s+)+/;
// Read-only inspection, including `git -C <dir>` reads for monorepos.
const QA_READ_ONLY = [
  /^(?:cd|pwd|ls|cat|head|tail|wc|stat|file|cmp|diff|jq|rg|grep|egrep|tree|which|echo|printf|true|basename|dirname|realpath)(?:\s|$)/,
  /^find(?:\s|$)(?!.*\s-(?:delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)\b)/,
  /^git(?:\s+-C\s+\S+)*\s+(?:status|diff|log|show|ls-files|rev-parse|blame|grep)(?:\s|$)(?!.*--output)/,
];
// Test, lint and typecheck runners with any arguments except mutating flags.
const QA_RUNNERS = [
  /^go\s+(?:test|vet)(?:\s|$)/, /^gofmt(?:\s+-[lds]+)+(?:\s|$)/,
  /^cargo\s+(?:test|clippy|check|fmt\s+--check)(?:\s|$)/,
  /^(?:python3?\s+-m\s+)?(?:pytest|unittest|mypy|ruff\s+check|ruff\s+format\s+--check|black\s+--check|flake8|pylint)(?:\s|$)/,
  /^(?:npm|pnpm|yarn|bun)\s+(?:test|t|run\s+(?:test|lint|typecheck|type-check|check)[\w:-]*)(?:\s|$)/,
  /^(?:(?:npx|bunx|pnpm\s+(?:exec|dlx)|yarn\s+(?:exec|dlx))\s+)?(?:vitest(?:\s+run)?|jest|mocha|ava|playwright\s+test|tsc|eslint|prettier\s+--check|biome\s+(?:check|lint|ci)|stylelint)(?:\s|$)/,
  /^node(?:\s+--[\w-]+(?:=\S+)?)*\s+--test(?:\s|$)/,
  /^(?:bun\s+test|deno\s+(?:test|lint|check|fmt\s+--check)|flutter\s+(?:test|analyze)|dart\s+(?:test|analyze|format\s+--output=none))(?:\s|$)/,
  /^(?:swift\s+test|dotnet\s+test|ctest|rspec|bundle\s+exec\s+rspec|(?:vendor\/bin\/)?phpunit|mvn(?:\s+-\S+)*\s+(?:test|verify)|(?:\.\/)?gradlew?\s+(?:test|check)|make\s+(?:test|check|lint))(?:\s|$)/,
];
const MUTATING_FLAGS = /\s(?:--fix|--write|-w|--update-?snapshots?|--updateSnapshot|-u|-o|--output(?!=none(?:\s|$))(?:-file)?|--outfile)(?=[\s=]|$)/;
const QA_PIPE_FILTERS = /^(?:head|tail|grep|egrep|rg|wc|sort|uniq|cut|tr|jq|cat|column|sed\s+-n)(?:\s|$)/;
function isQaStep(text) {
  const step = text.replace(ENV_PREFIX, '');
  if (QA_READ_ONLY.some(re => re.test(step))) return true;
  if (!QA_RUNNERS.some(re => re.test(step)) || MUTATING_FLAGS.test(step)) return false;
  return !/(?:^|\s)tsc(?:\s|$)/.test(step) || /\s--noEmit\b/.test(step);
}

/** QA and delivery shell policy; NOT an OS sandbox (test scripts themselves can mutate).
 * Allows the commands written in the approved plan verbatim, read-only inspection, and common
 * test/lint/typecheck runners with arguments. Steps may be chained with && || ; and piped into
 * read-only filters (head, tail, grep…). Rejects substitutions, file redirects, mutating flags,
 * multi-line scripts and Git writes. */
export function isAllowedQaCommand(command, approvedCommands = []) {
  const raw = String(command ?? '').trim();
  if (!raw || /[\r\n]/.test(raw) || isProhibitedGitCommand(raw)) return false;
  const cmd = normalizeCommand(raw);
  const approved = new Set((Array.isArray(approvedCommands) ? approvedCommands : []).map(normalizeCommand));
  if (approved.has(cmd)) return true;
  const segments = splitShellCommand(cmd);
  return segments !== null && segments.every(({ text, piped }) => approved.has(normalizeCommand(text)) ||
    (piped ? QA_PIPE_FILTERS.test(text) && !/\s-o\b/.test(text) : isQaStep(text)));
}

export function isAutoEligible(text, source, active, hasImages = false) {
  if (source !== 'interactive' || active || hasImages) return false;
  if (typeof text !== 'string' || !text.trim()) return false;
  return !text.trim().startsWith('/');
}

export function parseCommand(args) {
  const trimmed = String(args ?? '').trim();
  if (/^skills$/i.test(trimmed) || /^skill\s+show$/i.test(trimmed)) return { type:'skills' };
  if (/^skill$/i.test(trimmed)) return { type:'skillMenu' };
  if (/^skill\s+list$/i.test(trimmed)) return { type:'skillList' };
  if (/^skill\s+create(?:\s|$)/i.test(trimmed)) {
    const parts = trimmed.split(/\s+/);
    if (parts.length > 3) return {type:'skillInvalid', message:'Usage: /forge skill create [planning|execution|qa|delivery]'};
    if (parts.length === 3 && !SKILL_GATES.includes(parts[2].toLowerCase())) return {type:'skillInvalid', message:'Invalid skill Gate. Use planning, execution, qa or delivery.'};
    return {type:'skillCreate', gate:parts.length === 3 ? parts[2].toLowerCase() : null};
  }
  if (/^skill\s+(?:add|remove)(?:\s|$)/i.test(trimmed)) {
    const parts = trimmed.split(/\s+/);
    if (parts.length !== 4) return { type:'skillInvalid', message:'Usage: /forge skill add|remove <gate> <skill-name>' };
    return { type:parts[1].toLowerCase()==='add' ? 'skillAdd':'skillRemove', gate:parts[2], name:parts[3] };
  }
  if (/^skill\s+reset(?:\s|$)/i.test(trimmed)) {
    const parts = trimmed.split(/\s+/);
    if (parts.length !== 3) return { type:'skillInvalid', message:'Usage: /forge skill reset <gate|all>' };
    return { type:'skillReset', gate:parts[2] };
  }
  if (/^skill(?:\s|$)/i.test(trimmed)) return { type:'skillInvalid', message:'Use /forge skills or /forge skill [create|list|add|remove|reset].' };
  // Bare `model` opens the guided picker (gate → model → effort); `models` only lists.
  if (/^model$/i.test(trimmed)) return { type:'modelPick', gate:null };
  if (/^models$/i.test(trimmed)) return { type:'models' };
  if (/^model\s+reset$/i.test(trimmed)) return { type:'modelReset' };
  if (/^model\s+/i.test(trimmed)) {
    const parts = trimmed.split(/\s+/);
    if (parts.length === 2 || parts.length === 3) {
      const gate = parts[1].toLowerCase();
      if (!SKILL_GATES.includes(gate)) return { type:'modelInvalid', message:'Invalid model Gate. Use planning, execution, qa or delivery.' };
      if (parts.length === 2) return { type:'modelPick', gate };
      if (/^keep$/i.test(parts[2])) return { type:'modelSet', gate, selector:null };
      if (!GATE_MODEL_SELECTOR_PATTERN.test(parts[2])) return { type:'modelInvalid', message:'Invalid model selector. Use @role (e.g. @plan) or provider/model-id, or keep.' };
      return { type:'modelSet', gate, selector:parts[2] };
    }
  }
  if (/^model(?:\s|$)/i.test(trimmed)) return { type:'modelInvalid', message:'Usage: /forge model | /forge model <planning|execution|qa|delivery> [@role|provider/model-id|keep] | /forge model reset' };
  if (/^efforts?$/i.test(trimmed)) return { type:'models' };
  if (/^effort\s+reset$/i.test(trimmed)) return { type:'effortReset' };
  if (/^effort\s+/i.test(trimmed)) {
    const parts = trimmed.split(/\s+/);
    if (parts.length === 2 || parts.length === 3) {
      const gate = parts[1].toLowerCase();
      if (!SKILL_GATES.includes(gate)) return { type:'modelInvalid', message:'Invalid effort Gate. Use planning, execution, qa or delivery.' };
      if (parts.length === 2) return { type:'effortPick', gate };
      const level = parts[2].toLowerCase();
      if (level === 'keep') return { type:'effortSet', gate, level:null };
      if (!GATE_EFFORT_LEVELS.includes(level)) return { type:'modelInvalid', message:`Invalid effort level. Use ${GATE_EFFORT_LEVELS.join(', ')} or keep.` };
      return { type:'effortSet', gate, level };
    }
  }
  if (/^effort(?:\s|$)/i.test(trimmed)) return { type:'modelInvalid', message:`Usage: /forge effort | /forge effort <planning|execution|qa|delivery> [${GATE_EFFORT_LEVELS.join('|')}|keep] | /forge effort reset` };
  if (/^agents$/i.test(trimmed)) return { type:'agents' };
  // Old v5.11 commands cannot change agent routing. Direct users to native OMP /agents.
  if (/^agent(?:\s|$)/i.test(trimmed)) return { type:'agentHelp' };
  if (/^auto$/i.test(trimmed)) return { type: 'autoHelp' };
  if (/^auto\s+on$/i.test(trimmed)) return { type: 'auto', enabled: true };
  if (/^auto\s+off$/i.test(trimmed)) return { type: 'auto', enabled: false };
  if (/^auto(?:\s|$)/i.test(trimmed)) return { type: 'autoHelp' };
  // Optional plan critic before approval; bare or unknown arguments show the setting, never start a run.
  if (/^plan-?review(?:\s|$)/i.test(trimmed)) {
    const arg = trimmed.split(/\s+/)[1]?.toLowerCase();
    return { type: 'planReview', enabled: arg === 'on' ? true : arg === 'off' ? false : null };
  }
  if (/^status$/i.test(trimmed)) return { type: 'status' };
  if (/^recover$/i.test(trimmed)) return { type: 'recover' };
  if (/^review$/i.test(trimmed)) return { type: 'review' };
  if (/^resume$/i.test(trimmed)) return { type: 'resume' };
  if (/^resume\s+current$/i.test(trimmed)) return { type: 'resumeCurrent' };
  if (/^qa$/i.test(trimmed)) return { type: 'qa' };
  if (/^report$/i.test(trimmed)) return { type: 'report' };
  if (/^commit(?:-msg)?$|^delivery$/i.test(trimmed)) return { type: 'delivery' };
  if (/^rework$/i.test(trimmed)) return { type: 'rework' };
  if (/^off$|^cancel$/i.test(trimmed)) return { type: 'cancel' };
  return { type: 'start', requirement: trimmed };
}


/**
 * Native /forge slash-command argument completions. Each value is the FULL
 * argument replacement (not the last token), as required by OMP's TUI.
 *
 * All suggestions describe commands already accepted by parseCommand;
 * free-form requirements are left alone. The completion function never
 * modifies configuration, opens UI, or starts a workflow.
 */
export function getForgeArgumentCompletions(argumentPrefix, options = {}) {
  const input = String(argumentPrefix ?? '');
  if (input.length > 256 || /[\r\n\0]/.test(input)) return null;
  const words = input.trim().length ? input.trim().split(/\s+/) : [];
  const afterSpace = /\s$/.test(input);
  const fixed = afterSpace ? words : words.slice(0, -1);
  const query = (afterSpace ? '' : words.at(-1) ?? '').toLowerCase();
  const gateNames = SKILL_GATES;
  const skills = [...new Set((Array.isArray(options.skills) ? options.skills : [])
    .filter(name => typeof name === 'string' && SKILL_NAME_PATTERN.test(name)))].sort();
  const bindings = options.gateSkills && typeof options.gateSkills === 'object' ? options.gateSkills : {};
  let candidates = [];
  // label and value are intentionally separate: concise help is visible in
  // the menu, while selecting an item inserts just valid command arguments.
  const choices = (entries, continueWithSpace = false) => entries.map(entry => {
    const token = typeof entry === 'string' ? entry : entry.token;
    const detail = typeof entry === 'string' ? '' : entry.detail;
    return {token, detail, more: continueWithSpace};
  });
  if (fixed.length === 0) {
    candidates = [
      {token:'agents', detail:'Show fixed Gate → OMP agents (manage models with /agents)'},
      {token:'skill', detail:'Manage skills per gate', more:true},
      {token:'skills', detail:'Show gate skill assignments'},
      {token:'model', detail:'Pick model and effort per gate', more:true},
      {token:'models', detail:'Show gate models and efforts'},
      {token:'effort', detail:'Main-session thinking level per gate', more:true},
      {token:'status', detail:'Show workflow status'},
      {token:'recover', detail:'Review inconsistent state (human confirmation)'},
      {token:'resume', detail:'Choose Forge session to resume'},
      {token:'review', detail:'Open the Forge plan approval dialog'},
      {token:'auto', detail:'Configure auto-start', more:true},
      {token:'planreview', detail:'Optional plan critic before approval', more:true},
      {token:'qa', detail:'Run post-execution QA'},
      {token:'report', detail:'Show QA report'},
      {token:'delivery', detail:'Show delivery and commit message'},
      {token:'rework', detail:'Resume QA rework'},
      {token:'off', detail:'Cancel workflow'},
    ];
  } else if (fixed[0].toLowerCase() === 'resume' && fixed.length === 1) {
    candidates = choices([{token:'current',detail:'Continue the current Forge workflow without choosing another session'}]);
  } else if (fixed[0].toLowerCase() === 'auto' && fixed.length === 1) {
    candidates = choices([{token:'on',detail:'Enable global auto-start'},{token:'off',detail:'Disable global auto-start'}]);
  } else if (fixed[0].toLowerCase() === 'planreview' && fixed.length === 1) {
    candidates = choices([{token:'on',detail:'Run forge-plan-critic before every plan proposal'},{token:'off',detail:'Propose plans without the plan critic'}]);
  } else if (fixed[0].toLowerCase() === 'model') {
    if (fixed.length === 1) candidates = [
      ...gateNames.map(g => ({token:g, detail:`Pick a model for ${g}`, more:true})),
      {token:'reset', detail:'Restore default gate models'},
    ];
    else if (fixed.length === 2 && gateNames.includes(fixed[1].toLowerCase())) {
      candidates = choices(['@plan','@default','@slow','@smol','keep']);
    }
  } else if (fixed[0].toLowerCase() === 'effort') {
    if (fixed.length === 1) candidates = [
      ...gateNames.map(g => ({token:g, detail:`Pick a thinking level for ${g}`, more:true})),
      {token:'reset', detail:'Keep the session thinking level at every gate'},
    ];
    else if (fixed.length === 2 && gateNames.includes(fixed[1].toLowerCase())) {
      candidates = choices([...GATE_EFFORT_LEVELS, 'keep']);
    }
  } else if (fixed[0].toLowerCase() === 'skill') {
    if (fixed.length === 1) candidates = [
      {token:'create',detail:'Paste a SKILL.md in multiline editor',more:true},
      {token:'list',detail:'List installed skills'},
      {token:'add',detail:'Attach skill to gate',more:true},
      {token:'remove',detail:'Detach skill from gate',more:true},
      {token:'reset',detail:'Reset gate skill bindings',more:true},
      {token:'show',detail:'Show current gate skills'},
    ];
    else {
      const action = fixed[1].toLowerCase();
      if (fixed.length === 2 && ['create','add','remove','reset'].includes(action)) {
        candidates = choices(action === 'reset' ? [...gateNames, 'all'] : gateNames, action !== 'reset');
      } else if (fixed.length === 3 && ['add','remove'].includes(action)) {
        const gate = fixed[2].toLowerCase();
        if (gateNames.includes(gate)) {
          const items = action === 'remove' ? (Array.isArray(bindings[gate]) ? bindings[gate] : []) : skills;
          candidates = choices([...new Set(items)].sort());
        }
      }
    }

  }
  const out = [];
  for (const item of candidates) {
    if (!item.token.toLowerCase().startsWith(query)) continue;
    const value = [...fixed, item.token].join(' ') + (item.more ? ' ' : '');
    const label = item.detail ? `${item.token}  ·  ${item.detail}` : item.token;
    out.push({value, label});
  }
  return out.length ? out : null;
}

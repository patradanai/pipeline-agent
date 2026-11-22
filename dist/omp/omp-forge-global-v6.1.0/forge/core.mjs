/** Pure workflow and QA report logic; independent of the OMP runtime. */
import { createHash } from 'node:crypto';
import { normalizeForgeState } from './forge-state.mjs';

export const GATE_AGENTS = Object.freeze({
  REQUIREMENT: ['forge-requirement'],
  PLAN: ['forge-planner'],
  EXECUTE: ['forge-executor'],
  QA: ['forge-qa', 'forge-code-reviewer', 'forge-delivery'],
});

/** Gate/role assignments are global operator settings, copied into each run. */
export const DEFAULT_AGENT_ASSIGNMENTS = Object.freeze({
  requirement: Object.freeze({ analyst: 'forge-requirement' }),
  planning: Object.freeze({ planner: 'forge-planner' }),
  execution: Object.freeze({ executor: 'forge-executor' }),
  qa: Object.freeze({ business: 'forge-qa', reviewer: 'forge-code-reviewer' }),
  delivery: Object.freeze({ writer: 'forge-delivery' }),
});
/** Portable config used by OMP today and a future Claude Code adapter. */
export const SKILL_GATES = Object.freeze(['requirement','planning','execution','qa','delivery']);
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
  return ({req:'requirement',requirements:'requirement',cook:'requirement',plan:'planning',exec:'execution',execute:'execution',review:'qa',deliver:'delivery'})[name]
    ?? (SKILL_GATES.includes(name) ? name : null);
}
export function cloneGateSkills(source) {
  const defaults = { requirement: ['forge-requirement-gate'], planning: ['forge-plan-gate'], execution: ['forge-execute-gate'], qa: ['forge-qa-gate'], delivery: [] };
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
  for (const gate of Object.keys(source ?? {})) if (!SKILL_GATES.includes(gate)) throw new Error(`Unknown skill gate ${gate}.`);
  return result;
}
export function addGateSkill(source, gateInput, name) {
  const gate = normalizeSkillGate(gateInput);
  if (!gate) throw new Error('Unknown skill gate. Use requirement, planning, execution, qa or delivery.');
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
export function currentSkillGate(phase) {
  return ({ REQUIREMENT:'requirement', PLAN:'planning', EXECUTE:'execution', QA:'qa' })[String(phase)] ?? null;
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
 * Minimal, always-on terminal progress: five work stages, no approval node.
 * Native OMP Plan Review owns approval, so its overlay has no duplicate widget.
 * This is presentation-only; it never modifies the workflow state or gating.
 */
export function renderForgeWidget(state) {
  if (!state?.active) return null;
  const phase = String(state.phase ?? '');
  if (phase === 'PLAN' && state.planWritten && state.planValid && !state.approved) return null;
  const stages = {
    REQUIREMENT: [0, 'Requirement'],
    PLAN: [1, 'Planning'],
    EXECUTE: [2, 'Execution'],
    QA: [3, state.qaStatus === 'PASS' ? 'Delivery' : state.qaEvidencePending ? 'QA evidence needed' : 'QA review'],
  };
  const stage = stages[phase];
  if (!stage) return null;
  const [index, label] = stage;
  const meter = '▰'.repeat(index + 1) + '▱'.repeat(3 - index);
  const rework = phase === 'PLAN' && Number(state.reworkCycles) > 0
    ? `  ·  Rework ${Math.max(1, Math.trunc(Number(state.reworkCycles)))}` : '';
  return [`FORGE  ${meter}  ${label}  ${index + 1}/4${rework}`];
}

/** Requirement gate: ONE `forge-requirement` pass covers intake, gaps, critique,
 * architecture, QA strategy and a self-challenge of its own draft. The
 * orchestrator then reviews that report as a second reader and records the
 * synthesis with forge_requirement_summary, which opens PLANNING. */
const MAX_SUMMARY_TEXT = 6000;
const clip = (v, n) => String(v ?? '').replace(/\u0000/g, '').trim().slice(0, n);
/** Validate and normalize the orchestrator's requirement synthesis. */
export function normalizeRequirementSummary(input) {
  const baseline = clip(input?.baseline, MAX_SUMMARY_TEXT);
  if (baseline.length < 20) throw new Error('Requirement summary needs a baseline (at least a few lines: goal, scope, acceptance).');
  const list = (v, max, n = 400) => (Array.isArray(v) ? v : []).map(x => clip(x, n)).filter(Boolean).slice(0, max);
  const findings = (Array.isArray(input?.findings) ? input.findings : []).slice(0, 40).map((f, i) => {
    const severity = String(f?.severity ?? '').toUpperCase();
    if (!['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(severity)) throw new Error(`Finding ${i + 1} needs severity CRITICAL|HIGH|MEDIUM|LOW.`);
    const title = clip(f?.title, 300);
    if (!title) throw new Error(`Finding ${i + 1} needs a title.`);
    return { id: clip(f?.id, 32) || `F-${String(i + 1).padStart(3, '0')}`, severity, title, source: clip(f?.source, 64) || null };
  });
  return {
    baseline, findings,
    blockers: list(input?.blockers, 20),
    assumptions: list(input?.assumptions, 30),
    relevantFiles: list(input?.relevantFiles, 40, 300),
  };
}

/** Severity labels the requirement agent itself wrote in its report.
 * Used to stop a summary from silently dropping its CRITICAL/HIGH items. */
export function countReportedSeverities(text) {
  const t = String(text ?? '');
  return {
    critical: (t.match(/\bCRITICAL\b/g) ?? []).length,
    high: (t.match(/\bHIGH\b/g) ?? []).length,
  };
}
export function formatRequirementSummary(summary, { maxChars = 5000 } = {}) {
  if (!summary) return '';
  const lines = ['Requirement baseline:', summary.baseline];
  if (summary.findings?.length) lines.push('Findings:', ...summary.findings.map(f => `- ${f.id} [${f.severity}] ${f.title}${f.source ? ` (${f.source})` : ''}`));
  if (summary.blockers?.length) lines.push('Open blockers:', ...summary.blockers.map(b => `- ${b}`));
  if (summary.assumptions?.length) lines.push('Assumptions:', ...summary.assumptions.map(a => `- ${a}`));
  if (summary.relevantFiles?.length) lines.push('Relevant files:', ...summary.relevantFiles.map(f => `- ${f}`));
  const text = lines.join('\n');
  return text.length > maxChars ? text.slice(0, maxChars) + '\n…(truncated)' : text;
}
export function requiredAgentsFor(state) {
  if (!state) return [];
  const agents = effectiveAgentAssignments(state);
  const rolesByPhase = {
    REQUIREMENT: ['requirement','analyst'],
    PLAN: ['planning','planner'],
    EXECUTE: ['execution','executor'],
    QA: state.qaStatus === 'PASS' ? ['delivery','writer'] : ['qa','business','reviewer'],
  };
  const route = rolesByPhase[state.phase];
  return route ? route.slice(1).map(role => agents[route[0]][role]) : [];
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
export const PHASES = Object.freeze(['REQUIREMENT', 'PLAN', 'EXECUTE', 'QA']);

export const NEXT_PHASE = Object.freeze({
  REQUIREMENT: 'PLAN',
  PLAN: 'EXECUTE',
  EXECUTE: 'QA',
});

export function planSlug() {
  return `forge-${Date.now().toString(36)}`;
}

export function initialState(requirement, slug = planSlug(), assignments = null, skills = null, skillPins = {}) {
  if (!requirement || !requirement.trim()) throw new Error('Requirement must not be empty');
  return {
    requirementSummary: null,
    version: 8,
    gateAgents: {},
    agentAssignments: validateAgentAssignments(assignments),
    gateSkills: cloneGateSkills(skills),
    skillPins: { ...skillPins },
    agentRetries: {},
    active: true,
    phase: 'REQUIREMENT',
    requirement: requirement.trim(),
    slug,
    proposalRetries: 0,
    approved: false,
    executionObserved: false,
    businessTopics: [],
    testCases: [],
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
You are an orchestration lead, NOT an implementation agent before human approval. Forge enforces a read-only safety boundary before native Plan Approval, even if Plan Mode is paused or inactive. Do not edit the project, run mutating commands, commit, install dependencies, or create implementation code before explicit approval. Work with any domain, project, or no repository at all.
Never run git add, git commit, git push, git tag, git merge, git rebase, or publish changes on behalf of the user, at any stage. The user performs Git writes manually after delivery. Existing user constraints override your suggestions. Never invent evidence, tests, subagent calls, approvals, or locked decisions. Clearly distinguish observed facts, assumptions, recommendations, and unresolved decisions.
Use short progress headings and structured outputs. Prefer automatic continuation; interrupt the user only for an irreversible, material, or genuinely ambiguous business decision. If necessary, use the native ask tool. Avoid unnecessary questions.
Submit the plan for approval after writing a real local:// plan file. If Forge still displays PLAN after a successful native write, xd://propose is allowed; the native OMP plan handler verifies the file and requires human approval.`;

function phaseInstructionTemplate(state) {
  const { phase, requirement, slug } = state;
  if (phase === 'REQUIREMENT') return `${HEADER}

[GATE 1/4: REQUIREMENT — single-pass analysis]
Original user requirement:
${requirement}

MANDATORY: invoke the installed global agent \`forge-requirement\` ONCE through the native task tool and await its report. It is this gate's only specialist and covers every lens in one pass. If it cannot run, report the gate BLOCKED; never simulate it.
Its task text must contain: the original requirement verbatim; decisions and constraints already confirmed in this conversation; paths you already know are relevant (a starting point, not a fence); and the demand that its report covers all six lenses, every finding labelled CRITICAL|HIGH|MEDIUM|LOW and fact|assumption with evidence:
(1) intake: goals, stakeholders, scope and non-goals, numbered BIZ/REQ candidates with acceptance criteria;
(2) gaps: ambiguities, conflicts and unanswered decisions;
(3) critique: counterexamples, hidden assumptions, failure modes;
(4) architecture: boundaries, alternatives and trade-offs;
(5) QA strategy: acceptance, negative and edge cases for every critical REQ;
(6) self-challenge of its own draft: what it revised, BLOCKERs vs safe defaults.
Do not run your own intake or workspace exploration first: the agent reads what it needs once. When its report arrives, Forge asks you to review it and call \`forge_requirement_summary\`. Do not implement or write the plan yet.`;

  if (phase === 'PLAN' && state.planWritten && state.planValid) return `${HEADER}\nThe plan is awaiting explicit operator approval. Do not implement.`;
  if (phase === 'PLAN' && state.planWritten) return `${HEADER}

[GATE 2/4: NATIVE OMP PLAN APPROVAL]
Review ${state.planPath ?? `local://${slug}-plan.md`} for completeness and unresolved blockers. If ready, submit it to OMP's built-in Plan Review overlay: use the native write tool to write the exact slug '${(state.planPath ?? `local://${slug}-plan.md`).replace(/^local:\/\//, '').replace(/-plan\.md$/, '')}' as plain text to xd://propose. This opens the user's approval UI. Never self-approve. If the plan file was not written, create it first. Do not finish with just a textual 'ready' response.`;
  if (phase === 'PLAN' && state.reworkBaseHash) return reworkInstructionTemplate(state);

  if (phase === 'PLAN') return `${HEADER}

[GATE 2/4: PLANNING]${state.requirementSummary ? `
Use this requirement synthesis as the starting point (do not re-run requirement discovery):
${formatRequirementSummary(state.requirementSummary)}
` : ''}
MANDATORY: invoke the named \`forge-planner\` global agent via native task, await its plan analysis, then the orchestrator composes the canonical local:// plan file. Never treat a self-authored fake report as agent output.
Create a detailed, domain-appropriate plan: problem statement, requirement IDs, decisions, alternatives and rationale, architecture at conceptual level, risks and mitigations, implementation phases, dependency DAG, verification matrix, rollback/recovery, and unresolved blockers. Do not write code or change the working tree. If there are unresolved critical blockers, ask for the decision before preparing an executable plan.

MANDATORY QA CONTRACT IN THE PLAN:
- Include a section titled exactly '## Business Topics'. List every business capability using this exact parseable syntax, one per line: '- BIZ-001: <descriptive business topic>'. Continue BIZ-002, etc. Use business capabilities, not technical layers. Every critical requirement must map to a business topic.
- Include '## Requirement Traceability' with each requirement in this exact parseable format: '- REQ-001 | BIZ-001 | <expected behavior> | <acceptance criteria>'. Continue REQ-002, etc. Never leave an important requirement unmapped.
- Include '## Business Test Cases' with one parseable line per test: '- TC-001 | BIZ-001 | REQ-001,REQ-002 | <scenario> | <expected> | <verification method>'. Include negative and edge cases and at least one test for every REQ-ID. Use stable unique IDs.
- Include '## Code Quality Gates' with parseable lines '- QG-001: <quality gate>' for language-appropriate tests, lint/static analysis, typecheck/build where applicable, security/error handling, and maintainability review. Mark not-applicable checks explicitly.
- Include '## Execution & QA Handoff': after implementation, QA must compare the *approved* plan against actual code, run feasible checks, and report every test by Business Topic. Never mark a check PASS without observed evidence; unrun checks are NOT_RUN.

Write the complete proposed plan into OMP's plan-mode sandbox at local://${slug}-plan.md (not a workspace file). If OMP has already assigned a different root-level local://*-plan.md filename for this session, that OMP-local plan filename is also accepted; never use a repository path. The plan must include a visible 'Requirement & Gap Analysis' section. After a successful write, submit the bare plan slug using write xd://propose; native OMP will verify that the file exists and open human review. Do not implement or self-approve.`;


  return `${HEADER}\nThe plan is awaiting explicit operator approval. Do not implement.`;
}

function requirementSummaryTemplate() {
  return `[FORGE REQUIREMENT — report received]
Review the \`forge-requirement\` report as an independent second reader before you summarize: all six lenses present (intake, gaps, critique, architecture, QA strategy, self-challenge)? every CRITICAL/HIGH finding backed by evidence or a labelled assumption? a counterexample or acceptance gap it missed? Record what you add as findings with source "orchestrator"; read files only to settle a specific doubt.
Then call \`forge_requirement_summary\` exactly once: baseline, ALL findings with their original severity (merge duplicates only; never drop or downgrade one), open blockers, assumptions and relevant files. Forge checks the summary against the report's own CRITICAL/HIGH labels, then opens Planning. Ask the user only for business decisions that cannot be safely inferred. Do not write the plan yet.`;
}

function executionInstructionTemplate(state) {
  return `[OMP FORGE — APPROVED EXECUTION & QA HANDOFF]
The operator approved the plan. MANDATORY: invoke the named \`forge-executor\` through native task; await its implementation report. No other executor agent is allowed. The executor has read/edit/write but no shell; the main orchestrator must run safe relevant build/tests. If the named agent is unavailable, stop and report EXECUTION_BLOCKED, not implementation complete.
Implement the *approved* plan normally, respecting scope and all constraints. Do not skip required tasks. The Forge extension will start a separate read-only QA review automatically after the execution turn settles. NEVER run git add/commit/push, create PRs, tag or publish. Git commits must remain a manual user action.

At the end of implementation, summarize changed files, tests actually run, their exact results, unfinished work and any deviations from the approved plan. Do not claim tests passed if they were not run. Do not label the work verified; Forge QA decides that independently.
Plan reference: ${state.planPath ?? `local://${state.slug}-plan.md`}
Business topics captured: ${formatTopics(state.businessTopics)}.`;
}

function qaInstructionTemplate(state) {
  return `[OMP FORGE — POST-EXECUTION QA REVIEW — READ-ONLY]
The approved implementation turn has settled. Enforce EXACT test IDs and mappings from the approved plan; do not invent replacement TC IDs. FIRST call \`forge_qa_scope\` as the MAIN orchestrator to inspect the read-only workspace diff inventory; pass its actual output and the approved plan to BOTH named read-only task agents \`forge-qa\` and \`forge-code-reviewer\`, then await their independent reports. Do not simulate agent responses. Neither specialist has shell permissions; the main orchestrator runs safe tests and submits unified evidence via \`forge_qa_submit\`. Missing agents/evidence must never PASS. Do NOT edit code, install dependencies, run migrations, commit, or auto-fix.

Original requirement: ${state.requirement}
Approved plan reference: ${state.planPath ?? `local://${state.slug}-plan.md`}
Business topics from the plan review:
${formatTopics(state.businessTopics)}
Approved test cases (every one is mandatory):
${formatTestCases(state.testCases)}
Mapped requirements from the plan review:
${formatRequirements(state.requirements)}
Code quality gates from the plan review:
${formatQualityGates(state.qualityGates)}

REQUIRED CHECKS:
1. Re-read the *approved* plan and actual changed code. Check each BIZ topic, REQ-ID and acceptance criterion. Use the captured BIZ IDs, not newly invented topics.
2. Review code quality and code: correctness, security, input validation, error handling, concurrency/data consistency, maintainability, duplication, architecture boundaries, tests and regression risk. Cite exact file:line references where possible.
3. FIRST call forge_qa_scope (main orchestrator only), which obtains a read-only Git status/diff file inventory for the current workspace. Share its actual results with both read-only specialists, without falsely claiming a test ran. It does not execute implementation. The main orchestrator may also run exact safe commands: git status --short, git diff --stat, git diff --name-only, existing test/lint/typecheck commands. Forge QA permits these. NEVER claim the independent specialists ran shell commands: their tools are intentionally read-only.
   If the workspace has NO current diff, do not automatically mark every change-dependent TC NOT_RUN. Verify the approved end state against the existing source/documents and run feasible tests; an already-completed task may legitimately have no new working tree edits. Empty diff alone is NOT proof of compliance. If a test truly cannot be verified, record NOT_RUN, with the missing evidence and the exact safe check needed.
4. For every approved TC-ID, submit the exact same BIZ-ID and REQ-ID mapping, original scenario/expected, actual observed result, PASS/FAIL/BLOCKED/NOT_RUN, evidence and severity. All missing, changed, duplicate or additional test IDs are BLOCKED; do not silently substitute tests. Unrun tests must be NOT_RUN.
5. Separately record code quality checks and code review findings with evidence. A clean review with no findings is allowed, but include explicit code review evidence.
6. Submit the structured report using the 'forge_qa_submit' tool exactly once. The tool computes the final gate result and saves a Markdown/JSON report outside the project. Do not declare PASS on your own.
7. If the tool is unavailable, explicitly report that QA could not be completed; do not claim success.

DO NOT auto-fix. On observed FAIL, Forge re-enters PLAN and requires new approval before code repairs. On BLOCKED/NOT_RUN without observed failures, Forge remains in QA and retains the approved plan; collect missing evidence using /forge qa, or choose /forge rework if implementation changes are required. On PASS, prepare delivery within QA. Never stage, commit or push.`;
}

function reworkPlanPath(state) {
  const cycle = Math.max(1, Number(state.reworkCycles) || 1);
  const basePlanPath = state.reworkBasePlanPath ?? `local://${state.slug}-plan.md`;
  return state.planPath && state.planPath !== basePlanPath
    ? state.planPath
    : `local://${state.slug}-rework-${cycle}-plan.md`;
}

function reworkInstructionTemplate(state) {
  const nextPlanPath = reworkPlanPath(state);
  return `[OMP FORGE — QA FAILED: REWORK PLAN, NEW APPROVAL REQUIRED]
QA gate: ${state.qaStatus ?? 'BLOCKED'}; rework cycle #${state.reworkCycles ?? 1}.
Original requirement: ${state.requirement}
Previous approved plan: ${state.reworkBasePlanPath ?? `local://${state.slug}-plan.md`}
QA failure evidence (read this report): ${state.qaReportPath ?? 'not available'}

MANDATORY: invoke the named \`forge-planner\` agent via native task and await its report before saving the rework plan.
Forge PLAN owns rework drafting. Keep the revision in Forge's planning gate; do not manually enter or exit OMP Native Plan Mode, and do not ask the user to change modes. Absolutely no implementation, code edits, test fixes, git add/commit/push or mutating commands. Read the QA report and compare failures with the previous approved plan and original requirements. Group repairs by Business Topic and Test Case (BIZ/REQ/TC/QG), identify root causes and risks, and preserve stable IDs. Save a revised plan to ${nextPlanPath}; never overwrite the previous approved plan. The revised plan must include remediation tasks and a new test matrix. Do NOT erase unfinished or blocked tests. Explicitly explain what changes, why, and what will be reverified.

Maintain the mandatory sections ## Business Topics, ## Requirement Traceability, ## Business Test Cases, ## Code Quality Gates, ## Execution & QA Handoff, and ## QA Rework Changes. If the user selects Refine, keep editing the same rework revision at ${nextPlanPath}. After the planner report and a successful rework-plan write, Forge will enter OMP Native Plan Mode and open the human Plan Review UI when this turn settles. Do not call xd://propose or ask the user to submit/advance a gate. Do NOT auto-approve or implement.`;
}

function deliveryInstructionTemplate(state) {
  return `[OMP FORGE — DELIVERY PREPARATION — QA PASSED]
All planned business QA and code quality gates passed according to the structured QA report. MANDATORY: ask the named read-only agent \`forge-delivery\` via native task to independently assemble delivery summary, migration/env/rollback/PR notes and Conventional Commit suggestion. Await the agent and only then submit forge_delivery_submit. No git operations. This is DELIVERY ONLY, not implementation.
Requirement: ${state.requirement}
Approved plan: ${state.planPath ?? `local://${state.slug}-plan.md`}
QA report: ${state.qaReportPath ?? 'missing'}
Business topics: ${formatTopics(state.businessTopics)}

READ-ONLY ACTIONS ONLY: inspect current git status and diff summaries if available; do not stage, commit, push, tag, merge, rebase, publish, or change project files. Prepare a Conventional Commits style, actionable commit message based ONLY on actual changes and verified QA evidence. If there are no changes, or git metadata is unavailable, explain that clearly; do not invent changed files. Do not claim deploy/release completed.

Submit once using forge_delivery_submit with:
- subject: e.g. feat(scope): add user booking approvals, max 72 chars
- body: concise newline-separated bullet points about real changes, avoid unproven claims
- highlights: user-facing delivery summary
- changedFiles: actual filenames from inspection where available
Then PRINT the exact commit message in a fenced text block for the human to COPY and PASTE. Do not execute git commands that modify the repository. The final message should show QA result, report path, and manual-only git guidance.`;
}

// Prompt routing uses the same immutable per-workflow roster as task gates and QA validation.
export const phaseInstruction = state => {
  if (state.phase === 'EXECUTE') return executionInstruction(state);
  if (state.phase === 'QA') return state.qaStatus === 'PASS' ? deliveryInstruction(state) : qaInstruction(state);
  return `Load and follow the ${state.phase === 'REQUIREMENT' ? 'forge-requirement-gate' : 'forge-plan-gate'} skill.\n\n${routeAgentNames(phaseInstructionTemplate(state), state)}`;
};
export const requirementSummaryInstruction = state => routeAgentNames(requirementSummaryTemplate(), state);
export const executionInstruction = state => `Load and follow the forge-execute-gate skill.\n\n${routeAgentNames(executionInstructionTemplate(state), state)}`;
export const qaInstruction = state => `Load and follow the forge-qa-gate skill.\n\n${routeAgentNames(qaInstructionTemplate(state), state)}`;
export const reworkInstruction = state => `Load and follow the forge-plan-gate skill.\n\n${routeAgentNames(reworkInstructionTemplate(state), state)}`;
export const deliveryInstruction = state => routeAgentNames(deliveryInstructionTemplate(state), state);

/** This guard covers obvious agent-authored Git writes, not subprocesses or arbitrary user scripts. */
export function isProhibitedGitCommand(command) {
  const text = String(command ?? '').replace(/\\\s*\n/g, ' ');
  // Detect git, absolute git paths and common shell wrappers. Conservative by design.
  const git = /(?:^|[^\w-])(?:git|\/(?:usr\/)?(?:local\/)?bin\/git)(?:\s+(?:-C\s+\S+|--git-dir(?:=|\s+)\S+|--work-tree(?:=|\s+)\S+|-c\s+\S+))*\s+(?:add|commit|push|tag|merge|rebase|reset|checkout|switch|cherry-pick|am|apply|stash|pull|fetch\s+--update-head-ok)\b/i;
  const cli = /(?:^|[^\w-])(?:gh|hub|glab)\s+(?:pr\s+(?:create|merge)|mr\s+(?:create|merge)|release\s+create|repo\s+(?:sync|fork))\b/i;
  const plumbing = /(?:^|[^\w-])git\s+(?:update-ref|write-tree|commit-tree|update-index|push|send-pack)\b/i;
  const releaseScripts = /(?:^|[^\w-])(?:npm|pnpm|yarn|bun)\s+(?:(?:run|run-script)\s+)?(?:release|publish|deploy|commit|push|version|tag)(?:\s|$)/i;
  const releaseTools = /(?:^|[^\w-])(?:semantic-release|standard-version|changeset\s+publish|lerna\s+publish|npm\s+publish|make\s+(?:release|publish)|npx\s+semantic-release)\b/i;
  // Catch basic subprocess array calls such as subprocess.run(['git','commit',...]).
  const arrayCall = /[\[,(]\s*['"]git['"]\s*,\s*['"](?:add|commit|push|tag|merge|rebase|reset|checkout|switch|cherry-pick|commit-tree|update-ref)['"]/i;
  return git.test(text) || cli.test(text) || plumbing.test(text) || releaseScripts.test(text) || releaseTools.test(text) || arrayCall.test(text);
}

/** A suggestion only: it is never used as a shell command by Forge. */
export function buildCommitMessage(subject, body = '') {
  const line = String(subject ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (!/^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9][a-z0-9._/-]*\))?!?: [^\r\n]{4,}$/i.test(line)) {
    throw new Error('Commit subject must follow Conventional Commits, e.g. feat(booking): add room approvals.');
  }
  if (line.length > 72) throw new Error('Commit subject must be at most 72 characters.');
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

/** Extract topics only from the explicit contract section; avoid incidental BIZ references. */
export function extractBusinessTopics(planContent) {
  const lines = String(planContent ?? '').split(/\r?\n/);
  let inSection = false;
  const result = [];
  const seen = new Set();
  for (const line of lines) {
    if (/^##\s+Business Topics\s*$/i.test(line.trim())) { inSection = true; continue; }
    if (inSection && /^#{1,2}\s+/.test(line.trim())) break;
    if (!inSection) continue;
    const match = line.match(/^\s*(?:[-*]\s+|#{3,6}\s+)(BIZ-\d{3,})\s*[:\-–—]\s*(.+?)\s*$/i);
    if (!match) continue;
    const id = match[1].toUpperCase();
    if (seen.has(id)) continue;
    seen.add(id);
    result.push({ id, name: match[2].trim() });
  }
  return result;
}

/** Exact approved test cases are the post-execution QA contract (no replacing TC IDs). */
export function extractBusinessTestCases(planContent) {
  const lines = String(planContent ?? '').split(/\r?\n/);
  let active = false;
  const tests = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^##\s+Business Test Cases\s*$/i.test(trimmed)) { active = true; continue; }
    if (active && /^#{1,2}\s+/.test(trimmed)) break;
    if (!active) continue;
    const match = line.match(/^\s*[-*]\s*(TC-\d{3,})\s*\|\s*(BIZ-\d{3,})\s*\|\s*([A-Za-z0-9,\s-]+)\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*(.+?)\s*$/i);
    if (!match) continue;
    const reqIds = match[3].split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
    tests.push({ id: match[1].toUpperCase(), topicId: match[2].toUpperCase(), requirementIds: reqIds, scenario: match[4].trim(), expected: match[5].trim(), method: match[6].trim() });
  }
  return tests;
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
  return { valid: issues.length===0, issues, topics, requirements, qualityGates, testCases,
    hash: createHash('sha256').update(String(planContent ?? '')).digest('hex') };
}

/** Requirement IDs and their business ownership are part of the approved QA contract. */
export function extractRequirementTraceability(planContent) {
  const lines = String(planContent ?? '').split(/\r?\n/);
  let inSection = false;
  const requirements = [];
  const seen = new Set();
  for (const line of lines) {
    if (/^##\s+Requirement Traceability\s*$/i.test(line.trim())) { inSection = true; continue; }
    if (inSection && /^#{1,2}\s+/.test(line.trim())) break;
    if (!inSection) continue;
    const match = line.match(/^\s*[-*]\s*(REQ-\d{3,})\s*(?:\|\s*(BIZ-\d{3,})\s*\|\s*(.+?)\s*\|\s*(.+?)|->\s*(BIZ-\d{3,}))\s*$/i);
    if (!match) continue;
    const id = match[1].toUpperCase();
    if (seen.has(id)) continue;
    seen.add(id);
    requirements.push({ id, topicId: (match[2] ?? match[5]).toUpperCase(), expected: (match[3] ?? '').trim(), acceptance: (match[4] ?? '').trim() });
  }
  return requirements;
}

export function extractCodeQualityGates(planContent) {
  const lines = String(planContent ?? '').split(/\r?\n/);
  let inSection = false;
  const gates = [];
  const seen = new Set();
  for (const line of lines) {
    if (/^##\s+Code Quality Gates\s*$/i.test(line.trim())) { inSection = true; continue; }
    if (inSection && /^#{1,2}\s+/.test(line.trim())) break;
    if (!inSection) continue;
    const match = line.match(/^\s*[-*]\s*(QG-\d{3,})\s*[:\-–—]\s*(.+?)\s*$/i);
    if (!match) continue;
    const id = match[1].toUpperCase();
    if (seen.has(id)) continue;
    seen.add(id);
    gates.push({ id, name: match[2].trim() });
  }
  return gates;
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

/** Calculate a fail-closed result. The tool cannot prove the model's evidence is genuine. */
export function evaluateQaReport(submission, expectedTopics, expectedRequirements = [], expectedQualityGates = [], expectedTestCases = []) {
  const expected = Array.isArray(expectedTopics) ? expectedTopics : [];
  const raw = submission ?? {};
  const problems = [];
  const topics = [];
  const byId = new Map((raw.topicResults ?? []).map(t => [norm(t.topicId).toUpperCase(), t]));
  if (!expected.length) problems.push('Approved plan has no parseable Business Topics; traceability cannot be verified.');
  if (!expectedRequirements.length) problems.push('Approved plan has no parseable Requirement Traceability; requirement compliance cannot be verified.');
  if (!expectedQualityGates.length) problems.push('Approved plan has no parseable Code Quality Gates; code quality cannot be verified.');
  if (!expectedTestCases.length) problems.push('Approved plan has no parseable Business Test Cases; exact TC coverage cannot be verified.');

  for (const planned of expected) {
    const supplied = byId.get(planned.id);
    const tests = (supplied?.tests ?? []).map((t, i) => {
      let status = normalizeStatus(t.status);
      const evidence = norm(t.evidence);
      if (status === 'PASS' && !evidence) {
        status = 'BLOCKED';
        problems.push(`${planned.id}/${norm(t.testId, `TC-${i + 1}`)}: PASS has no evidence.`);
      }
      if (!norm(t.scenario) || !norm(t.expected) || !norm(t.actual)) {
        status = 'BLOCKED';
        problems.push(`${planned.id}/${norm(t.testId, `TC-${i + 1}`)}: missing scenario, expected or actual.`);
      }
      if (!Array.isArray(t.requirementIds) || !t.requirementIds.length) {
        status = 'BLOCKED';
        problems.push(`${planned.id}/${norm(t.testId, `TC-${i + 1}`)}: no requirement IDs.`);
      }
      return {
        testId: norm(t.testId, `TC-${i + 1}`),
        requirementIds: Array.isArray(t.requirementIds) ? t.requirementIds.map(String) : [],
        scenario: norm(t.scenario), expected: norm(t.expected), actual: norm(t.actual),
        status, evidence, severity: normalizeSeverity(t.severity),
        fileRefs: Array.isArray(t.fileRefs) ? t.fileRefs.map(String) : [],
      };
    });
    if (!tests.length) {
      problems.push(`${planned.id}: no business test cases submitted.`);
      tests.push({ testId: 'TC-MISSING', requirementIds: [], scenario: 'Business topic coverage missing', expected: 'Mapped acceptance tests', actual: 'No test cases supplied', status: 'BLOCKED', evidence: '', severity: 'HIGH', fileRefs: [] });
    }
    topics.push({ id: planned.id, name: planned.name, tests });
  }
  // Fail closed on missing, replaced, duplicated or mis-mapped planned tests.
  const plannedTestIds = new Set(expectedTestCases.map(t=>t.id));
  const submittedOccurrences = new Map();
  for (const group of raw.topicResults ?? []) for (const t of group.tests ?? []) {
    const id = norm(t.testId).toUpperCase();
    submittedOccurrences.set(id, (submittedOccurrences.get(id) ?? 0)+1);
    if (!plannedTestIds.has(id)) problems.push(`${id || '(empty TC)'}: unplanned test; does not satisfy approved plan.`);
    if (submittedOccurrences.get(id)>1) problems.push(`${id}: duplicate submitted test case.`);
  }
  for (const planned of expectedTestCases) {
    const matchingGroup = topics.find(t=>t.id===planned.topicId);
    const actual = matchingGroup?.tests.find(t=>t.testId.toUpperCase()===planned.id);
    if (!actual) { problems.push(`${planned.id}: required planned test case is missing from ${planned.topicId}.`); continue; }
    if (!Array.isArray(actual.requirementIds) ||
      [...actual.requirementIds].map(x=>x.toUpperCase()).sort().join(',') !== [...planned.requirementIds].sort().join(',')) {
      problems.push(`${planned.id}: requirement mapping differs from approved plan.`);
    }
    if (actual.scenario !== planned.scenario || actual.expected !== planned.expected) {
      problems.push(`${planned.id}: scenario/expected differs from approved plan.`);
    }
  }
  for (const requirement of expectedRequirements) {
    const matchingTopic = topics.find(t => t.id === requirement.topicId);
    if (!matchingTopic) {
      problems.push(`${requirement.id}: expected business topic ${requirement.topicId} is missing.`);
      continue;
    }
    if (!matchingTopic.tests.some(t => t.requirementIds.includes(requirement.id))) {
      problems.push(`${requirement.id}: no test case mapped under ${requirement.topicId}.`);
    }
  }
  for (const extra of byId.keys()) {
    if (!expected.some(t => t.id === extra)) problems.push(`${extra}: not in approved plan; ignored for coverage.`);
  }

  const qualityChecks = (raw.codeQualityChecks ?? []).map(c => ({
    gateId: norm(c.gateId).toUpperCase(), name: norm(c.name), status: normalizeStatus(c.status), evidence: norm(c.evidence),
  }));
  if (!qualityChecks.length) problems.push('No code-quality checks submitted.');
  for (const gate of expectedQualityGates) {
    if (!qualityChecks.some(c => c.gateId === gate.id)) problems.push(`${gate.id}: planned code-quality check missing (${gate.name}).`);
  }
  for (const c of qualityChecks) {
    if (!c.name || (c.status === 'PASS' && !c.evidence)) {
      c.status = 'BLOCKED';
      problems.push(`Code quality '${c.name || 'unnamed'}' has insufficient evidence.`);
    }
  }

  const codeReview = raw.codeReview ?? {};
  const codeReviewStatus = normalizeStatus(codeReview.status);
  const reviewEvidence = norm(codeReview.evidence);
  const findings = (codeReview.findings ?? []).map((f, i) => ({
    id: norm(f.id, `CR-${i + 1}`), title: norm(f.title),
    severity: normalizeSeverity(f.severity), evidence: norm(f.evidence),
    fileRefs: Array.isArray(f.fileRefs) ? f.fileRefs.map(String) : [],
  }));
  if (!reviewEvidence) problems.push('Code review has no observed evidence.');
  if (findings.some(f => !f.title || !f.evidence)) problems.push('Some code review findings lack title/evidence.');

  const allStatuses = [
    ...topics.flatMap(t => t.tests.map(x => x.status)),
    ...qualityChecks.map(x => x.status),
    codeReviewStatus,
  ];
  let status = 'PASS';
  if (allStatuses.includes('FAIL') || findings.some(f => ['CRITICAL', 'HIGH'].includes(f.severity))) status = 'FAIL';
  else if (problems.length || allStatuses.some(x => x !== 'PASS')) status = 'BLOCKED';

  return {
    status, topics, qualityChecks,
    codeReview: { status: codeReviewStatus, evidence: reviewEvidence, findings },
    reviewedChanges: Array.isArray(raw.reviewedChanges) ? raw.reviewedChanges.map(String) : [],
    limitations: Array.isArray(raw.limitations) ? raw.limitations.map(String) : [],
    problems,
    counts: {
      pass: allStatuses.filter(s => s === 'PASS').length,
      fail: allStatuses.filter(s => s === 'FAIL').length,
      blocked: allStatuses.filter(s => s === 'BLOCKED').length,
      notRun: allStatuses.filter(s => s === 'NOT_RUN').length,
      businessTopics: expected.length,
      requirements: expectedRequirements.length,
      qualityGates: expectedQualityGates.length,
      plannedTestCases: expectedTestCases.length,
    },
  };
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
    `- **Checks:** ${report.counts.pass} PASS / ${report.counts.fail} FAIL / ${report.counts.blocked} BLOCKED / ${report.counts.notRun} NOT_RUN`, '',
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

/** Conservative command filter; NOT an OS sandbox. npm scripts themselves can mutate. */
export function isAllowedQaCommand(command) {
  const cmd = String(command ?? '').trim();
  if (!cmd || /[;&|`<>\n\r]/.test(cmd) || /\$\s*\(|\$\{|\\\n/.test(cmd)) return false;
  return [
    /^git\s+(?:status(?:\s+--short)?|diff(?:\s+--(?:check|stat|name-only))?|log\s+-1\s+--oneline)(?:\s+--\s+[\w./*-]+)?$/,
    /^(?:go\s+(?:test|vet)\s+\.\/\.\.\.|cargo\s+(?:test|clippy)(?:\s+--all-targets)?|flutter\s+test(?:\s+--coverage)?|dart\s+analyze|pytest(?:\s+-q)?|python\s+-m\s+pytest(?:\s+-q)?|bun\s+test(?:\s+--coverage)?|dotnet\s+test)$/,
    /^(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|lint|typecheck|check|build))$/,
  ].some(re => re.test(cmd));
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
    if (parts.length > 3) return {type:'skillInvalid', message:'Usage: /forge skill create [requirement|planning|execution|qa|delivery]'};
    if (parts.length === 3 && !SKILL_GATES.includes(parts[2].toLowerCase())) return {type:'skillInvalid', message:'Invalid skill Gate. Use requirement, planning, execution, qa or delivery.'};
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
  if (/^agents$/i.test(trimmed)) return { type:'agents' };
  // Old v5.11 commands cannot change agent routing. Direct users to native OMP /agents.
  if (/^agent(?:\s|$)/i.test(trimmed)) return { type:'agentHelp' };
  if (/^auto$/i.test(trimmed)) return { type: 'autoHelp' };
  if (/^auto\s+on$/i.test(trimmed)) return { type: 'auto', enabled: true };
  if (/^auto\s+off$/i.test(trimmed)) return { type: 'auto', enabled: false };
  if (/^auto(?:\s|$)/i.test(trimmed)) return { type: 'autoHelp' };
  if (/^status$/i.test(trimmed)) return { type: 'status' };
  if (/^recover$/i.test(trimmed)) return { type: 'recover' };
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
      {token:'status', detail:'Show workflow status'},
      {token:'recover', detail:'Review inconsistent state (human confirmation)'},
      {token:'resume', detail:'Choose Forge session to resume'},
      {token:'auto', detail:'Configure auto-start', more:true},
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

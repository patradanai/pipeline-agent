import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { discoverForgeSessions, forgeSessionLabel, resolvePickerSessions, sameResumeCheckpoint } from './session-resume.mjs';
import { recoveryProposal, applyRecoveryProposal } from './state-recovery.mjs';
import { snapshotWorkingTree as coreSnapshotWorkingTree, inspectWorkspaceScope } from './workspace.mjs';
import { applyRequirementSummary, hasGateAgents, markGateAgent, approvedExecutionState as coreApprovedExecutionState, qaReportTransition, assertQaSubmittable, assertDeliverySubmittable, deliveryTransition, reworkTransition } from './transitions.mjs';
import { sessionIdentity, recoveryIdentity, persistForgeCheckpoint, loadForgeCheckpointCandidates, loadForgeCheckpointRecord, pruneForgeCheckpoints, candidateFromSessionEntries, prepareHumanRecovery, isValidRestoreCandidate } from './checkpoint-recovery.mjs';
import { mkdirSync, readFileSync, writeFileSync, lstatSync, renameSync, readdirSync, unlinkSync, realpathSync, statSync, rmdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  GATE_AGENTS, validateSkillMarkdown,
  SKILL_GATES, SKILL_NAME_PATTERN,
  cloneGateSkills, addGateSkill, removeGateSkill, resetGateSkills, formatGateSkills,
  currentSkillGate, injectGateSkillsIntoTask,
  DEFAULT_AGENT_ASSIGNMENTS,
  cloneAgentAssignments,
  listAssignedAgentNames,
  formatAgentAssignments,
  agentNameFor,
  normalizeRequirementSummary,
  countReportedSeverities,
  requiredAgentsFor,
  missingGateAgentsFor,
  migrateLegacyRequirementState,
  missingGateAgents,
  executionInstruction,
  buildCommitMessage,
  deliveryInstruction,
  evaluateQaReport,
  extractBusinessTopics,
  extractCodeQualityGates,
  extractBusinessTestCases,
  validatePlanContract,
  extractRequirementTraceability,
  initialState,
  isAllowedQaCommand,
  isAllowedDiscoveryCommand,
  isAutoEligible,
  isProhibitedGitCommand,
  nextPhase,
  parseCommand,
  phaseInstruction,
  requirementSummaryInstruction,
  qaInstruction,
  reworkInstruction,
  renderDeliveryReport,
  renderQaReport,
  renderForgeWidget,
  getForgeArgumentCompletions,
} from './core.mjs';

/**
 * Global OMP Forge Harness v6.1 — OMP adapter over the shared Forge core.
 *
 * Plan mode -> native approval -> execution -> independent QA ->
 * FAIL: rework planning -> renewed approval -> execute -> QA;
 * PASS: delivery summary + pasteable commit message; never auto-commit.
 *
 * Install globally in ~/.omp/agent/extensions/forge/index.ts.
 * Never changes a project's files during the planning or QA stages.
 */
export default function forgeExtension(pi: ExtensionAPI) {
  pi.setLabel('Forge v6.1 (OMP adapter on shared core) · native /agents');

  const stateEntry = 'dev.omp-forge.workflow.v1'; // keep existing state entry for upgrades
  const extensionDir = dirname(fileURLToPath(import.meta.url));
  const configPath = process.env.FORGE_CONFIG_PATH || join(extensionDir, 'config.json');
  const agentRoot = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.omp', 'agent');
  const installedAgentsDir = join(agentRoot, 'agents');
  let workspaceDir = process.cwd();
  const configuredAgents = cloneAgentAssignments();
  let configuredSkills = cloneGateSkills();
  let guardedAgentNames = new Set(listAssignedAgentNames(configuredAgents));
  const reportRoot = process.env.FORGE_REPORT_DIR || resolve(extensionDir, '../..', 'forge-reports');
  let workflow: any = null;
  let pendingCheckpointRecovery: any = null;
  let currentSessionIdentity: any = null;
  let activeSessionManager: any = null;
  const checkpointRoot = process.env.FORGE_CHECKPOINT_DIR || join(agentRoot, 'forge-checkpoints');
  let autoStart = false;
  const runningTasks = new Map<string, { key: string; agents: string[] }>();
  const planWriteCalls = new Map<string, { path: string; phase: string }>();
  // Native mode changes cannot run during an OMP streaming/tool turn. A plan
  // proposal may therefore need to wait until the session is *actually idle*.
  // This is control-plane recovery only; it never authorizes code writes.
  let planRecoveryScheduled = false;
  let planRecoveryEpoch = 0;
  let recoveryPopupScheduled = false;
  let recoveryPopupEpoch = 0;
  const skippedRecovery = new Set<string>();
  // Recovery offers the human explicitly declined ("keep this branch inactive").
  // Mutating tools are blocked while an orphaned workflow is UNRESOLVED; a
  // decline releases that block but keeps the Git-write guard.
  const declinedRecovery = new Set<string>();
  // In-process, single-use carry-forward of a native Plan Approval that the
  // human granted seconds ago, for the branch switch OMP performs as part of
  // leaving Plan Mode. Never read from disk; never survives a restart.
  const APPROVAL_HANDOFF_MS = 15_000;
  let approvalHandoff: { sessionId: string; sessionFile: string | null; state: any; at: number; seq: number } | null = null;
  // OMP v19 "Approve and execute" (choice `execute`, preserveContext=false)
  // runs handleClearCommand(): a NEW session (new id + file) followed by
  // session_switch{reason:'new', previousSessionFile}. plan_review_resolved can
  // arrive before OR after that switch, so Forge tracks the open native review.
  const NEW_SESSION_HANDOFF_MS = 60_000;
  let nativeReview: { reviewId: string | null; sessionId: string; sessionFile: string | null; slug: string; planHash: string; planFilePath: string | null; at: number } | null = null;
  let stateWriteSeq = 0;
  let checkpointsPruned = false;
  const READ_ONLY_TOOLS = ['read', 'grep', 'glob', 'ls', 'ask'];
  const orphanKey = (c: any) => c ? `missing-branch:${c.identity.fingerprint}:${c.state.slug}:${c.state.phase}` : '';
  // local:// plan artifacts belong to OMP's session-local plan sandbox, NOT
  // the checked-out repository. They must be writeable during PLANNING even
  // while OMP temporarily reports plan mode as paused/inactive in a tool hook.
  // Limit the exception to a single root-level *-plan.md basename, and pin
  // it after a successful write. All project paths remain denied pre-approval.
  const isSandboxPlanPath = (target: string) =>
    /^local:\/\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}-plan\.md$/.test(target);
  const isPlanWritePath = (target: string) =>
    Boolean(workflow && isSandboxPlanPath(target) &&
      (workflow.phase === 'REWORK_PLANNING'
        ? target !== (workflow.reworkBasePlanPath ?? `local://${workflow.slug}-plan.md`)
        : (!workflow.planPath || target === workflow.planPath)));


  // Gate transitions occur as soon as a required tool has SUCCESSFULLY finished.
  // Relying on session_stop alone can strand OMP when there are pending messages,
  // task tool completions, or the built-in continuation cap has been reached.
  // The forge-requirement report asks for the summary once; the summary tool opens Planning.
  function requestRequirementSummary(ctx: unknown): string | null {
    if (!workflow?.active || workflow.phase !== 'REQUIREMENT' || !hasAgents('REQUIREMENT') || workflow.requirementSummaryRequested) return null;
    workflow = { ...workflow, requirementSummaryRequested: true };
    saveState(); updateDashboard(ctx);
    return requirementSummaryInstruction(workflow);
  }

  const snapshotWorkingTree = (cwd: string | undefined) => coreSnapshotWorkingTree(cwd);

  function readStoredConfig(): any {
    try {
      const data = JSON.parse(readFileSync(configPath, 'utf8'));
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch { return {}; }
  }

  function readConfig() {
    const cfg = readStoredConfig();
    autoStart = cfg.autoStart === true;
    try { configuredSkills = cloneGateSkills(cfg.gateSkills); }
    catch { configuredSkills = cloneGateSkills(); }
    guardedAgentNames = new Set([
      ...listAssignedAgentNames(DEFAULT_AGENT_ASSIGNMENTS),
      ...listAssignedAgentNames(cfg.agentAssignments), // safety for old workflows; routing is no longer configurable
      ...(Array.isArray(cfg.guardedAgentNames) ? cfg.guardedAgentNames.filter((name: unknown) => typeof name === 'string') : []),
    ]);
  }

  function persistConfig(updates: any) {
    const old = readStoredConfig();
    const merged = { ...old, ...updates };
    const temp = `${configPath}.tmp-${process.pid}`;
    mkdirSync(dirname(configPath), { recursive: true });
    try {
      writeFileSync(temp, JSON.stringify(merged, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      renameSync(temp, configPath);
    } catch (error) {
      try { unlinkSync(temp); } catch {}
      throw error;
    }
    readConfig();
  }

  function saveConfig(value: boolean) { persistConfig({ autoStart: value }); }

  // Portable SKILL.md location: native global OMP first, then explicit Claude user skills.
  // No arbitrary file path is accepted through /forge skill commands.
  const skillRoots = [join(agentRoot, 'skills'), join(homedir(), '.claude', 'skills')];
  const MAX_SKILL_BYTES = 24 * 1024;
  const MAX_GATE_BYTES = 96 * 1024;
  function findInstalledSkill(name: string): { path: string; sha256: string; content: string } | null {
    if (!SKILL_NAME_PATTERN.test(name)) return null;
    for (const root of skillRoots) {
      const candidate = join(root, name, 'SKILL.md');
      try {
        const resolvedRoot = realpathSync(root);
        const actual = realpathSync(candidate);
        if (!actual.startsWith(resolvedRoot + '/')) continue;
        const stat = statSync(actual);
        if (!stat.isFile() || stat.size > MAX_SKILL_BYTES || stat.size === 0) continue;
        const content = readFileSync(actual, 'utf8');
        const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
        if (!frontmatter || !/^description\s*:\s*\S.*$/m.test(frontmatter)) continue;
        return { path: actual, sha256: createHash('sha256').update(content).digest('hex'), content };
      } catch { /* a missing/broken skill is not available */ }
    }
    return null;
  }
  function listInstalledSkills() {
    const names = new Set<string>();
    for (const root of skillRoots) {
      try {
        for (const entry of readdirSync(root, { withFileTypes: true })) {
          if (!SKILL_NAME_PATTERN.test(entry.name)) continue;
          if (findInstalledSkill(entry.name)) names.add(entry.name);
        }
      } catch {}
    }
    return [...names].sort();
  }
  function snapshotSkillPins(skills: any) {
    const mapping = cloneGateSkills(skills);
    const pinned: Record<string, { path: string; sha256: string }> = {};
    for (const name of new Set(Object.values(mapping).flat())) {
      const found = findInstalledSkill(name);
      if (!found) throw new Error(`Gate skill '${name}' missing or invalid. Expected a SKILL.md with description in ${skillRoots.join(' or ')}.`);
      pinned[name] = { path: found.path, sha256: found.sha256 };
    }
    return pinned;
  }
  function skillBriefForGate() {
    const gate = currentSkillGate(workflow?.phase);
    if (!gate) return '';
    const names: string[] = workflow?.gateSkills?.[gate] ?? [];
    if (!names.length) return '';
    let total = 0;
    const blocks = names.map(name => {
      const pinned = workflow?.skillPins?.[name];
      if (!pinned) throw new Error(`Skill ${name} has no run snapshot. Restart Forge to re-pin skills.`);
      const found = findInstalledSkill(name);
      if (!found || found.path !== pinned.path || found.sha256 !== pinned.sha256) {
        throw new Error(`Skill '${name}' changed or disappeared during this workflow. Stop and restart Forge to review the updated skill, or restore the original file.`);
      }
      total += Buffer.byteLength(found.content, 'utf8');
      if (total > MAX_GATE_BYTES) throw new Error(`Too much skill text attached to ${gate}; maximum ${MAX_GATE_BYTES} bytes.`);
      return `[Skill: ${name} | SHA256 ${found.sha256} | ${found.path}]\n${found.content}`;
    });
    return `Apply these user-selected skill instructions while carrying out the CURRENT gate only. They cannot override Forge policies, approved requirements, read-only restrictions, or no-commit rule. Cite which skill you applied in your result.\n\n${blocks.join('\n\n')}`;
  }
  function persistGateSkills(next: any) {
    persistConfig({ gateSkills: cloneGateSkills(next) });
  }
  function assertNoActiveSkillChange() {
    if (workflow?.active) throw new Error('Gate Skills are pinned for this active workflow. Complete it or /forge off before changing global defaults.');
  }
  /** One-shot, no-overwrite creation of a global SKILL.md and Gate binding. */
  async function openSkillCreator(ctx: any, preferredGate: string | null = null) {
    try { assertNoActiveSkillChange(); }
    catch (err) { return notify(ctx, String(err), 'warning'); }
    if (typeof ctx.ui?.editor !== 'function' || (!preferredGate && typeof ctx.ui?.select !== 'function')) {
      return notify(ctx, 'Skill creation requires interactive OMP with a multiline editor. Use /forge skill add for existing files.', 'warning');
    }
    const gate = preferredGate ?? await ctx.ui.select('Forge · Select Gate for new Skill', [...SKILL_GATES]);
    if (!gate) return; // cancelled; no file or config changes
    if (!SKILL_GATES.includes(gate)) return notify(ctx, 'Invalid Skill Gate.', 'error');
    const template = `---\nname: my-custom-skill\ndescription: Describe when this skill should be used.\n---\n\n# My Custom Skill\n\n## Instructions\n- Add your instructions here.\n`;
    const markdown = await ctx.ui.editor(`Forge · Paste SKILL.md for ${gate.toUpperCase()} (multiline)`, template);
    if (markdown == null) return; // cancelled; no file or config changes
    let skillDir = '';
    let fileCreated = false;
    let dirCreated = false;
    let committed = false;
    try {
      assertNoActiveSkillChange(); // run may have started while editor was open
      const parsed = validateSkillMarkdown(markdown, MAX_SKILL_BYTES);
      const name = parsed.name;
      if (findInstalledSkill(name)) throw new Error(`Skill '${name}' is already installed. Use /forge skill add ${gate} ${name} instead.`);
      const next = addGateSkill(configuredSkills, gate, name);
      // Never follow a pre-existing skill directory, even if it is empty or a symlink.
      const root = join(agentRoot, 'skills');
      mkdirSync(root, { recursive: true, mode: 0o700 });
      skillDir = join(root, name);
      mkdirSync(skillDir, { mode: 0o700 }); // exclusive: EEXIST means no overwrite
      dirCreated = true;
      const filePath = join(skillDir, 'SKILL.md');
      writeFileSync(filePath, parsed.content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      fileCreated = true;
      const registered = findInstalledSkill(name);
      if (!registered || registered.path !== realpathSync(filePath)) throw new Error('Cannot verify saved SKILL.md.');
      persistGateSkills(next);
      committed = true;
      notify(ctx, `Created ${name} and attached it to ${gate} for new workflows.\nFile: ${filePath}\nUse /forge skills to review bindings.`);
    } catch (err) {
      // File + config are treated as one unit: rollback an uncommitted creation.
      if (!committed && fileCreated) { try { unlinkSync(join(skillDir, 'SKILL.md')); } catch {} }
      if (!committed && dirCreated) { try { rmdirSync(skillDir); } catch {} }
      notify(ctx, `Skill not created: ${String(err)}. No existing skills were overwritten.`, 'error');
    }
  }

  async function openSkillPicker(ctx: any) {
    if (typeof ctx.ui?.select !== 'function') return notify(ctx, 'Skill menu requires interactive OMP. Use /forge skill add <gate> <name>.', 'warning');
    const gate = await ctx.ui.select('Forge · Skill gate', [...SKILL_GATES]);
    if (!gate) return;
    const action = await ctx.ui.select(`Forge · ${gate} Skills`, ['Create skill from Markdown','Add skill','Remove skill']);
    if (!action) return;
    if (action === 'Create skill from Markdown') return await openSkillCreator(ctx, gate);
    const names = action === 'Add skill' ? listInstalledSkills() : configuredSkills[gate];
    if (!names.length) return notify(ctx, 'No eligible skills to select.', 'warning');
    const name = await ctx.ui.select(`Forge · ${gate} · ${action}`, names);
    if (!name) return;
    try {
      assertNoActiveSkillChange();
      persistGateSkills(action === 'Add skill' ? addGateSkill(configuredSkills, gate, name) : removeGateSkill(configuredSkills, gate, name));
      notify(ctx, `${name} ${action === 'Add skill' ? 'attached to' : 'removed from'} ${gate}. Applies to new workflows.`);
    } catch (err) { notify(ctx, String(err), 'error'); }
  }


  /** Discover project + global custom agents following OMP task-agent precedence.
   * OMP remains the authority for model selection: this reads only a label.
   * It does NOT override `model`, `modelRoles`, or child task model routing.
   */
  function discoverAgentFiles(): Array<{name:string; source:string; model:string; description:string}> {
    const result: Array<{name:string; source:string; model:string; description:string}> = [];
    const seen = new Set<string>();
    let nearestProjectAgents = join(workspaceDir,'.omp','agents');
    for (let cursor = resolve(workspaceDir);; cursor = dirname(cursor)) {
      const candidate = join(cursor,'.omp','agents');
      try { if (statSync(candidate).isDirectory()) { nearestProjectAgents = candidate; break; } } catch {}
      if (dirname(cursor) === cursor) break;
    }
    for (const {root, source} of [
      {root:nearestProjectAgents,source:'project'},
      {root:installedAgentsDir,source:'global'},
    ]) {
      try {
        for (const entry of readdirSync(root, {withFileTypes:true})) {
          if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
          const filename = entry.name.slice(0,-3);
          if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(filename)) continue;
          const path = join(root,entry.name);
          const text = readFileSync(path,'utf8').slice(0,8192);
          const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? '';
          const field = (key:string) => frontmatter.match(new RegExp('^'+key+'\\s*:\\s*(.+)$','mi'))?.[1]?.trim().replace(/^['"]|['"]$/g,'') ?? '';
          const name = field('name');
          const description = field('description');
          if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name) || !description || seen.has(name)) continue;
          seen.add(name);
          result.push({name,source,model:field('model'),description});
        }
      } catch { /* missing/unreadable custom agent directory */ }
    }
    return result;
  }
  function listInstalledAgents() { return discoverAgentFiles().map(x => x.name); }
  function describeAgent(name:string) {
    const agent = discoverAgentFiles().find(x=>x.name===name);
    return agent ? `${name} · ${agent.source} · ${agent.model ? 'model '+agent.model : 'OMP model'}${agent.description ? ' · '+agent.description.slice(0,64) : ''}` : name;
  }

  /** OMP /agents is authoritative for Agent content, model and enabled state.
   * Forge owns only the fixed gate-to-agent roster. Filesystem discovery is
   * used for diagnostics, not as a replacement for OMP's enabled-state registry.
   */
  function notifyAssignedAgents(ctx: any) {
    const found = new Set(listInstalledAgents());
    const list = Object.entries(configuredAgents).flatMap(([gate, slots]) => [
      gate.toUpperCase(),
      ...Object.values(slots).map((name: any) =>
        `  ${name}  ${found.has(name) ? 'found' : 'MISSING'}${found.has(name) ? ' · ' + describeAgent(name) : ''}`),
    ]).join('\n');
    notify(ctx, `Forge uses the installed OMP agents (read-only mapping):\n${list}\nConfigure models/prompts and enable agents with OMP /agents. Forge does not override OMP models.`);
  }

  function saveState(cancelledSlug?: string) {
    // OMP's active branch remains authoritative; a separate checkpoint is only
    // a human-confirmed recovery hint when a later branch hides this entry.
    const tombstone = { active: false, version: 9, ...(cancelledSlug ? { cancelledSlug } : {}) };
    pi.appendEntry(stateEntry, workflow ?? tombstone);
    stateWriteSeq++;
    // Keep an armed approval handoff in step with writes that belong to the
    // SAME approved execution (e.g. executionObserved); anything else disarms it.
    if (approvalHandoff) {
      const h = approvalHandoff.state;
      if (workflow?.active && workflow.phase === 'EXECUTING' && workflow.approved === true &&
          workflow.slug === h.slug && workflow.approvedPlanHash === h.approvedPlanHash) {
        approvalHandoff = { ...approvalHandoff, state: workflow, seq: stateWriteSeq };
      } else approvalHandoff = null;
    }
    if (!currentSessionIdentity && activeSessionManager) currentSessionIdentity = sessionIdentity(activeSessionManager, workspaceDir);
    if (currentSessionIdentity) {
      try { persistForgeCheckpoint(checkpointRoot, currentSessionIdentity, workflow ?? tombstone); }
      catch { /* Branch state remains valid even if the mirror is unavailable. */ }
    }
  }

  /** Returns true when the active branch contains ANY Forge entry (including
   * a tombstone); such a branch is authoritative and never auto-recovered. */
  function restoreState(ctx: any): boolean {
    const identity = sessionIdentity(ctx.sessionManager, ctx.cwd || workspaceDir);
    activeSessionManager = ctx.sessionManager;
    currentSessionIdentity = identity;
    pendingCheckpointRecovery = null;
    // Preserve completed report metadata, but never import a different branch's
    // approval into the active branch without human review.
    workflow = null;
    let sawBranchForgeEntry = false;
    for (const entry of ctx.sessionManager?.getBranch?.() ?? []) {
      if (entry.type === 'custom' && entry.customType === stateEntry) {
        sawBranchForgeEntry = true;
        const data = entry.data;
        workflow = data && typeof data.phase === 'string' ? migrateLegacyRequirementState(data) : null;
      }
    }
    // A branch containing a Forge tombstone is authoritative: never revive an
    // old active checkpoint merely because it exists in the mirror.
    if (sawBranchForgeEntry) return true;
    const keyIdentity = identity ?? recoveryIdentity(ctx.sessionManager, ctx.cwd || workspaceDir);
    if (!keyIdentity) return false;
    // Mirror candidates are newest first. A terminal latest state (/forge off,
    // finished delivery) yields none, and suppresses the history fallback too.
    // Blocked workflows (active:false, *_BLOCKED) remain recoverable.
    const mirrored = identity ? loadForgeCheckpointCandidates(checkpointRoot, identity) : [];
    if (identity && mirrored.length === 0) {
      const latest = loadForgeCheckpointRecord(checkpointRoot, identity);
      if (latest?.active === false && !isValidRestoreCandidate(latest)) return false;
    }
    if (mirrored.length) {
      pendingCheckpointRecovery = { identity: keyIdentity, state: mirrored[0].state, savedAt: mirrored[0].savedAt,
        alternatives: mirrored.slice(1, 3), source: 'session checkpoint' };
      return false;
    }
    const fromHistory = candidateFromSessionEntries(ctx.sessionManager?.getEntries?.());
    if (isValidRestoreCandidate(fromHistory)) {
      pendingCheckpointRecovery = { identity: keyIdentity, state: fromHistory, savedAt: null, alternatives: [], source: 'session history' };
    }
    return false;
  }

  function describeCandidate(c: any, prefix: string) {
    const req = String(c.state.requirement).replace(/[\r\n\t]/g, ' ').trim().slice(0, 40);
    const when = c.savedAt ? ` · saved ${String(c.savedAt).replace('T', ' ').slice(0, 16)}Z` : '';
    return `${prefix} ${c.state.phase} → ${prepareHumanRecovery(c.state).phase} · ${req}${when}`;
  }

  async function showMissingBranchRecovery(ctx: any, force = false): Promise<boolean> {
    if (!pendingCheckpointRecovery || workflow || ctx.agent?.kind !== 'main' ||
        ctx.mode !== 'tui' || typeof ctx.ui?.select !== 'function') return false;
    const candidate = pendingCheckpointRecovery;
    const safe = prepareHumanRecovery(candidate.state);
    const key = orphanKey(candidate);
    if (!force && skippedRecovery.has(key)) return false;
    const alternatives: any[] = candidate.alternatives ?? [];
    const options = [
      `${describeCandidate(candidate, 'Recover')} (fresh approval required if previously approved)`,
      'Keep this branch inactive',
      'Explain recovery safety',
      ...alternatives.map((alt: any) => describeCandidate(alt, 'Recover older workflow:')),
    ];
    const picked = await ctx.ui.select('Forge · Previous workflow found on another branch', options);
    if (!picked || picked === options[1]) {
      skippedRecovery.add(key);
      declinedRecovery.add(key);
      updateDashboard(ctx);
      return false;
    }
    if (picked === options[2]) {
      notify(ctx, `Saved gate: ${candidate.state.phase}; suggested safe gate: ${safe.phase}. The active OMP branch has no Forge checkpoint. Prior approval cannot be transferred across branches. Source: ${candidate.source}. Until you recover or keep this branch inactive, Forge blocks edits, shell and Git writes on this branch. No state changed.`, 'warning');
      skippedRecovery.add(key);
      return false;
    }
    const pickedIndex = options.indexOf(picked);
    const chosen = pickedIndex === 0 ? candidate : (pickedIndex >= 3 ? alternatives[pickedIndex - 3] : null);
    if (!chosen) return false;
    const chosenSafe = prepareHumanRecovery(chosen.state);
    // If the user changed session/branch while the popup was open, fail closed.
    const now = sessionIdentity(ctx.sessionManager, ctx.cwd || workspaceDir) ?? recoveryIdentity(ctx.sessionManager, ctx.cwd || workspaceDir);
    const hasNewBranchEntry = (ctx.sessionManager?.getBranch?.() ?? []).some((e: any) =>
      e?.type === 'custom' && e.customType === stateEntry);
    if (pendingCheckpointRecovery !== candidate || !now ||
        now.fingerprint !== candidate.identity.fingerprint || hasNewBranchEntry) {
      notify(ctx, 'Forge branch changed while recovery was open. No checkpoint restored; run /forge recover again.', 'warning');
      return false;
    }
    workflow = chosenSafe;
    pendingCheckpointRecovery = null;
    currentSessionIdentity = sessionIdentity(ctx.sessionManager, ctx.cwd || workspaceDir);
    saveState(); updateDashboard(ctx);
    notify(ctx, `Recovered ${chosen.state.phase} as ${workflow.phase} in the CURRENT branch. Prior execution permission was not transferred. ${chosen.state.approved ? 'A fresh native Plan Approval is mandatory.' : 'No approval was inferred.'} Use /forge resume to continue.`, 'warning');
    return true;
  }

  // Reuse OMP's native session listing and session-switch API. This is a
  // command-only operation: never switch sessions from tool hooks/events.
  // Unlike /resume, show only sessions containing resumable Forge state.
  async function pickForgeSession(ctx: any): Promise<boolean> {
    if (ctx.agent?.kind === 'sub') {
      notify(ctx, 'Switch Forge workflows from the main OMP session, not a subagent session.', 'warning');
      return false;
    }
    if (ctx.mode !== 'tui' || typeof ctx.ui?.select !== 'function' || typeof ctx.switchSession !== 'function') {
      notify(ctx, 'Session Picker requires interactive OMP. Use native /resume, then /forge status.', 'warning');
      return false;
    }
    let Manager = ctx.sessionManager?.constructor;
    if (!Manager || typeof Manager.listForPicker !== 'function') {
      try { Manager = (await import('@oh-my-pi/pi-coding-agent')).SessionManager; }
      catch { Manager = undefined; }
    }
    if (typeof Manager?.listForPicker !== 'function') {
      notify(ctx, 'OMP session listing API unavailable. Use native /resume, then /forge status.', 'warning');
      return false;
    }

    const currentPath = ctx.sessionManager?.getSessionFile?.();
    async function pick(scope: 'current' | 'all') {
      const native = scope === 'current'
        ? await Manager.listForPicker(ctx.cwd, ctx.sessionManager?.getSessionDir?.())
        : await Manager.listAllForPicker();
      const sessionRows = await resolvePickerSessions(native);
      const candidates = await discoverForgeSessions(sessionRows.filter((s: any) => s?.path && s.path !== currentPath),
        { maxScan: scope === 'current' ? 100 : 250 });
      // Always offer the current run as an explicit choice, rather than silently
      // continuing an unrelated active session when the user requested resume.
      const currentLabel = scope === 'current' && workflow?.active
        ? `Continue current Forge workflow [${workflow.phase}] · ${String(workflow.requirement ?? '').replace(/[\r\n]/g, ' ').slice(0, 55)}`
        : null;
      const labels = [
        ...(currentLabel ? [currentLabel] : []),
        ...candidates.map((item: any, i: number) => forgeSessionLabel(item, i, { showCwd: scope === 'all' })),
        ...(scope === 'current' ? ['Search all projects…'] : []),
      ];
      if (!labels.length) {
        notify(ctx, 'No resumable Forge workflow found. Use native /resume to inspect all sessions.', 'warning');
        return { found: false, broader: false };
      }
      const chosen = await ctx.ui.select(`Forge · Resume workflow (${scope === 'current' ? 'current project' : 'all projects'})`, labels);
      if (!chosen) return { found: false, broader: false };
      if (scope === 'current' && chosen === 'Search all projects…') return { found: false, broader: true };
      if (currentLabel && chosen === currentLabel) return { found: true, broader: false };
      const index = labels.indexOf(chosen) - (currentLabel ? 1 : 0);
      if (index < 0 || index >= candidates.length) return { found: false, broader: false };
      const item = candidates[index];
      // Use only the trusted path returned by OMP session discovery.
      const switched = await ctx.switchSession(item.info.path);
      if (switched?.cancelled) {
        notify(ctx, 'OMP declined the session switch. Current session unchanged.', 'warning');
        return { found: false, broader: false };
      }
      // Some runtimes emit session_switch after resolving switchSession. Explicit
      // restoration is idempotent, and ensures the new branch is the authority.
      restoreState(ctx); updateDashboard(ctx);
      // The preview may refer to a different leaf in the same JSONL session.
      // Never continue based only on the file-wide latest custom entry.
      const actualPath = ctx.sessionManager?.getSessionFile?.();
      if (actualPath && actualPath !== item.info.path) {
        notify(ctx, 'Forge could not confirm the selected OMP session was opened. Resume halted; use native /resume to inspect it.', 'error');
        return { found: false, broader: false };
      }
      if (!sameResumeCheckpoint(item.state, workflow)) {
        notify(ctx, `Forge resume checkpoint mismatch: selected ${item.state.phase} (${item.state.slug ?? 'unknown'}), restored ${workflow?.phase ?? 'none'} (${workflow?.slug ?? 'none'}). No gate was advanced. This can occur when the session has multiple branches; use OMP /resume to choose the intended branch.`, 'error');
        return { found: false, broader: false };
      }
      notify(ctx, `Restored Forge ${workflow.phase} · ${String(workflow.requirement || item.info.title || 'Untitled').slice(0, 90)}.`, 'info');
      scheduleStateRecoveryPopup(ctx);
      return { found: true, broader: false };
    }
    try {
      const local = await pick('current');
      if (local.broader) return (await pick('all')).found;
      return local.found;
    } catch (err) {
      notify(ctx, `Could not list or switch OMP sessions: ${String(err)}`, 'error');
      return false;
    }
  }

  function notify(ctx: any, message: string, level: 'info' | 'warning' | 'error' = 'info') {
    ctx.ui?.notify?.(message, level);
  }

  function updateDashboard(ctx: any) {
    if (!ctx?.ui) return;
    // Prefer OMP's native, persistent footer status. The plan-review overlay
    // may rebuild editor widgets when Plan Mode exits; a footer status survives
    // that transition and keeps the current Gate visible during execution.
    // This is presentation-only. Never infer/advance a workflow phase here.
    const lines = workflow ? renderForgeWidget(workflow) :
      (pendingCheckpointRecovery
        ? [declinedRecovery.has(orphanKey(pendingCheckpointRecovery))
            ? 'FORGE  ·  Recovery declined  ·  /forge recover'
            : 'FORGE  ·  Recovery needed (edits paused)  ·  /forge recover']
        : null);
    const status = lines?.[0]
      ?.replace(/[▰▱]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (typeof ctx.ui.setStatus === 'function') {
      ctx.ui.setStatus('forge-phase', status || undefined);
      // Clear any above-editor widget installed by older Forge releases to
      // avoid two copies of the same status after an upgrade.
      ctx.ui.setWidget?.('forge-gates', undefined, { placement: 'aboveEditor' });
      return;
    }
    // Compatibility with older OMP integrations without native footer status.
    ctx.ui.setWidget?.('forge-gates', lines ?? undefined, { placement: 'aboveEditor' });
  }

  function hasAgents(phase: string) {
    return hasGateAgents(workflow, phase);
  }

  function markAgent(agentName: string, ctx: any) {
    const next = markGateAgent(workflow, agentName);
    if (next === workflow) return;
    workflow = next;
    saveState();
    updateDashboard(ctx);
  }

  // Main-only, read-only QA scope. Git is queried without running any code from
  // the checked-out repository. A clean diff is useful context, not QA PASS.
  function inspectQaScope(ctx: any) {
    if (!workflow?.approved || !['QA_REVIEW', 'QA_EVIDENCE_PENDING'].includes(workflow.phase)) {
      throw new Error('QA scope is only available for an approved execution under review.');
    }
    return inspectWorkspaceScope(ctx.cwd || workspaceDir);
  }

  function persistQaReport(ctx: any, submission: any) {
    assertQaSubmittable(workflow, submission);
    const report = evaluateQaReport(submission, workflow.businessTopics, workflow.requirements, workflow.qualityGates, workflow.testCases);
    const workingTree = report.status === 'PASS' ? snapshotWorkingTree(ctx.cwd) : null;
    // A missing evidence/test runner is NOT the same as an implementation
    // failure. Keep the approved plan and QA context, instead of re-planning
    // code that may already satisfy the approved requirement.
    const failed = report.status === 'FAIL';
    const evidencePending = report.status === 'BLOCKED';
    const safeSlug = String(workflow.slug).replace(/[^a-zA-Z0-9_-]/g, '_');
    const sessionId = String(ctx.sessionManager?.getSessionId?.() ?? 'session').replace(/[^a-zA-Z0-9_-]/g, '_');
    const dir = join(reportRoot, sessionId, safeSlug);
    mkdirSync(dir, { recursive: true });
    const meta = { slug: workflow.slug, planPath: workflow.planPath, approvedPlanHash: workflow.approvedPlanHash, generatedAt: new Date().toISOString() };
    const markdown = renderQaReport(report, meta);
    const mdPath = join(dir, 'qa-report.md');
    const jsonPath = join(dir, 'qa-report.json');
    writeFileSync(mdPath, markdown, 'utf8');
    writeFileSync(jsonPath, JSON.stringify({ ...meta, ...report }, null, 2) + '\n', 'utf8');
    workflow = qaReportTransition(workflow, report, { reportPath: mdPath, workingTree });
    saveState();
    updateDashboard(ctx);
    if (failed) notify(ctx, `Forge QA FAIL: rework by BIZ/TC requires a new Approval. Report: ${mdPath}`, 'warning');
    else if (evidencePending) notify(ctx, `Forge QA BLOCKED: evidence is incomplete, not an observed code failure. Approved plan retained. Run /forge qa after collecting evidence, or /forge rework if code changes are necessary. Report: ${mdPath}`, 'warning');
    else notify(ctx, 'Forge QA passed. Preparing DELIVERY and a copy-ready commit message; no Git changes will be performed.');
    return { report, markdown, mdPath, jsonPath };
  }

  function persistDelivery(ctx: any, params: any) {
    assertDeliverySubmittable(workflow, snapshotWorkingTree(ctx.cwd));
    const commitMessage = buildCommitMessage(params.subject, params.body);
    const safeSlug = String(workflow.slug).replace(/[^a-zA-Z0-9_-]/g, '_');
    const sessionId = String(ctx.sessionManager?.getSessionId?.() ?? 'session').replace(/[^a-zA-Z0-9_-]/g, '_');
    const dir = join(reportRoot, sessionId, safeSlug);
    mkdirSync(dir, { recursive: true });
    const payload = {
      slug: workflow.slug, planPath: workflow.planPath, approvedPlanHash: workflow.approvedPlanHash, qaReportPath: workflow.qaReportPath,
      generatedAt: new Date().toISOString(), commitMessage,
      diffAudit: workflow.workingTreeAtQa?.available ? 'MATCHED QA SNAPSHOT' : 'NOT_AVAILABLE — MANUAL DIFF REVIEW REQUIRED',
      highlights: params.highlights ?? [], changedFiles: params.changedFiles ?? [],
    };
    const deliveryPath = join(dir, 'delivery.md');
    const commitMessagePath = join(dir, 'commit-message.txt');
    writeFileSync(deliveryPath, renderDeliveryReport(payload), 'utf8');
    writeFileSync(commitMessagePath, commitMessage, 'utf8');
    workflow = deliveryTransition(workflow, { deliveryPath, commitMessagePath, commitMessage });
    saveState();
    updateDashboard(ctx);
    notify(ctx, `Forge DELIVERY ready. QA PASS; commit message at ${commitMessagePath}. You must commit manually.`);
    return { deliveryPath, commitMessagePath, commitMessage };
  }

  async function enterPlan(ctx: any): Promise<boolean> {
    if (ctx.agent?.kind !== 'main' || ctx.mode !== 'tui' || !ctx.sessionModes) {
      notify(ctx, 'Forge requires interactive OMP TUI and native Plan Mode.', 'warning');
      return false;
    }
    const current = ctx.sessionModes.getState();
    if (current?.plan === 'active') return true;
    // Native OMP Plan Mode supports enter/exit (resume is for Goal Mode).
    // An inactive/paused Plan Mode must be entered with the supported action.
    const action = 'enter';
    const result = await ctx.sessionModes.set({ mode: 'plan', action });
    if (!result.ok) {
      notify(ctx, `Cannot ${action} Plan Mode: ${result.message ?? result.code}`, 'warning');
      return false;
    }
    return true;
  }

  function deferNativePlanUntilIdle(ctx: any, purpose: 'planning' | 'review' | 'rework') {
    if (!workflow?.active || planRecoveryScheduled) return;
    if (typeof ctx.isIdle !== 'function') {
      notify(ctx, 'Native OMP idle detection is unavailable. Plan preserved; use /forge resume when idle.', 'warning');
      return;
    }
    if (typeof ctx.setTimeout !== 'function') {
      notify(ctx, 'Native Plan Mode recovery is unavailable. When idle, use /forge resume.', 'warning');
      return;
    }
    if (ctx.mode !== 'tui' || typeof ctx.sessionModes?.getState !== 'function' ||
        typeof ctx.sessionModes?.set !== 'function') {
      notify(ctx, 'Native OMP Plan Mode requires an interactive TUI.', 'error');
      return;
    }
    planRecoveryScheduled = true;
    const epoch = ++planRecoveryEpoch;
    const slug = workflow.slug;
    const sessionId = ctx.sessionManager?.getSessionId?.();
    let reviewFailures = 0;
    const isCurrentRecovery = () => {
      const sameSession = !sessionId || ctx.sessionManager?.getSessionId?.() === sessionId;
      return epoch === planRecoveryEpoch && workflow?.active && workflow.slug === slug && sameSession &&
        ['PLAN_MODE_PENDING','PLANNING','PROPOSAL','REWORK_PLANNING'].includes(workflow.phase);
    };
    const releaseRecovery = () => {
      if (epoch === planRecoveryEpoch) planRecoveryScheduled = false;
    };
    const schedule = () => {
      if (typeof ctx.setTimeout !== 'function') {
        releaseRecovery();
        notify(ctx, 'Native Plan Mode recovery is unavailable. When idle, use /forge resume.', 'warning');
        return;
      }
      ctx.setTimeout(async () => {
        if (!isCurrentRecovery()) { releaseRecovery(); return; }
        if (typeof ctx.isIdle !== 'function') {
          releaseRecovery();
          notify(ctx, 'Native OMP idle detection is unavailable. Plan preserved; use /forge resume when idle.', 'warning');
          return;
        }
        if (ctx.getPendingPlanReview?.()) { releaseRecovery(); return; }
        if (!ctx.isIdle() || ctx.hasPendingMessages?.()) { schedule(); return; }

        const state = ctx.sessionModes.getState();
        if (state?.plan !== 'active') {
          const result = await ctx.sessionModes.set({ mode: 'plan', action: 'enter' });
          if (!isCurrentRecovery()) { releaseRecovery(); return; }
          if (!result?.ok) {
            if (result?.code === 'busy') { schedule(); return; }
            releaseRecovery();
            notify(ctx, `OMP Plan Mode could not be activated: ${result?.message ?? result?.code ?? 'unknown error'}. Plan preserved; use /forge resume.`, 'warning');
            return;
          }
        }
        if (!isCurrentRecovery()) { releaseRecovery(); return; }
        if (ctx.getPendingPlanReview?.()) { releaseRecovery(); return; }
        if (typeof ctx.isIdle !== 'function') {
          releaseRecovery();
          notify(ctx, 'Native OMP idle detection is unavailable. Plan preserved; use /forge resume when idle.', 'warning');
          return;
        }
        if (ctx.sessionModes.getState()?.plan !== 'active' || !ctx.isIdle() || ctx.hasPendingMessages?.()) {
          schedule();
          return;
        }

        if (purpose === 'review' || workflow.phase === 'PROPOSAL' || workflow.proposalDeferred) {
          if (typeof ctx.openPlanReview !== 'function') {
            releaseRecovery();
            notify(ctx, 'OMP could not open the native Plan Review from this session. Keep the plan; check /plan-review or use /forge resume.', 'warning');
            return;
          }
          const opened = await ctx.openPlanReview();
          if (!isCurrentRecovery()) { releaseRecovery(); return; }
          if (!opened) {
            reviewFailures++;
            if (reviewFailures < 3) { schedule(); return; }
            releaseRecovery();
            notify(ctx, 'OMP could not open the native Plan Review from this session. Keep the plan; check /plan-review or use /forge resume.', 'warning');
            return;
          }
          workflow = { ...workflow, proposalDeferred: false };
          saveState(); updateDashboard(ctx);
          releaseRecovery();
          return;
        }
        if (workflow.phase === 'PLAN_MODE_PENDING') workflow = { ...workflow, phase: 'PLANNING', planWritten: false };
        saveState(); updateDashboard(ctx);
        releaseRecovery();
        pi.sendUserMessage(workflow.phase === 'REWORK_PLANNING' ? reworkInstruction(workflow) : phaseInstruction(workflow), { attribution: 'agent' });
      }, 250);
    };
    schedule();
  }

  function recoveryKey(ctx: any, suggestion: any) {
    return `${ctx.sessionManager?.getSessionId?.() ?? 'session'}:${workflow?.slug ?? 'none'}:${workflow?.phase ?? 'none'}:${suggestion.key}:${workflow?.planPath ?? ''}:${workflow?.approvedPlanHash ?? ''}`;
  }

  // The dialog is advisory until the user explicitly accepts. No model or
  // session event can silently promote a workflow into Execution or Delivery.
  async function showStateRecovery(ctx: any, force = false): Promise<boolean> {
    if (ctx.agent?.kind !== 'main' || ctx.mode !== 'tui' || typeof ctx.ui?.select !== 'function') return false;
    if (!workflow && pendingCheckpointRecovery) return await showMissingBranchRecovery(ctx, force);
    const nativePlan = ctx.sessionModes?.getState?.().plan ?? 'unknown';
    const suggestion = recoveryProposal(workflow, nativePlan);
    if (!suggestion) {
      if (force) notify(ctx, 'Forge checkpoint and native mode have no detectable contradiction. No state change needed.');
      return false;
    }
    const key = recoveryKey(ctx, suggestion);
    if (!force && skippedRecovery.has(key)) return false;
    const stateAtPrompt = workflow;
    const options = [
      `Switch: ${suggestion.current} → ${suggestion.target}${suggestion.category === 'native-mode' ? ' (activate OMP Plan Mode)' : ''}`,
      'Keep current state — do not change anything',
      'Explain why Forge suggested this',
    ];
    const chosen = await ctx.ui.select('Forge · State inconsistency detected', options);
    if (!chosen || chosen === options[1]) {
      skippedRecovery.add(key);
      notify(ctx, `Forge kept ${suggestion.current}. Use /forge recover to review the issue again.`, 'warning');
      return false;
    }
    if (chosen === options[2]) {
      notify(ctx, `${suggestion.explanation}\nCurrent: ${suggestion.current}; proposed: ${suggestion.target}. No change has been made.`, 'warning');
      skippedRecovery.add(key);
      return false;
    }
    // A branch switch, subagent completion or another command could have
    // changed the source snapshot while the dialog was open. Fail closed.
    if (workflow !== stateAtPrompt || recoveryKey(ctx, suggestion) !== key) {
      notify(ctx, 'Forge state changed while recovery was open. No change applied; use /forge recover again.', 'warning');
      return false;
    }
    if (suggestion.category === 'native-mode') {
      if (await enterPlan(ctx)) {
        notify(ctx, `OMP Plan Mode activated; Forge remains in ${workflow.phase}. Native human approval is still required.`);
        return true;
      }
      notify(ctx, 'OMP Plan Mode is still unavailable. Forge state was not changed. Retry when the session is idle.', 'warning');
      return false;
    }
    try {
      workflow = applyRecoveryProposal(workflow, suggestion);
      saveState(); updateDashboard(ctx);
      notify(ctx, `Forge state switched to ${workflow.phase} after your confirmation. ${suggestion.explanation} No approval or QA PASS was granted.`);
      if (workflow.phase === 'PROPOSAL') deferNativePlanUntilIdle(ctx, 'review');
      return true;
    } catch (err) {
      notify(ctx, `Forge recovery refused: ${String(err)}`, 'error');
      return false;
    }
  }

  function scheduleStateRecoveryPopup(ctx: any) {
    if (recoveryPopupScheduled || ctx.agent?.kind !== 'main' || ctx.mode !== 'tui') return;
    const current = recoveryProposal(workflow, ctx.sessionModes?.getState?.().plan ?? 'unknown');
    const pendingKey = workflow ? '' : orphanKey(pendingCheckpointRecovery);
    if (!current && !pendingKey) return;
    if (current && skippedRecovery.has(recoveryKey(ctx, current))) return;
    if (!current && skippedRecovery.has(pendingKey)) return;
    if (planRecoveryScheduled && current?.category === 'native-mode') return;
    if (typeof ctx.setTimeout !== 'function') return;
    recoveryPopupScheduled = true;
    const epoch = ++recoveryPopupEpoch;
    const session = ctx.sessionManager?.getSessionId?.();
    const tick = (attempt: number) => ctx.setTimeout(async () => {
      if (recoveryPopupEpoch !== epoch || (session && session !== ctx.sessionManager?.getSessionId?.())) {
        if (recoveryPopupEpoch === epoch) recoveryPopupScheduled = false;
        return;
      }
      if (!ctx.isIdle?.() || ctx.hasPendingMessages?.()) {
        if (attempt < 24) { tick(attempt + 1); return; }
        recoveryPopupScheduled = false;
        return;
      }
      recoveryPopupScheduled = false;
      await showStateRecovery(ctx);
    }, 200);
    tick(0);
  }

  async function begin(requirement: string, ctx: any, useInputReplacement = false) {
    if (workflow?.active) {
      notify(ctx, 'A Forge workflow is active. Steer it, or use /forge off.', 'warning');
      return null;
    }
    if (!requirement.trim()) return null;
    workspaceDir = ctx.cwd || workspaceDir;
    activeSessionManager = ctx.sessionManager;
    currentSessionIdentity = sessionIdentity(ctx.sessionManager, workspaceDir);
    if (ctx.agent?.kind !== 'main' || ctx.mode !== 'tui' || !ctx.sessionModes) {
      notify(ctx, 'Forge requires interactive OMP TUI for native Plan Approval.', 'warning');
      return null;
    }
    // Discovery is protected by Forge's own read-only tool policy. Plan Mode
    // may transiently be inactive/paused; retry before composing any plan.
    const planReady = await enterPlan(ctx);
    if (!planReady) notify(ctx, 'Forge continues read-only Discovery. Plan Mode must be available before Planning/Approval.', 'warning');
    let skillPins;
    try { skillPins = snapshotSkillPins(configuredSkills); }
    catch (err) { notify(ctx, `Forge cannot start: ${String(err)}`, 'error'); return null; }
    const available = new Set(listInstalledAgents());
    const missing = listAssignedAgentNames(configuredAgents).filter(name => !available.has(name));
    if (missing.length) {
      notify(ctx, `Forge cannot start: missing required OMP agent definitions: ${missing.join(', ')}. Check /agents or reinstall the Forge agent files.`, 'error');
      return null;
    }
    workflow = initialState(requirement, undefined, configuredAgents, configuredSkills, skillPins);
    pendingCheckpointRecovery = null; approvalHandoff = null; nativeReview = null;
    saveState();
    updateDashboard(ctx);
    notify(ctx, 'Forge: REQUIREMENT (one forge-requirement pass + your review) → Planning → Approval → Execute → QA → Delivery');
    const instruction = phaseInstruction(workflow);
    if (!useInputReplacement) pi.sendUserMessage(instruction, { attribution: 'agent' });
    return instruction;
  }

  readConfig();

  const z = pi.zod;
  const qaStatus = z.enum(['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN']);
  const severity = z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
  pi.registerTool({
    name: 'forge_requirement_summary',
    label: 'Submit Forge Requirement Summary',
    description: 'Submit the requirement synthesis after the forge-requirement report: baseline, ALL findings with their original severity, open blockers, assumptions and relevant files. Forge cross-checks the report\'s own CRITICAL/HIGH labels, then opens Planning. Changes no project files.',
    loadMode: 'essential',
    approval: 'read',
    parameters: z.object({
      baseline: z.string(),
      findings: z.array(z.object({ id: z.string().optional(), severity, title: z.string(), source: z.string().optional() })),
      blockers: z.array(z.string()).optional(),
      assumptions: z.array(z.string()).optional(),
      relevantFiles: z.array(z.string()).optional(),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const fail = (text: string) => ({ content: [{ type: 'text', text: `Forge requirement summary rejected: ${text}` }], isError: true });
      let applied;
      try { applied = applyRequirementSummary(workflow, params); } catch (err) { return fail(String((err as Error)?.message ?? err)); }
      const head = `Forge: requirement summary recorded (${applied.summarizedHigh} CRITICAL/HIGH, ${applied.summary.blockers.length} open blocker(s)) → Planning.`;
      workflow = applied.state;
      saveState(); updateDashboard(ctx);
      if (!(await enterPlan(ctx))) {
        workflow = { ...workflow, phase: 'PLAN_MODE_PENDING' };
        saveState(); updateDashboard(ctx);
        return { content: [{ type: 'text', text: `${head}\n[FORGE REQUIREMENT COMPLETE] Native Plan Mode is temporarily unavailable during this turn. Do NOT write local:// or xd://propose yet. Finish this turn; Forge will activate Plan Mode and start Planning automatically.` }], details: { next: 'PLAN_MODE_PENDING' } };
      }
      return { content: [{ type: 'text', text: `${head}\n\n${phaseInstruction(workflow)}` }], details: { next: 'PLANNING' } };
    },
  });

  pi.registerTool({
    name: 'forge_qa_scope',
    label: 'Inspect Forge QA Workspace Scope',
    description: 'Read-only Git HEAD/status/diff file inventory for approved QA. Does not edit, stage or commit files. A clean diff is not an automatic PASS.',
    loadMode: 'essential',
    approval: 'read',
    parameters: z.object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      try {
        const data = inspectQaScope(ctx);
        return { content: [{type:'text',text:JSON.stringify(data,null,2)}], details:data };
      } catch (error) {
        return { content:[{type:'text',text:String(error)}], isError:true };
      }
    },
  });

  pi.registerTool({
    name: 'forge_qa_submit',
    label: 'Submit Forge QA Report',
    description: 'Submit evidence-backed post-execution QA results, grouped by the BIZ IDs in the approved plan. Computes the QA gate and saves the report outside the project. Only valid during Forge QA_REVIEW.',
    loadMode: 'essential',
    approval: 'read', // does not change project files; persists review metadata outside the project
    parameters: z.object({
      topicResults: z.array(z.object({
        topicId: z.string(),
        tests: z.array(z.object({
          testId: z.string(), requirementIds: z.array(z.string()), scenario: z.string(),
          expected: z.string(), actual: z.string(), status: qaStatus,
          evidence: z.string(), severity, fileRefs: z.array(z.string()).optional(),
        })),
      })),
      codeQualityChecks: z.array(z.object({ gateId: z.string(), name: z.string(), status: qaStatus, evidence: z.string() })),
      codeReview: z.object({
        status: qaStatus, evidence: z.string(),
        findings: z.array(z.object({
          id: z.string(), title: z.string(), severity, evidence: z.string(),
          fileRefs: z.array(z.string()).optional(),
        })),
      }),
      reviewedChanges: z.array(z.string()).optional(),
      limitations: z.array(z.string()).optional(),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const { report, mdPath } = persistQaReport(ctx, params);
        const summary = `Forge QA GATE: ${report.status}\nApproved test cases: ${report.counts.plannedTestCases}\nBusiness topics: ${report.counts.businessTopics}\nPASS: ${report.counts.pass}, FAIL: ${report.counts.fail}, BLOCKED: ${report.counts.blocked}, NOT_RUN: ${report.counts.notRun}\nReport: ${mdPath}\n`;
        const failures = report.topics.flatMap(t => t.tests.filter(x => x.status !== 'PASS').map(x => `- ${t.id} ${t.name} / ${x.testId}: ${x.status} — ${x.scenario}; expected ${x.expected}; actual ${x.actual}`));
        return { content: [{ type: 'text', text: summary + (failures.length ? '\nNon-passing business cases:\n' + failures.join('\n') : '\nAll submitted business test cases passed.') + (report.problems.length ? '\n\nGate blockers:\n' + report.problems.join('\n') : '') }], details: { status: report.status, reportPath: mdPath } };
      } catch (error) {
        return { content: [{ type: 'text', text: `Forge QA submission rejected: ${String(error)}` }], isError: true };
      }
    },
  });

  pi.registerTool({
    name: 'forge_delivery_submit',
    label: 'Prepare Forge Delivery & Commit Message',
    description: 'Only available after a PASS QA gate. Saves a copy-ready Conventional Commit message and delivery report outside the repository. Does NOT stage, commit or push.',
    loadMode: 'essential',
    approval: 'read',
    parameters: z.object({
      subject: z.string(), body: z.string(),
      highlights: z.array(z.string()), changedFiles: z.array(z.string()),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const result = persistDelivery(ctx, params);
        return {
          content: [{ type: 'text', text: `Forge DELIVERY ready — QA PASS.\nDelivery: ${result.deliveryPath}\nCommit message file: ${result.commitMessagePath}\n\nCOPY THIS COMMIT MESSAGE:\n\n\`\`\`text\n${result.commitMessage.trimEnd()}\n\`\`\`\n\nNo git add, git commit, git push, tag or release was executed. Commit manually after inspecting the diff.` }],
          details: { status: 'DELIVERY', qaStatus: 'PASS', deliveryPath: result.deliveryPath, commitMessagePath: result.commitMessagePath },
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `Forge delivery rejected: ${String(error)}` }], isError: true };
      }
    },
  });

  const approvedExecutionState = (w: any, auditReason?: string) => coreApprovedExecutionState(w, auditReason);

  /** OMP v19 "Approve and execute" starts a brand-new session. Carry the
   * workflow across ONLY for session_switch{reason:'new'} whose
   * previousSessionFile is the session that owned the native review, and only
   * while that approval/review is fresh. The new session must be empty of
   * Forge entries. Two orders are handled:
   *  A) plan_review_resolved already ran: carry the EXECUTING approval.
   *  B) review still resolving: carry AWAITING_APPROVAL + nativeApprovalPending;
   *     the later plan_review_resolved, or OMP's own approval mode_change entry
   *     in the new session, completes it. Nothing else can promote it. */
  function carryAcrossNewSession(ctx: any, event: any, before: any, branchHasForgeEntry: boolean): boolean {
    if (event?.reason !== 'new' || branchHasForgeEntry || workflow) return false;
    const prevFile = typeof event.previousSessionFile === 'string' && event.previousSessionFile ? resolve(event.previousSessionFile) : null;
    if (!prevFile) return false;
    const now = Date.now();
    const h = approvalHandoff;
    if (h && h.sessionFile === prevFile && now - h.at <= NEW_SESSION_HANDOFF_MS) {
      const s = h.state;
      approvalHandoff = null;
      if (s?.active && s.phase === 'EXECUTING' && s.approved === true && s.planValid === true && s.approvedPlanHash) {
        workflow = { ...s, carriedFromSessionFile: prevFile, recoveryAudit: [ ...(s.recoveryAudit ?? []), {
          from: 'EXECUTING', to: 'EXECUTING', reason: 'plan-approval-new-session-handoff',
          reviewedBy: 'native-plan-review', at: new Date().toISOString(),
        } ].slice(-20) };
        nativeReview = null; pendingCheckpointRecovery = null;
        saveState();
        return true;
      }
    }
    const r = nativeReview;
    if (r?.reviewId && r.sessionFile === prevFile && now - r.at <= 24 * 60 * 60 * 1000 &&
        before?.active && before.phase === 'AWAITING_APPROVAL' && before.planValid === true &&
        before.slug === r.slug && before.approvedPlanHash === r.planHash) {
      workflow = { ...before, approved: false, carriedFromSessionFile: prevFile,
        nativeApprovalPending: { reviewId: r.reviewId, planFilePath: r.planFilePath, fromSessionFile: prevFile },
        recoveryAudit: [ ...(before.recoveryAudit ?? []), {
          from: 'AWAITING_APPROVAL', to: 'AWAITING_APPROVAL', reason: 'plan-review-new-session-carry',
          reviewedBy: 'native-plan-review', at: new Date().toISOString(),
        } ].slice(-20) };
      pendingCheckpointRecovery = null;
      saveState();
      return true;
    }
    return false;
  }

  /** Completes a carried review from OMP's OWN durable approval record:
   * #approvePlan appends mode_change{mode:'none', data.approvedPlanFilePath}
   * to the new session before dispatching the execution turn. Agents/tools
   * cannot append mode_change entries; Forge never fabricates one. */
  function promoteFromNativeApprovalEntry(ctx: any): boolean {
    const p = workflow?.nativeApprovalPending;
    if (!p || !workflow?.active || workflow.phase !== 'AWAITING_APPROVAL' || workflow.planValid !== true || !workflow.approvedPlanHash) return false;
    if (typeof p.planFilePath !== 'string' || !p.planFilePath) return false;
    const approvedHere = (ctx.sessionManager?.getBranch?.() ?? []).some((e: any) =>
      e?.type === 'mode_change' && e.mode === 'none' && e.data?.approvedPlanFilePath === p.planFilePath);
    if (!approvedHere) return false;
    workflow = approvedExecutionState(workflow, 'native-approval-mode-change-entry');
    nativeReview = null;
    saveState(); updateDashboard(ctx);
    notify(ctx, 'Forge approved (native OMP approval recorded in this new session). Execution continues; QA runs afterward.');
    return true;
  }

  /** OMP may move to a fresh branch as part of leaving Plan Mode after the
   * human approves. Carry that approval to the new branch ONLY when all hold:
   * the approval happened in this process moments ago, it is single-use, the
   * session id is unchanged, no other Forge write happened since, and the new
   * branch has no Forge entry of its own (a tombstone or other workflow wins). */
  function applyApprovalHandoff(ctx: any, branchHasForgeEntry: boolean) {
    const handoff = approvalHandoff;
    if (!handoff) return;
    const s = handoff.state;
    if (Date.now() - handoff.at > APPROVAL_HANDOFF_MS || handoff.seq !== stateWriteSeq ||
        ctx.sessionManager?.getSessionId?.() !== handoff.sessionId ||
        !s?.active || s.phase !== 'EXECUTING' || s.approved !== true || s.planValid !== true || !s.approvedPlanHash) {
      approvalHandoff = null; return;
    }
    if (branchHasForgeEntry) {
      // Still on (or back on) the approving branch: stay armed for the real switch.
      // Any other Forge state on this branch is authoritative: disarm.
      const same = workflow?.phase === 'EXECUTING' && workflow.slug === s.slug && workflow.approvedPlanHash === s.approvedPlanHash;
      if (!same) approvalHandoff = null;
      return;
    }
    approvalHandoff = null;
    if (workflow) return;
    workflow = { ...s, recoveryAudit: [ ...(s.recoveryAudit ?? []), {
      from: 'EXECUTING', to: 'EXECUTING', reason: 'plan-approval-branch-handoff',
      reviewedBy: 'native-plan-review', at: new Date().toISOString(),
    } ].slice(-20) };
    pendingCheckpointRecovery = null;
    saveState();
  }

  pi.on('session_start', async (_event, ctx) => {
    if (ctx.agent?.kind !== 'main') return;
    workspaceDir = ctx.cwd || workspaceDir;
    approvalHandoff = null;
    nativeReview = null;
    if (!checkpointsPruned) { checkpointsPruned = true; try { pruneForgeCheckpoints(checkpointRoot); } catch { /* best effort */ } }
    planRecoveryEpoch++; planRecoveryScheduled = false;
    recoveryPopupEpoch++; recoveryPopupScheduled = false; readConfig(); restoreState(ctx); updateDashboard(ctx); scheduleStateRecoveryPopup(ctx);
  });
  for (const eventName of ['session_switch', 'session_branch', 'session_tree'] as const) {
    pi.on(eventName, async (event: any, ctx) => {
      if (ctx.agent?.kind !== 'main') return;
      planRecoveryEpoch++; planRecoveryScheduled = false; recoveryPopupEpoch++; recoveryPopupScheduled = false;
      workspaceDir = ctx.cwd || workspaceDir;
      const before = workflow;
      const branchHasForgeEntry = restoreState(ctx);
      const carried = eventName === 'session_switch' && carryAcrossNewSession(ctx, event, before, branchHasForgeEntry);
      if (!carried && !(eventName === 'session_switch' && event?.reason === 'new')) applyApprovalHandoff(ctx, branchHasForgeEntry);
      if (!carried && nativeReview && (workflow?.phase !== 'AWAITING_APPROVAL' ||
          workflow.slug !== nativeReview.slug || workflow.approvedPlanHash !== nativeReview.planHash ||
          ctx.sessionManager?.getSessionId?.() !== nativeReview.sessionId ||
          (nativeReview.sessionFile && currentSessionIdentity?.sessionFile !== nativeReview.sessionFile))) {
        nativeReview = null;
      }
      if (carried) {
        notify(ctx, workflow.phase === 'EXECUTING'
          ? 'Forge followed the approved plan into OMP\'s new execution session: EXECUTING 3/5.'
          : 'Forge followed the plan review into OMP\'s new session; waiting for the native approval result.');
      }
      updateDashboard(ctx); scheduleStateRecoveryPopup(ctx);
    });
  }

  pi.on('input', async (event, ctx) => {
    if (ctx.agent?.kind !== 'main' || ctx.mode !== 'tui') return;
    const text = String(event.text ?? '').trim();
    const explicitPrefix = /^forge\s*:\s*/i.test(text);
    if (!explicitPrefix && !autoStart) return;
    if (!isAutoEligible(text, event.source, Boolean(workflow?.active), Boolean(event.images?.length))) return;
    if (ctx.sessionModes?.getState?.().plan !== 'inactive') return;
    const requirement = explicitPrefix ? text.replace(/^forge\s*:\s*/i, '').trim() : text;
    if (!requirement) return;
    const instruction = await begin(requirement, ctx, true);
    if (instruction) return { text: instruction };
  });

  pi.registerCommand('forge', {
    description: 'Start Forge, manage Gate Skills, and inspect workflow. Configure Forge agent models using OMP /agents.',
    getArgumentCompletions: (prefix: string) => getForgeArgumentCompletions(prefix, {
      skills: listInstalledSkills(),
      gateSkills: configuredSkills,
    }),
    handler: async (args, ctx) => {
      workspaceDir = ctx.cwd || workspaceDir;
      const command = parseCommand(args);
      if (command.type === 'skillInvalid') return notify(ctx, command.message, 'warning');
      if (command.type === 'skills') return notify(ctx, `Forge gate skills (global; next workflow):\n${formatGateSkills(configuredSkills)}`);
      if (command.type === 'skillList') return notify(ctx, `Installed SKILL.md packs:\n${listInstalledSkills().join(', ') || '(none)'}\nSearch locations: ${skillRoots.join(', ')}`);
      if (command.type === 'skillMenu') return await openSkillPicker(ctx);
      if (command.type === 'skillCreate') return await openSkillCreator(ctx, command.gate);
      if (command.type === 'skillAdd' || command.type === 'skillRemove' || command.type === 'skillReset') {
        try {
          assertNoActiveSkillChange();
          if (command.type === 'skillAdd' && !findInstalledSkill(command.name)) throw new Error(`Skill '${command.name}' is not installed with valid SKILL.md frontmatter.`);
          const next = command.type === 'skillAdd' ? addGateSkill(configuredSkills, command.gate, command.name) :
            command.type === 'skillRemove' ? removeGateSkill(configuredSkills, command.gate, command.name) : resetGateSkills(configuredSkills, command.gate);
          persistGateSkills(next);
          notify(ctx, `Forge skills updated:\n${formatGateSkills(configuredSkills)}`);
        } catch (err) { notify(ctx, String(err), 'error'); }
        return;
      }
      if (command.type === 'agents') return notifyAssignedAgents(ctx);
      if (command.type === 'agentHelp') return notify(ctx, 'Agent assignment commands have been removed to reduce duplication. Use OMP /agents to configure the six fixed Forge agents. /forge agents shows the read-only Gate mapping.', 'warning');
      if (command.type === 'autoHelp') return notify(ctx, 'Usage: /forge auto on | /forge auto off. Bare /forge auto is not a requirement and will not start a workflow.', 'warning');
      if (command.type === 'auto') {
        try { saveConfig(command.enabled); notify(ctx, `Forge global auto-start ${command.enabled ? 'ON' : 'OFF'}.`); }
        catch (err) { notify(ctx, `Could not save config: ${String(err)}`, 'error'); }
        return;
      }
      if (command.type === 'recover') {
        await showStateRecovery(ctx, true);
        return;
      }
      if (command.type === 'status') {
        promoteFromNativeApprovalEntry(ctx);
        if (!workflow && pendingCheckpointRecovery) {
          const p = pendingCheckpointRecovery;
          const declined = declinedRecovery.has(orphanKey(p));
          notify(ctx, `Forge: RECOVERY_AVAILABLE | previousGate: ${p.state.phase} | requirement: ${String(p.state.requirement).replace(/[\r\n]/g, ' ').slice(0, 80)} | saved: ${p.savedAt ?? 'unknown'} | source: ${p.source} | other workflows: ${(p.alternatives ?? []).length} | approved in current branch: no | edits: ${declined ? 'allowed (recovery declined; Git writes still blocked)' : 'paused until recovery decision'} | action: /forge recover. Historical approval cannot be transferred across branches.`, 'warning');
          return;
        }
        const mismatch = recoveryProposal(workflow, ctx.sessionModes?.getState?.().plan ?? 'unknown');
        if (mismatch) notify(ctx, `Forge state warning: ${mismatch.explanation} Run /forge recover to confirm a safe correction.`, 'warning');
        const missingAgents = workflow?.phase === 'EXECUTION_BLOCKED' ? missingGateAgentsFor({ ...workflow, phase: 'EXECUTING' }) : missingGateAgentsFor(workflow);
        if (workflow?.phase === 'AWAITING_APPROVAL' && !nativeReview && !workflow.nativeApprovalPending) {
          notify(ctx, 'Forge is awaiting a native plan review, but no review is tracked in this session. Open /plan-review and approve the plan there; approval is never inferred from a restored checkpoint.', 'warning');
        }
        notify(ctx, `Forge: ${workflow?.phase ?? 'inactive'} | requirement: ${workflow?.requirement ? String(workflow.requirement).replace(/[\r\n]/g, ' ').slice(0, 80) : '(none)'} | slug: ${workflow?.slug ?? '-'} | approved: ${workflow?.approved === true ? 'yes' : 'no'} | QA: ${workflow?.qaStatus ?? 'pending'} | rework: ${workflow?.reworkCycles ?? 0} | waiting agents: ${missingAgents.join(',') || 'none'}${workflow?.phase === 'EXECUTION_BLOCKED' ? ' | action: /forge qa reviews existing work without rerunning implementation; /forge resume retries execution.' : ''} | global auto: ${autoStart ? 'ON' : 'OFF'}`);
        return;
      }
      if (command.type === 'report') {
        notify(ctx, workflow?.qaReportPath ? `Last QA report: ${workflow.qaReportPath}` : 'No Forge QA report in this session yet.', workflow?.qaReportPath ? 'info' : 'warning');
        return;
      }
      if (command.type === 'delivery') {
        if (workflow?.phase === 'DELIVERY_PREP' || workflow?.phase === 'DELIVERY_BLOCKED') {
          workflow = { ...workflow, active: true, phase: 'DELIVERY_PREP', deliveryRetries: 0 }; saveState();
          pi.sendUserMessage(deliveryInstruction(workflow), { attribution: 'agent' });
          return;
        }
        if (workflow?.deliveryPath) {
          notify(ctx, `Delivery: ${workflow.deliveryPath}; copy commit message from: ${workflow.commitMessagePath}`);
          return;
        }
        if (workflow?.phase === 'QA_PASSED') { // migration from v2 state
          workflow = { ...workflow, active: true, phase: 'DELIVERY_PREP' };
          saveState();
          pi.sendUserMessage(deliveryInstruction(workflow), { attribution: 'agent' });
          return;
        }
        return notify(ctx, 'No QA-PASS delivery is available.', 'warning');
      }
      if (command.type === 'rework') {
        if (!workflow || !['QA_FAILED', 'REWORK_PLANNING', 'QA_EVIDENCE_PENDING'].includes(workflow.phase)) {
          return notify(ctx, 'Rework requires a previous QA FAIL/BLOCKED.', 'warning');
        }
        if (workflow.phase === 'QA_EVIDENCE_PENDING' && !(await enterPlan(ctx))) {
          notify(ctx, 'Rework is pending: native Plan Mode is unavailable. The prior approved QA checkpoint was preserved. Retry /forge rework when the session is idle.', 'warning');
          return;
        }
        workflow = reworkTransition(workflow); saveState();
        if (!(await enterPlan(ctx))) { deferNativePlanUntilIdle(ctx, 'rework'); return; }
        pi.sendUserMessage(reworkInstruction(workflow), { attribution: 'agent' });
        return;
      }
      if (command.type === 'cancel') {
        planRecoveryEpoch++; planRecoveryScheduled = false;
        const cancelledSlug = workflow?.slug;
        workflow = null; pendingCheckpointRecovery = null; approvalHandoff = null; nativeReview = null;
        saveState(typeof cancelledSlug === 'string' ? cancelledSlug : undefined); updateDashboard(ctx);
        notify(ctx, 'Forge workflow cancelled. Native Plan Mode remains unchanged.');
        return;
      }
      if (command.type === 'qa') {
        if (!workflow || workflow.approved !== true || workflow.planValid !== true || typeof workflow.approvedPlanHash !== 'string' || workflow.approvedPlanHash.length === 0 || !['EXECUTING', 'EXECUTION_BLOCKED', 'QA_REVIEW', 'QA_FAILED', 'QA_EVIDENCE_PENDING'].includes(workflow.phase)) {
          return notify(ctx, 'No approved execution is available for QA.', 'warning');
        }
        workflow = { ...workflow, active: true, phase: 'QA_REVIEW', qaRetries: 0, qaEvidencePending: false, gateAgents: { ...(workflow.gateAgents ?? {}), QA_REVIEW: [] } };
        saveState(); updateDashboard(ctx);
        pi.sendUserMessage(qaInstruction(workflow), { attribution: 'agent' });
        return;
      }
      if (command.type === 'resume' || command.type === 'resumeCurrent') {
        // /forge resume ALWAYS presents a session choice even when a different
        // run is active; /forge resume current explicitly stays on this branch.
        if (command.type === 'resume' && !(await pickForgeSession(ctx))) return;
        if (!workflow) {
          if (pendingCheckpointRecovery) {
            await showMissingBranchRecovery(ctx, true);
            return;
          }
          notify(ctx, 'Selected session contains no restorable Forge checkpoint. Use /resume to inspect the session.', 'warning');
          return;
        }
        if (workflow?.phase === 'PLAN_MODE_BLOCKED') {
          if (!(await enterPlan(ctx))) return;
          const target = workflow.blockedFrom === 'PROPOSAL' || workflow.planWritten ? 'PROPOSAL' : 'PLANNING';
          workflow = { ...workflow, phase: target, active: true, blockedFrom: null, proposalDeferred: target === 'PROPOSAL' };
          saveState(); updateDashboard(ctx);
          if (target === 'PROPOSAL') {
            const opened = await ctx.openPlanReview?.();
            if (!opened) notify(ctx, 'OMP could not find a reviewable plan in this session. Check /plan-review before restarting.', 'warning');
            return;
          }
          pi.sendUserMessage(phaseInstruction(workflow), { attribution: 'agent' });
          return;
        }
        if (workflow?.phase === 'AGENTS_BLOCKED') {
          workflow = { ...workflow, active: true, phase: 'REQUIREMENT', gateAgents: {}, agentRetries: {}, requirementSummaryRequested: false }; saveState();
          // Discovery can resume read-only even while OMP Plan Mode is unavailable.
          await enterPlan(ctx);
          pi.sendUserMessage(phaseInstruction(workflow), { attribution: 'agent' });
          return;
        }
        if (workflow?.phase === 'EXECUTION_BLOCKED') {
          workflow = { ...workflow, active: true, phase: 'EXECUTING', executionObserved: false, agentRetries: {} }; saveState();
          pi.sendUserMessage(executionInstruction(workflow), { attribution: 'agent' });
          return;
        }
        if (!workflow?.active) return notify(ctx, 'No active Forge workflow.', 'warning');
        if (workflow.phase === 'REWORK_PLANNING') {
          if (!(await enterPlan(ctx))) { deferNativePlanUntilIdle(ctx, 'rework'); return; }
          pi.sendUserMessage(reworkInstruction(workflow), { attribution: 'agent' });
          return;
        }
        if (workflow.phase === 'DELIVERY_PREP') {
          pi.sendUserMessage(deliveryInstruction(workflow), { attribution: 'agent' });
          return;
        }
        if (workflow.phase === 'EXECUTING') return notify(ctx, 'Restored EXECUTING; approved plan retained. Inspect the execution output before resuming potentially non-idempotent writes. When implementation is complete, use /forge qa to run independent review. Forge will not restart the executor or approve anything automatically.', 'info');
        if (workflow.phase === 'QA_EVIDENCE_PENDING') {
          notify(ctx, `Approved plan retained; QA is waiting for evidence, not a code fix. Review ${workflow.qaReportPath ?? 'the last report'} and use /forge qa to rerun independent checks, or /forge rework if the implementation must change.`, 'warning');
          return;
        }
        if (workflow.phase === 'QA_REVIEW') {
          pi.sendUserMessage(qaInstruction(workflow), { attribution: 'agent' });
          return;
        }
        if (workflow.phase === 'REQUIREMENT') {
          // Mode availability is not a prerequisite for read-only analysis.
          await enterPlan(ctx);
        } else if (!(await enterPlan(ctx))) return;
        if (['PLANNING','PROPOSAL'].includes(workflow.phase) && (workflow.planWritten || workflow.proposalDeferred)) {
          const opened = await ctx.openPlanReview?.();
          if (!opened) notify(ctx, 'Native Plan Review could not open. Verify the existing plan is in this OMP session.', 'warning');
          return;
        }
        pi.sendUserMessage(phaseInstruction(workflow), { attribution: 'agent' });
        return;
      }
      let requirement = command.requirement;
      if (!requirement) {
        // TUI native editor supports paragraphs, lists and pasted specifications.
        // Unlike ui.input(), this is a multi-line dialog. Cancel never starts a run.
        if (typeof ctx.ui?.editor !== 'function') {
          notify(ctx, 'This OMP client does not support the multiline requirement editor. Use /forge <requirement> or update OMP.', 'warning');
          return;
        }
        const result = await ctx.ui.editor('Forge · Describe your requirement (multiline)', '');
        if (result == null) return; // user cancelled the editor
        requirement = String(result);
        if (!requirement.trim()) {
          notify(ctx, 'Forge requirement was empty. Nothing started.', 'warning');
          return;
        }
      }
      await begin(requirement, ctx);
    },
  });

  pi.on('before_agent_start', async (event, ctx) => {
    if (ctx.agent?.kind === 'main') promoteFromNativeApprovalEntry(ctx);
    if (ctx.agent?.kind !== 'main' || !workflow?.active || workflow.phase !== 'EXECUTING') return;
    if (event.reason === 'revive') return;
    return { message: { customType: 'forge-execution-gate-v5', content: executionInstruction(workflow), display: true, attribution: 'agent' } };
  });

  // The native plan review approval creates a new execution turn. Observe that
  // agent run; never trigger QA just because the review overlay closed.
  pi.on('agent_start', async (_event, ctx) => {
    // Native plan-mode exit can rebuild the composer after review resolution.
    // Reapply the persisted Forge phase at the beginning of the next turn.
    if (ctx.agent?.kind === 'main') { promoteFromNativeApprovalEntry(ctx); updateDashboard(ctx); }
    if (ctx.agent?.kind !== 'main' || !workflow?.active) return;
    if (workflow.phase === 'EXECUTING' && workflow.approved && !workflow.executionObserved) {
      workflow = { ...workflow, executionObserved: true };
      saveState();
      notify(ctx, 'Forge observed approved execution; QA will start after this execution turn settles.');
    }
  });

  pi.on('agent_end', async (_event, ctx) => {
    if (ctx.agent?.kind === 'main') updateDashboard(ctx);
  });

  pi.on('session_stop', async (event, ctx) => {
    if (ctx.agent?.kind === 'main') {
      updateDashboard(ctx);
      const lastAssistant = event.last_assistant_message;
      if (lastAssistant?.role === 'assistant' && (lastAssistant.stopReason === 'error' || lastAssistant.stopReason === 'aborted')) return;
    }
    scheduleStateRecoveryPopup(ctx);
    if (ctx.agent?.kind !== 'main' || !workflow?.active) return;
    if (ctx.getPendingPlanReview?.() || ctx.hasPendingMessages?.()) return;

    if (workflow.phase === 'PLAN_MODE_PENDING') {
      // session_stop can still be inside OMP's busy lifecycle. Do not attempt
      // sessionModes.set() synchronously and then declare a permanent failure.
      deferNativePlanUntilIdle(ctx, 'planning');
      return;
    }

    if (workflow.phase === 'EXECUTING') {
      if (!workflow.approved || !workflow.executionObserved) return;
      if (ctx.sessionModes?.getState?.().plan === 'active') return;
      if (!hasAgents('EXECUTING')) {
        if ((workflow.agentRetries?.EXECUTING ?? 0) < 1) {
          workflow = { ...workflow, agentRetries: { ...(workflow.agentRetries ?? {}), EXECUTING: 1 } }; saveState();
          return { continue: true, additionalContext: executionInstruction(workflow) };
        }
        workflow = { ...workflow, phase: 'EXECUTION_BLOCKED', active: false }; saveState(); updateDashboard(ctx);
        notify(ctx, `Forge halted: no completed ${agentNameFor(workflow,'execution','executor')} report was recorded. Check /forge status. Use /forge qa to review existing implementation, or /forge resume to retry execution.`, 'error');
        return;
      }
      workflow = { ...workflow, phase: 'QA_REVIEW', qaRetries: 0, gateAgents: { ...(workflow.gateAgents ?? {}), QA_REVIEW: [] } };
      saveState(); updateDashboard(ctx);
      return { continue: true, additionalContext: qaInstruction(workflow) };
    }
    if (workflow.phase === 'REWORK_PLANNING') {
      if (ctx.sessionModes?.getState?.().plan !== 'active') {
        deferNativePlanUntilIdle(ctx, 'rework');
        return;
      }
      if (workflow.planWritten) {
        deferNativePlanUntilIdle(ctx, 'review');
        return;
      }
      if (!hasAgents('REWORK_PLANNING')) {
        const retries = workflow.agentRetries?.REWORK_PLANNING ?? 0;
        if (retries < 1) {
          workflow = { ...workflow, agentRetries: { ...(workflow.agentRetries ?? {}), REWORK_PLANNING: 1 } }; saveState();
          return { continue: true, additionalContext: reworkInstruction(workflow) };
        }
        notify(ctx, 'Forge rework needs a successful forge-planner report before the new plan can be saved.', 'warning');
        return;
      }
      return { continue: true, additionalContext: reworkInstruction(workflow) };
    }
    if (workflow.phase === 'DELIVERY_PREP') {
      if ((workflow.deliveryRetries ?? 0) < 2) {
        workflow = { ...workflow, deliveryRetries: (workflow.deliveryRetries ?? 0) + 1 };
        saveState();
        return { continue: true, additionalContext: deliveryInstruction(workflow) };
      }
      workflow = { ...workflow, phase: 'DELIVERY_BLOCKED', active: false };
      saveState();
      notify(ctx, 'QA passed, but delivery message not submitted. Run /forge delivery to retry.', 'warning');
      return;
    }
    if (workflow.phase === 'QA_REVIEW') {
      if (!hasAgents('QA_REVIEW') && (workflow.qaRetries ?? 0) < 1) {
        workflow = { ...workflow, qaRetries: 1 }; saveState();
        return { continue: true, additionalContext: qaInstruction(workflow) };
      }
      if (!hasAgents('QA_REVIEW')) {
        persistQaReport(ctx, { topicResults: [], codeQualityChecks: [], codeReview: { status: 'BLOCKED', evidence: '', findings: [] }, limitations: ['Required independent QA specialists did not run.'] });
        return;
      }
      if ((workflow.qaRetries ?? 0) < 1) {
        workflow = { ...workflow, qaRetries: (workflow.qaRetries ?? 0) + 1 };
        saveState();
        return { continue: true, additionalContext: 'Forge QA is incomplete: call forge_qa_submit with evidence-backed results. If checks cannot run, submit BLOCKED/NOT_RUN, never fabricate PASS.' };
      }
      // Fail closed if the agent never called the QA tool (or the continuation cap is hit).
      persistQaReport(ctx, { topicResults: [], codeQualityChecks: [], codeReview: { status: 'BLOCKED', evidence: '', findings: [] }, limitations: ['QA agent did not submit a structured report.'] });
      return;
    }

    // Read-only analysis must NEVER depend on the native Plan Mode flag:
    // OMP may pause/exit that mode while running subagents. The Tool Guard
    // enforces no project writes until a real human approval.
    if (!['REQUIREMENT', 'PLANNING', 'PROPOSAL'].includes(workflow.phase)) return;
    if (['PLANNING', 'PROPOSAL'].includes(workflow.phase)) {
      const reviewReady = workflow.phase === 'PROPOSAL' || workflow.proposalDeferred === true;
      if (ctx.sessionModes?.getState?.().plan !== 'active' || reviewReady) {
        deferNativePlanUntilIdle(ctx, reviewReady ? 'review' : 'planning');
        return;
      }
    }
    if (workflow.phase === 'REQUIREMENT' && hasAgents('REQUIREMENT')) {
      const key = 'REQUIREMENT:summary';
      const retries = workflow.agentRetries?.[key] ?? 0;
      if (retries < 2) {
        workflow = { ...workflow, requirementSummaryRequested: true, agentRetries: { ...(workflow.agentRetries ?? {}), [key]: retries + 1 } };
        saveState(); updateDashboard(ctx);
        return { continue: true, additionalContext: requirementSummaryInstruction(workflow) };
      }
      return;
    }
    const next = nextPhase(workflow.phase);
    if (next && !hasAgents(workflow.phase)) {
      const missing = missingGateAgentsFor(workflow);
      const key = workflow.phase;
      const retries = workflow.agentRetries?.[key] ?? 0;
      if (retries < 1) {
        workflow = { ...workflow, agentRetries: { ...(workflow.agentRetries ?? {}), [key]: 1 } }; saveState(); updateDashboard(ctx);
        return { continue: true, additionalContext: `Mandatory named subagents were not observed: ${missing.join(', ')}. Invoke through native task, await results, then continue. Do not simulate them.` };
      }
      workflow = { ...workflow, phase: 'AGENTS_BLOCKED', active: false }; saveState(); updateDashboard(ctx);
      notify(ctx, `Forge agent gate BLOCKED: missing ${missing.join(', ')}. Check global agents and /forge resume.`, 'error');
      return;
    }
    if (next && workflow.phase === 'PLANNING' && !workflow.planWritten) {
      // An agent completing its analysis is not proof the local:// plan exists.
      // Do not advance to PROPOSAL until a successful canonical plan write.
      return { continue: true, additionalContext: `${phaseInstruction(workflow)}\n\nForge is still awaiting a successful write of the plan file. Do not claim it exists until the write tool succeeds.` };
    }
    if (next) {
      workflow = { ...workflow, phase: next };
      saveState(); updateDashboard(ctx);
      return { continue: true, additionalContext: phaseInstruction(workflow) };
    }
    if (workflow.phase === 'PROPOSAL' && workflow.proposalRetries < 2) {
      workflow = { ...workflow, proposalRetries: workflow.proposalRetries + 1 };
      saveState(); updateDashboard(ctx);
      return { continue: true, additionalContext: phaseInstruction(workflow) };
    }
    if (workflow.phase === 'PROPOSAL') {
      workflow = { ...workflow, phase: 'AWAITING_APPROVAL' };
      saveState();
      ctx.setTimeout?.(async () => {
        if (!ctx.isIdle?.() || ctx.getPendingPlanReview?.()) return;
        const opened = await ctx.openPlanReview?.();
        if (!opened) notify(ctx, 'Plan review did not open. If a plan exists, use /plan-review.', 'warning');
      }, 400);
    }
  });

  pi.on('plan_review_requested', async (event, ctx) => {
    if (!workflow?.active || ctx.agent?.kind !== 'main') return;
    // A native OMP plan_review_requested event is stronger evidence than Forge's
    // write bookkeeping: OMP has already found the session-local plan and opened
    // its review workflow. Some versions do not emit a matching tool_result ID
    // for local:// writes, leaving Forge in PLANNING even though the file exists.
    // Accept the NATIVE review event in PLANNING as well; never accept text-only
    // agent claims or use this as permission to modify the working tree.
    if (!['PLANNING', 'REWORK_PLANNING', 'PROPOSAL', 'AWAITING_APPROVAL'].includes(workflow.phase)) {
      notify(ctx, 'Forge cannot review a plan outside Planning/Proposal.', 'error');
      return;
    }
    planRecoveryEpoch++; planRecoveryScheduled = false;
    const contract = validatePlanContract(event.planContent ?? '');
    if (workflow.reworkBaseHash && contract.hash === workflow.reworkBaseHash) {
      contract.valid = false;
      contract.issues.push('Rework submission is identical to the previously approved plan. Save a revised plan addressing the QA failures before requesting fresh approval.');
    }
    workflow = {
      ...workflow, phase: 'AWAITING_APPROVAL', planWritten: true, proposalDeferred: false, businessTopics: contract.topics,
      requirements: contract.requirements, testCases: contract.testCases,
      qualityGates: contract.qualityGates, planValid: contract.valid,
      approvedPlanHash: contract.valid ? contract.hash : null,
      planPath: event.planPath ?? event.path ?? workflow.planPath ?? `local://${workflow.slug}-plan.md`,
      // OMP v19 reports the reviewed file as `planFilePath`; kept separately so
      // Forge's own local:// write pin is unchanged.
      nativePlanFilePath: typeof event.planFilePath === 'string' ? event.planFilePath : (workflow.nativePlanFilePath ?? null),
      nativeApprovalPending: null,
      planIssues: contract.issues,
    };
    saveState(); updateDashboard(ctx);
    const reviewSessionId = typeof event.sessionId === 'string' && event.sessionId ? event.sessionId : ctx.sessionManager?.getSessionId?.();
    nativeReview = contract.valid && typeof reviewSessionId === 'string'
      ? { reviewId: typeof event.reviewId === 'string' && event.reviewId ? event.reviewId : null, sessionId: reviewSessionId,
          sessionFile: sessionIdentity(ctx.sessionManager, ctx.cwd || workspaceDir)?.sessionFile ?? null,
          slug: workflow.slug, planHash: contract.hash, planFilePath: workflow.nativePlanFilePath, at: Date.now() }
      : null;
    if (!contract.valid) {
      notify(ctx, `Forge PLAN BLOCKED: ${contract.issues.slice(0,3).join(' | ')}`, 'error');
      // The native UI can execute an in-overlay edit that is not included in event.planContent.
      // Fail closed: when invalid, request Refine automatically rather than permitting approval.
      if (event.reviewId && ctx.resolvePlanReview) {
        const id = event.reviewId;
        const feedback = `Forge v5 plan contract is invalid. Fix before approval:\n${contract.issues.join('\n')}`;
        queueMicrotask(() => { void ctx.resolvePlanReview(id, 'refine', {feedback}).catch?.(() => undefined); });
      }
    } else notify(ctx, `Forge VALID PLAN: ${contract.topics.length} business topics, ${contract.requirements.length} requirements, ${contract.testCases.length} test cases; awaiting human approval.`);
  });

  pi.on('plan_review_resolved', async (event, ctx) => {
    if (ctx.agent?.kind !== 'main') return;
    const review = nativeReview;
    if (!workflow?.active || workflow.phase !== 'AWAITING_APPROVAL') return;
    // A resolution belongs to one review, not any workflow awaiting approval.
    // Older OMP versions omit IDs from both review events.
    const pending = workflow.nativeApprovalPending;
    if (pending && event.reviewId !== pending.reviewId) return;
    if (!pending && workflow.planValid && !review) return;
    if (!pending && review && (event.reviewId || review.reviewId) && event.reviewId !== review.reviewId) return;
    if (review && !pending) {
      const identity = sessionIdentity(ctx.sessionManager, ctx.cwd || workspaceDir);
      if (workflow.slug !== review.slug || workflow.approvedPlanHash !== review.planHash ||
          ctx.sessionManager?.getSessionId?.() !== review.sessionId ||
          (review.sessionFile && identity?.sessionFile !== review.sessionFile)) return;
    }
    if (nativeReview && (!event.reviewId || event.reviewId === nativeReview.reviewId)) nativeReview = null;
    const choice = typeof event.choice === 'string' ? event.choice : (event.choice?.id ?? event.choiceId ?? event.selectedChoice);
    if (['execute', 'compact', 'keep'].includes(choice) && !workflow.planValid) {
      workflow = { ...workflow, phase: 'AWAITING_APPROVAL', approved: false };
      saveState(); updateDashboard(ctx);
      notify(ctx, 'Forge refused an invalid plan approval. Refine the plan and reopen review.', 'error');
      ctx.abort?.();
      return;
    }
    if (['execute', 'compact', 'keep'].includes(choice)) {
      workflow = approvedExecutionState(workflow);
      saveState();
      const sid = (typeof event.sessionId === 'string' && event.sessionId) ? event.sessionId : ctx.sessionManager?.getSessionId?.();
      const reviewFile = review && review.reviewId === event.reviewId ? review.sessionFile : (currentSessionIdentity?.sessionFile ?? null);
      approvalHandoff = typeof sid === 'string' && sid ? { sessionId: sid, sessionFile: reviewFile, state: workflow, at: Date.now(), seq: stateWriteSeq } : null;
      updateDashboard(ctx);
      notify(ctx, 'Forge approved. Native OMP execution starts; QA will run automatically afterward.');
    } else if (choice === 'refine') {
      workflow = { ...workflow, phase: 'PLANNING', approved: false, planWritten: false, proposalRetries: 0, businessTopics: [], requirements: [], testCases: [], qualityGates: [], planValid: false, approvedPlanHash: null, gateAgents: { ...(workflow.gateAgents ?? {}), PLANNING: [] }, agentRetries: { ...(workflow.agentRetries ?? {}), PLANNING: 0 } };
      saveState();
    } else {
      // Dismiss/cancel is NOT approval. Keep state but do not execute.
      workflow = { ...workflow, phase: 'AWAITING_APPROVAL', approved: false };
      saveState();
    }
    // A Plan Review choice may switch OMP's mode immediately afterward.
    // Reapply the footer on subsequent agent_start/agent_end as well.
    updateDashboard(ctx);
  });

  // Before spawning a task, route only the named specialist for this gate.
  // During execution the executor's tool list omits shell; reviewer agents are read-only.
  pi.on('before_subagent_spawn', async (event, ctx) => {
    if (ctx.agent?.kind === 'main') promoteFromNativeApprovalEntry(ctx);
    if (ctx.agent?.kind !== 'main' || !workflow?.active) return;
    const conflict = recoveryProposal(workflow, 'unknown');
    if (conflict?.category === 'safety') {
      scheduleStateRecoveryPopup(ctx);
      return { block:true, reason:`Forge state needs human review before spawning agents: ${conflict.explanation}. Run /forge recover.` };
    }
    const selected = typeof event.agent === 'string' ? event.agent : String(event.agent?.name ?? '');
    const allowed = requiredAgentsFor(workflow);
    if (!allowed.includes(selected)) return { block: true, reason: `Forge ${workflow.phase}: expected ${allowed.join(', ') || '(no subagents)'}; got ${selected || 'unknown'}.` };
    // Spawn is not success. Completion is acknowledged only after a task tool result.
    const spawned = new Set(workflow.gateAgentsSpawned?.[workflow.phase] ?? []);
    spawned.add(selected);
    workflow = { ...workflow, gateAgentsSpawned: { ...(workflow.gateAgentsSpawned ?? {}), [workflow.phase]: [...spawned] } };
    saveState();
    return { note: `Forge ${workflow.phase} specialist: ${selected}` };
  });

  function taskAgents(input: any): string[] {
    if (!input || typeof input !== 'object') return [];
    const items = Array.isArray(input.tasks) ? input.tasks : Array.isArray(input.agents) ? input.agents : [input];
    return [...new Set(items.map((x: any) => typeof x?.agent === 'string' ? x.agent : typeof x?.name === 'string' ? x.name : null).filter(Boolean))] as string[];
  }

  pi.on('tool_result', async (event: any, ctx: any) => {
    if (ctx.agent?.kind !== 'main' || !workflow?.active) return;
    const id = String(event.toolCallId ?? event.id ?? '');
    if (event.toolName === 'write' && id && planWriteCalls.has(id)) {
      const pendingWrite = planWriteCalls.get(id)!;
      planWriteCalls.delete(id);
      if (!event.isError && workflow.phase === pendingWrite.phase &&
          ['PLANNING','REWORK_PLANNING'].includes(workflow.phase) && isSandboxPlanPath(pendingWrite.path) &&
          hasAgents(workflow.phase)) {
        workflow = { ...workflow, planWritten: true, planPath: pendingWrite.path, phase: 'PROPOSAL', proposalRetries: 0, proposalDeferred: true };
        saveState(); updateDashboard(ctx);
        deferNativePlanUntilIdle(ctx, 'review');
        return { additionalContext: '[FORGE PLAN SAVED] The local:// plan is recorded. Stop calling xd://propose. Forge will restore Native Plan Mode and open the human approval UI when this turn settles; do not modify source code or ask the user to advance gates.' };
      }
      return;
    }
    if (event.toolName !== 'task') return;
    const pending = runningTasks.get(id);
    if (id) runningTasks.delete(id);
    // No matching dispatch or errored task: never count as completed.
    if (!pending || pending.key !== workflow.phase || event.isError) return;
    const outputs = (event.content ?? []).filter((x: any)=>x?.type==='text' && typeof x.text==='string' && x.text.trim()).map((x: any)=>x.text);
    // Empty successful tool results are not meaningful completed agent reports.
    if (!outputs.length && !event.details) return;
    for (const agent of pending.agents) {
      if ((workflow.gateAgentsSpawned?.[workflow.phase] ?? []).includes(agent)) {
        markAgent(agent, ctx);
        workflow = { ...workflow, agentCompletions: [...(workflow.agentCompletions ?? []),
          { gate: pending.key, agent, resultId: id, reportedAt: new Date().toISOString(),
            resultPreview: outputs.join('\n').slice(0,800) || '[structured tool result]',
            reportedSeverities: countReportedSeverities(outputs.join('\n')) }] };
        saveState();
      }
    }
    // Ask for the requirement summary in the SAME model turn; no extra user chat
    // message, /forge command, or review form answer is needed.
    const instruction = requestRequirementSummary(ctx);
    return instruction ? { additionalContext: instruction } : undefined;
  });

  pi.on('tool_call', async (event, ctx) => {
    // Forge subagents run with independent sessions. Their Git tool calls must be
    // guarded too; checking main only leaves executor and QA child agents exposed.
    const childName = String(ctx.agent?.name ?? '');
    const isForgeChild = ctx.agent?.kind === 'sub' && (guardedAgentNames.has(childName) || listAssignedAgentNames(workflow?.agentAssignments).includes(childName));
    const tool = String(event.toolName ?? '');
    if (ctx.agent?.kind === 'main') promoteFromNativeApprovalEntry(ctx);
    if (!workflow && !isForgeChild) {
      // An orphaned workflow is known for this session (e.g. OMP switched
      // branch after approval). Never fail open: keep the Git guard, and pause
      // edits/shell/subagents until the human recovers or declines.
      if (!pendingCheckpointRecovery || ctx.agent?.kind === 'sub') return;
      const orphanInput = event.input ?? {};
      if (['bash', 'shell', 'terminal', 'exec', 'run', 'python'].includes(tool) &&
          isProhibitedGitCommand(String(orphanInput.command ?? orphanInput.cmd ?? orphanInput.code ?? orphanInput.script ?? ''))) {
        return { block: true, reason: 'Forge policy: Git writes must be manual. No agent git add/commit/push/tag/merge/rebase.' };
      }
      if (/(?:github|gitlab|bitbucket)/i.test(tool) && /(?:commit|push|merge|create[_-]?pull|update[_-]?file|create[_-]?file|delete[_-]?file|release|tag)/i.test(tool)) {
        return { block: true, reason: 'Forge does not allow agent-controlled repository publishing or commits.' };
      }
      if (declinedRecovery.has(orphanKey(pendingCheckpointRecovery)) || READ_ONLY_TOOLS.includes(tool)) return;
      scheduleStateRecoveryPopup(ctx);
      return { block: true, reason: `A Forge workflow (${pendingCheckpointRecovery.state.phase}) exists in this session but not on the current OMP branch. Edits are paused. Ask the user to run /forge recover (recover or keep this branch inactive) or /forge off. Do not continue implementation.` };
    }
    if (tool === 'task' && ctx.agent?.kind === 'main' && workflow?.active) {
      const id = String(event.toolCallId ?? event.id ?? '');
      // Keep task-agent tracking in sync with the input that will actually be executed.
      // An OMP tool_call hook can replace task arguments before native task dispatch.
      if (id) runningTasks.set(id, { key: workflow.phase, agents: taskAgents(event.input) });
      let skillBrief = '';
      try { skillBrief = skillBriefForGate(); }
      catch (err) { if (id) runningTasks.delete(id); return { block: true, reason: `Forge gate skill verification failed: ${String(err)}` }; }
      if (skillBrief) {
        const rewritten = injectGateSkillsIntoTask(event.input, workflow.phase, skillBrief);
        if (!rewritten) { if (id) runningTasks.delete(id); return { block: true, reason: 'Forge gate skills require task text on every subagent. Stepped tasks without task text cannot receive required skill instructions.' }; }
        return { input: rewritten };
      }
    }
    const input = event.input ?? {};
    const stateConflict = recoveryProposal(workflow, 'unknown');
    if (stateConflict?.category === 'safety' && !READ_ONLY_TOOLS.includes(tool)) {
      scheduleStateRecoveryPopup(ctx);
      return { block:true, reason:`Forge state conflict: ${stateConflict.explanation} Run /forge recover and confirm the safe state before executing tools.` };
    }

    // Apply the Git-write guard across ALL Forge phases, even after delivery.
    // It prevents agent-issued tool calls but is not a security boundary for nested scripts/MCP.
    if (['bash', 'shell', 'terminal', 'exec', 'run', 'python'].includes(tool)) {
      const code = String(input.command ?? input.cmd ?? input.code ?? input.script ?? '');
      if (isProhibitedGitCommand(code)) return { block: true, reason: 'Forge policy: Git writes must be manual. No agent git add/commit/push/tag/merge/rebase.' };
    }
    if (/(?:github|gitlab|bitbucket)/i.test(tool) && /(?:commit|push|merge|create[_-]?pull|update[_-]?file|create[_-]?file|delete[_-]?file|release|tag)/i.test(tool)) {
      return { block: true, reason: 'Forge does not allow agent-controlled repository publishing or commits.' };
    }
    if (['write', 'edit', 'apply_patch'].includes(tool)) {
      const target = String(input.path ?? input.file_path ?? input.filePath ?? input.target ?? '');
      if (/(?:^|\/)\.git(?:\/|$)/.test(target)) return { block: true, reason: 'Forge forbids direct writes to .git internals.' };
    }
    if (isForgeChild) {
      if (childName !== configuredAgents.execution.executor && ['write','edit','apply_patch','bash','shell','terminal','exec','run','python'].includes(tool)) {
        return { block: true, reason: 'Forge specialist is read-only. Only executor may edit approved code; no Git writes.' };
      }
      return;
    }
    if (!workflow?.active) return;
    if (workflow.phase === 'DELIVERY_PREP') {
      if (['write', 'edit', 'apply_patch', 'python'].includes(tool)) {
        return { block: true, reason: 'Forge delivery is read-only. Use forge_delivery_submit for the commit-message artifact.' };
      }
      if (['bash', 'shell', 'terminal', 'exec', 'run'].includes(tool)) {
        const cmd = String(input.command ?? input.cmd ?? '');
        if (!isAllowedQaCommand(cmd)) return { block: true, reason: 'Forge delivery allows only conservative read-only Git/test commands.' };
      }
      return;
    }
    if (['QA_REVIEW', 'QA_EVIDENCE_PENDING'].includes(workflow.phase)) {
      if (['write', 'edit', 'apply_patch', 'python'].includes(tool)) {
        return { block: true, reason: 'Forge post-execution QA is read-only. Report findings; do not modify implementation.' };
      }
      if (['bash', 'shell', 'terminal', 'exec', 'run'].includes(tool)) {
        const cmd = String(input.command ?? input.cmd ?? '');
        if (!isAllowedQaCommand(cmd)) return { block: true, reason: 'Forge QA only permits conservative test/lint/read commands. Record NOT_RUN if unavailable.' };
      }
      return;
    }
    if (['EXECUTING', 'QA_PASSED', 'QA_FAILED'].includes(workflow.phase)) return;

    // Phase-based permissions, NOT an all-tools Plan Mode precondition.
    // Read, grep, glob, task, and ask must work even when OMP's Plan Mode
    // temporarily becomes inactive or paused. This fixes the Discovery deadlock.
    const preApproval = ['REQUIREMENT','PLAN_MODE_PENDING','PLANNING',
      'PROPOSAL','AWAITING_APPROVAL','REWORK_PLANNING'].includes(workflow.phase);
    if (!preApproval) return;

    if (['read', 'grep', 'glob', 'ls', 'task', 'ask'].includes(tool)) return;
    // Control-plane only: records the requirement synthesis in Forge state.
    if (tool === 'forge_requirement_summary' && workflow.phase === 'REQUIREMENT') return;

    if (['write', 'edit', 'apply_patch'].includes(tool)) {
      // xd://propose is a CONTROL-PLANE operation, not a repository write.
      // Native OMP validates the slug, presence of the real local:// plan, and
      // active Plan Mode before it opens the human review. Do not require
      // Forge's planWritten flag: it can be stale when write result telemetry
      // is missing, causing an endless blocked-proposal loop.
      // No other xd:// targets are allowed before approval.
      const target = String(input.path ?? input.file_path ?? input.filePath ?? input.target ?? input.url ?? '');
      if (tool === 'write' && target === 'xd://propose' &&
          ['PLANNING', 'PROPOSAL','REWORK_PLANNING'].includes(workflow.phase)) {
        const slug = typeof input.content === 'string' ? input.content.trim() : '';
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(slug) || slug.endsWith('-plan.md')) {
          return { block: true, reason: 'Forge plan proposal requires the bare plan slug (e.g. forge-abc123), not a path or full plan text.' };
        }
        if (workflow.planPath && slug !== workflow.planPath.replace(/^local:\/\//, '').replace(/-plan\.md$/, '')) {
          return { block: true, reason: `Forge requires the CURRENT canonical plan slug ${workflow.planPath}. Do not propose an old or unrelated plan.` };
        }
        if (workflow.phase === 'REWORK_PLANNING' && !workflow.planWritten) {
          return { block: true, reason: `Forge rework must first save a NEW reviewed version to ${workflow.planPath ?? `local://${workflow.slug}-plan.md`} and finish forge-planner. Do not propose the previously approved plan.` };
        }
        if (ctx.sessionModes?.getState?.().plan !== 'active') {
          workflow = { ...workflow, proposalDeferred: true };
          saveState(); updateDashboard(ctx);
          deferNativePlanUntilIdle(ctx, 'review');
          return { block: true, reason: 'Native Plan Mode is temporarily paused. Forge will enter it and open review automatically once the current turn is idle. Do NOT retry xd://propose or ask the user to advance a gate.' };
        }
        return;
      }
      // During Planning only OMP virtual local:// *-plan.md artifacts are
      // writable. Never require ctx.sessionModes.getState().plan === 'active'
      // here: the mode may be paused during tool execution; the workflow
      // stage and the path are the actual Forge authorization criteria.
      if (tool === 'write' && ['PLANNING','REWORK_PLANNING'].includes(workflow.phase) && isPlanWritePath(target)) {
        if (workflow.phase === 'REWORK_PLANNING' && ctx.sessionModes?.getState?.().plan !== 'active') {
          deferNativePlanUntilIdle(ctx, 'rework');
          return { block: true, reason: 'Native Plan Mode must be active for rework plan writes. Forge will restore it when the turn is idle; do not retry tools in a loop.' };
        }
        const id = String(event.toolCallId ?? event.id ?? '');
        if (id) planWriteCalls.set(id, { path: target, phase: workflow.phase });
        return;
      }
      if (tool === 'write' && workflow.phase === 'PROPOSAL' && workflow.planWritten &&
          target === workflow.planPath && isSandboxPlanPath(target)) return;
      if (tool === 'write' && workflow.phase === 'AWAITING_APPROVAL' && workflow.planWritten &&
          target === workflow.planPath && isSandboxPlanPath(target)) return;
      const pending = workflow.phase === 'REQUIREMENT' ? ` Finish the requirement analysis: ${missingGateAgentsFor(workflow).join(', ') || 'call forge_requirement_summary'}. The harness advances automatically; do NOT ask the user to send a next-gate message.` : '';
      const planHint = ['PLANNING','REWORK_PLANNING'].includes(workflow.phase) && tool === 'write'
        ? ` Only a root-level local://*-plan.md file is allowed; received ${JSON.stringify(target)}.` : '';
      return { block: true, reason: `Forge ${workflow.phase} is read-only: implementation writes require explicit native Plan Approval.${planHint}${pending}` };
    }

    if (['bash', 'shell', 'terminal', 'exec', 'run'].includes(tool)) {
      const command = String(input.command ?? input.cmd ?? '');
      // OMP's `propose <slug>` CLI is a native plan-review control-plane call,
      // not a shell command. Permit only the already-written canonical plan in
      // PROPOSAL; OMP still owns validation and human approval.
      const proposal = command.match(/^propose\s+([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/);
      const canonicalSlug = workflow.planPath?.replace(/^local:\/\//, '').replace(/-plan\.md$/, '');
      if (workflow.phase === 'PROPOSAL' && workflow.planWritten &&
          proposal?.[1] === canonicalSlug) return;
      if (isAllowedDiscoveryCommand(command)) return;
      return { block: true, reason: `Forge ${workflow.phase} permits only safe read-only inspection commands before Approval.` };
    }
    if (tool === 'python') return { block: true, reason: 'Python execution is not approved during Forge Discovery/Planning.' };

    // Unknown tools may write to the filesystem or external services. Fail
    // closed until an explicit audited read-only capability is added.
    return { block: true, reason: `Forge ${workflow.phase}: unknown tool ${tool} cannot run before native Approval. Use read/grep/glob/task/ask.` };

  });
}

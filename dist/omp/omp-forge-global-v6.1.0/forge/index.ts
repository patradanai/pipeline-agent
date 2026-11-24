import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { discoverForgeSessions, forgeSessionLabel, resolvePickerSessions, sameResumeCheckpoint } from './session-resume.mjs';
import { recoveryProposal, applyRecoveryProposal } from './state-recovery.mjs';
import { snapshotWorkingTree as coreSnapshotWorkingTree, inspectWorkspaceScope } from './workspace.mjs';
import { hasGateAgents, markGateAgent, approvedExecutionState, qaReportTransition, assertQaSubmittable, assertDeliverySubmittable, assertPlanProposable, deliveryTransition, approveReworkTransition, steeringRoute, steerTransition } from './transitions.mjs';
import { sessionIdentity, recoveryIdentity, persistForgeCheckpoint, loadForgeCheckpointCandidates, loadForgeCheckpointRecord, pruneForgeCheckpoints, candidateFromSessionEntries, prepareHumanRecovery, isValidRestoreCandidate } from './checkpoint-recovery.mjs';
import { normalizeForgeState } from './forge-state.mjs';
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
  currentSkillGate, injectGateSkillsIntoTask, cloneGateModels, formatGateModels,
  DEFAULT_AGENT_ASSIGNMENTS,
  cloneAgentAssignments,
  listAssignedAgentNames,
  formatAgentAssignments,
  requiredAgentsFor,
  missingGateAgentsFor,
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
  parseCommand,
  phaseInstruction,
  planDecisionReminder,
  qaInstruction,
  steeringInstruction,
  renderDeliveryReport,
  renderQaReport,
  renderForgeWidget,
  getForgeArgumentCompletions,
  renderQaSummary,
  extractHighFindings,
  forgePlanPath,
} from './core.mjs';

/**
 * Global OMP Forge Harness v6.1 — OMP adapter over the shared Forge core.
 *
 * Forge plan mode -> Forge approval dialog -> execution -> independent QA ->
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
  let configuredGateModels: Record<string, string | null> = cloneGateModels();
  // `${slug}:${gate}` already handled; the gate model switches once per gate entry.
  let appliedGateKey: string | null = null;
  let guardedAgentNames = new Set(listAssignedAgentNames(configuredAgents));
  const reportRoot = process.env.FORGE_REPORT_DIR || resolve(extensionDir, '../..', 'forge-reports');
  let workflow: any = null;
  let pendingCheckpointRecovery: any = null;
  let currentSessionIdentity: any = null;
  let activeSessionManager: any = null;
  const checkpointRoot = process.env.FORGE_CHECKPOINT_DIR || join(agentRoot, 'forge-checkpoints');
  const attachmentRoot = join(agentRoot, 'forge-attachments');
  let autoStart = false;
  let planReview = false;
  type GateContext = {
    sessionManager?: { getSessionId?: () => string | undefined; getSessionFile?: () => string | undefined };
  };
  type GateSnapshot = {
    epoch: number; sessionId: string | undefined; sessionFile: string | undefined;
    slug: string; phase: string; approved: boolean; planHash: string | null;
    qaStatus: string | null; reworkCycles: number; steeringRevision: number;
  };
  let gateEpoch = 0;
  const runningTasks = new Map<string, { scope: GateSnapshot; agents: string[] }>();
  function invalidateGateWork() {
    gateEpoch++;
    runningTasks.clear();
  }
  function gateSnapshot(ctx: GateContext): GateSnapshot | null {
    if (!workflow?.active) return null;
    return {
      epoch: gateEpoch, sessionId: ctx.sessionManager?.getSessionId?.(), sessionFile: ctx.sessionManager?.getSessionFile?.(),
      slug: workflow.slug, phase: workflow.phase, approved: workflow.approved === true, planHash: workflow.approvedPlanHash ?? null,
      qaStatus: workflow.qaStatus ?? null, reworkCycles: workflow.reworkCycles ?? 0, steeringRevision: workflow.steeringRevision ?? 0,
    };
  }
  function isCurrentGate(snapshot: GateSnapshot | null, ctx: GateContext): boolean {
    return snapshot !== null && workflow?.active === true &&
      snapshot.epoch === gateEpoch && snapshot.sessionId === ctx.sessionManager?.getSessionId?.() &&
      snapshot.sessionFile === ctx.sessionManager?.getSessionFile?.() &&
      snapshot.slug === workflow.slug && snapshot.phase === workflow.phase && snapshot.approved === (workflow.approved === true) &&
      snapshot.planHash === (workflow.approvedPlanHash ?? null) && snapshot.qaStatus === (workflow.qaStatus ?? null) &&
      snapshot.reworkCycles === (workflow.reworkCycles ?? 0) && snapshot.steeringRevision === (workflow.steeringRevision ?? 0);
  }
  // Forge's own plan review opens once the proposing turn is idle. The epoch
  // invalidates a scheduled review after a session/branch change or cancel.
  // This is control-plane only; it never authorizes code writes.
  let reviewScheduled = false;
  let reviewEpoch = 0;
  let reviewOpen = false;
  let recoveryPopupScheduled = false;
  let recoveryPopupEpoch = 0;
  const skippedRecovery = new Set<string>();
  // Recovery offers the human explicitly declined ("keep this branch inactive").
  // Mutating tools are blocked while an orphaned workflow is UNRESOLVED; a
  // decline releases that block but keeps the Git-write guard.
  const declinedRecovery = new Set<string>();
  let checkpointsPruned = false;
  const READ_ONLY_TOOLS = ['read', 'grep', 'glob', 'ls', 'ask'];
  // Read-only research agents the main agent may spawn while planning or reviewing.
  const RESEARCH_AGENTS = ['scout'];
  const orphanKey = (c: any) => c ? `missing-branch:${c.identity.fingerprint}:${c.state.slug}:${c.state.phase}` : '';

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
    planReview = cfg.planReview === true;
    try { configuredSkills = cloneGateSkills(cfg.gateSkills); }
    catch { configuredSkills = cloneGateSkills(); }
    try { configuredGateModels = cloneGateModels(cfg.gateModels); }
    catch { configuredGateModels = cloneGateModels(); }
    guardedAgentNames = new Set([
      ...listAssignedAgentNames(DEFAULT_AGENT_ASSIGNMENTS),
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
    const gate = currentSkillGate(workflow?.phase, workflow?.qaStatus);
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
    notify(ctx, `Forge uses the installed OMP agents (read-only mapping):\n${list}\nConfigure models/prompts and enable agents with OMP /agents. Forge does not override subagent models; main-session model per gate: /forge model.`);
  }

  function saveState(cancelledSlug?: string) {
    // OMP's active branch remains authoritative; a separate checkpoint is only
    // a human-confirmed recovery hint when a later branch hides this entry.
    const tombstone = { active: false, version: 9, ...(cancelledSlug ? { cancelledSlug } : {}) };
    pi.appendEntry(stateEntry, workflow ?? tombstone);
    if (!currentSessionIdentity && activeSessionManager) currentSessionIdentity = sessionIdentity(activeSessionManager, workspaceDir);
    if (currentSessionIdentity) {
      try { persistForgeCheckpoint(checkpointRoot, currentSessionIdentity, workflow ?? tombstone); }
      catch { /* Branch state remains valid even if the mirror is unavailable. */ }
    }
  }

  /** Returns true when the active branch contains ANY Forge entry (including
   * a tombstone); such a branch is authoritative and never auto-recovered. */
  function restoreState(ctx: any): boolean {
    invalidateGateWork();
    const identity = sessionIdentity(ctx.sessionManager, ctx.cwd || workspaceDir);
    activeSessionManager = ctx.sessionManager;
    currentSessionIdentity = identity;
    pendingCheckpointRecovery = null;
    // Preserve completed report metadata, but never import a different branch's
    // approval into the active branch without human review.
    workflow = null;
    appliedGateKey = null;
    let sawBranchForgeEntry = false;
    for (const entry of ctx.sessionManager?.getBranch?.() ?? []) {
      if (entry.type === 'custom' && entry.customType === stateEntry) {
        sawBranchForgeEntry = true;
        const data = entry.data;
        workflow = data && typeof data.phase === 'string' ? normalizeForgeState(data) : null;
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
    notify(ctx, `Recovered ${chosen.state.phase} as ${workflow.phase} in the CURRENT branch. Prior execution permission was not transferred. ${chosen.state.approved ? 'A fresh Forge plan approval is mandatory.' : 'No approval was inferred.'} Use /forge resume to continue.`, 'warning');
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
    const status = lines?.[0]?.replace(/\s+/g, ' ').trim();
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
    if (!workflow?.approved || workflow.phase !== 'QA') {
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
    // The human-first summary table: shown to the user (not fed back to the model) and kept for /forge review.
    const qaSummary = renderQaSummary(report, { reportPath: mdPath });
    workflow = { ...qaReportTransition(workflow, report, { reportPath: mdPath, workingTree }), qaSummary };
    saveState();
    updateDashboard(ctx);
    if (failed) notify(ctx, `Forge QA FAIL. Forge asks whether to plan a fix when this turn ends; nothing changes before you decide. Report: ${mdPath}`, 'warning');
    else if (evidencePending) notify(ctx, `Forge QA BLOCKED: evidence is incomplete, not an observed code failure. Approved plan retained; Forge asks how to continue when this turn ends. Report: ${mdPath}`, 'warning');
    else notify(ctx, 'Forge QA passed. Preparing DELIVERY and a copy-ready commit message; no Git changes will be performed.');
    pi.sendMessage({ customType: 'forge-qa-summary', content: qaSummary, display: true, excludeFromContext: true });
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

  const REVIEW_KEEP = 'Approve and keep context';
  const REVIEW_COMPACT = 'Approve and compact context';
  const REVIEW_REFINE = 'Refine plan';
  const REVIEW_LATER = 'Not now — keep plan for /forge review';
  const QA_PLAN_FIX = 'Plan the fix — draft a rework plan, then approve it';
  const QA_PLAN_FIX_NOTES = 'Plan the fix with my notes';
  const QA_RERUN = 'Rerun QA — I collected the missing evidence';
  const QA_LATER = 'Not now — keep the QA report (/forge review to decide later)';
  const PLAN_FILE_PATTERN = /^local:\/\/([A-Za-z0-9][A-Za-z0-9._-]{0,127}-plan\.md)$/;
  const MAX_PLAN_BYTES = 512 * 1024;

  /** Forge plan files live in OMP's session-local root (<session file minus .jsonl>/local/),
   * never in the checked-out repository. Only a root-level *-plan.md regular file is read. */
  function readPlanFile(ctx: any, planPath: string): { ok: true; content: string } | { ok: false; error: string } {
    const name = typeof planPath === 'string' ? planPath.match(PLAN_FILE_PATTERN)?.[1] : undefined;
    if (!name) return { ok: false, error: `Invalid Forge plan path "${planPath}".` };
    const sessionFile = ctx.sessionManager?.getSessionFile?.();
    if (typeof sessionFile !== 'string' || !sessionFile.endsWith('.jsonl')) {
      return { ok: false, error: 'This OMP session has no session file, so local:// plan files are unavailable.' };
    }
    const file = join(sessionFile.slice(0, -6), 'local', name);
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) return { ok: false, error: `${planPath} is not a regular file.` };
      if (stat.size === 0) return { ok: false, error: `${planPath} is empty.` };
      if (stat.size > MAX_PLAN_BYTES) return { ok: false, error: `${planPath} is larger than 512 KiB.` };
      return { ok: true, content: readFileSync(file, 'utf8') };
    } catch {
      return { ok: false, error: `${planPath} does not exist yet.` };
    }
  }

  /** Paths a write/edit call targets: explicit path fields, or hashline `[PATH#TAG]` headers in `input.input`. */
  function editTargets(input: unknown): string[] {
    const fields = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const direct = fields.path ?? fields.file_path ?? fields.filePath ?? fields.target ?? fields.url;
    if (typeof direct === 'string' && direct) return [direct];
    const text = typeof fields.input === 'string' ? fields.input : '';
    return [...text.matchAll(/^\[([^\]\n#]+)#[0-9A-Fa-f]{4}\]\s*$/gm)].map(m => m[1].trim());
  }

  /** Forge runs its own plan mode; native OMP Plan Mode would block approved
   * implementation writes. "exit" leaves it without approving or deleting a draft. */
  async function exitNativePlanMode(ctx: any): Promise<boolean> {
    // OMP reports each session mode as `{ status: 'inactive' | 'active' | 'paused' }`.
    const status = ctx.sessionModes?.getState?.().plan?.status;
    if (!status || status === 'inactive') return true;
    try {
      const result = await ctx.sessionModes.set({ mode: 'plan', action: 'exit' });
      return result?.ok === true;
    } catch {
      return false;
    }
  }

  /** Switch the main session to the configured model once per gate entry,
   * keeping the thinking level. A manual /model pick inside a gate is kept. */
  async function syncGateModel(ctx: any): Promise<void> {
    if (ctx?.agent?.kind !== 'main' || !workflow?.active) return;
    if (typeof pi.setModel !== 'function' || typeof ctx.models?.resolve !== 'function') return;
    const gate = currentSkillGate(workflow.phase, workflow.qaStatus);
    if (!gate) return;
    const key = `${workflow.slug}:${gate}`;
    if (appliedGateKey === key) return;
    const selector = configuredGateModels[gate];
    if (selector == null) { appliedGateKey = key; return; }
    const model = ctx.models.resolve(selector);
    if (!model) {
      appliedGateKey = key;
      notify(ctx, `Forge ${gate}: model "${selector}" is not available; keeping the current model. Change it with /forge model ${gate} <selector>.`, 'warning');
      return;
    }
    const current = ctx.models.current?.();
    if (current?.provider === model.provider && current?.id === model.id) { appliedGateKey = key; return; }
    const level = pi.getThinkingLevel?.();
    try {
      const ok = await pi.setModel(model);
      if (ok === false) {
        appliedGateKey = key;
        notify(ctx, `Forge ${gate}: no credentials for ${model.provider}/${model.id}; keeping the current model.`, 'warning');
        return;
      }
    } catch (err) {
      // Key stays unset so the next sync point retries.
      notify(ctx, `Forge ${gate}: could not switch to ${model.provider}/${model.id}: ${String(err)}`, 'warning');
      return;
    }
    if (level !== undefined) pi.setThinkingLevel?.(level);
    appliedGateKey = key;
    notify(ctx, `Forge ${gate}: model ${model.provider}/${model.id}`);
  }

  /** The proposed plan can no longer be reviewed: return to an unproposed PLAN gate. */
  function resetProposal(ctx: any, reason: string) {
    workflow = { ...workflow, planWritten: false, planValid: false, approvedPlanHash: null, reviewRequested: false };
    saveState(); updateDashboard(ctx);
    notify(ctx, reason, 'error');
    pi.sendUserMessage(`${reason}\n\n${phaseInstruction(workflow)}`, { attribution: 'agent' });
  }

  /** Open the approval dialog once the proposing turn has settled. */
  function scheduleReviewWhenIdle(ctx: any) {
    if (!workflow?.active || reviewScheduled) return;
    if (typeof ctx.setTimeout !== 'function' || typeof ctx.isIdle !== 'function') {
      notify(ctx, 'Forge cannot detect an idle session. Plan kept; run /forge review to open the approval dialog.', 'warning');
      return;
    }
    reviewScheduled = true;
    const epoch = ++reviewEpoch;
    const slug = workflow.slug;
    const hash = workflow.approvedPlanHash;
    const sessionId = ctx.sessionManager?.getSessionId?.();
    const release = () => { if (epoch === reviewEpoch) reviewScheduled = false; };
    const isCurrent = () => epoch === reviewEpoch && workflow?.active && workflow.phase === 'PLAN' &&
      workflow.slug === slug && workflow.approvedPlanHash === hash &&
      (!sessionId || ctx.sessionManager?.getSessionId?.() === sessionId);
    const tick = () => ctx.setTimeout(async () => {
      if (!isCurrent()) { release(); return; }
      if (!ctx.isIdle() || ctx.hasPendingMessages?.()) { tick(); return; }
      reviewScheduled = false;
      await openForgeReview(ctx);
    }, 250);
    tick();
  }

  // QA FAIL/BLOCKED waits for a human decision; the dialog opens once the QA turn is idle.
  let qaDecisionScheduled = false;
  let qaDecisionEpoch = 0;
  let qaDecisionOpen = false;
  function scheduleQaDecisionWhenIdle(ctx: any) {
    if (!workflow?.active || !workflow.reworkDecisionPending || qaDecisionScheduled) return;
    if (typeof ctx.setTimeout !== 'function' || typeof ctx.isIdle !== 'function') {
      notify(ctx, 'Forge cannot detect an idle session. QA report kept; run /forge review to decide how to continue.', 'warning');
      return;
    }
    qaDecisionScheduled = true;
    const epoch = ++qaDecisionEpoch;
    const slug = workflow.slug;
    const reportPath = workflow.qaReportPath;
    const release = () => { if (epoch === qaDecisionEpoch) qaDecisionScheduled = false; };
    const isCurrent = () => epoch === qaDecisionEpoch && workflow?.active && workflow.reworkDecisionPending === true &&
      workflow.slug === slug && workflow.qaReportPath === reportPath;
    const tick = () => ctx.setTimeout(async () => {
      if (!isCurrent()) { release(); return; }
      if (!ctx.isIdle() || ctx.hasPendingMessages?.()) { tick(); return; }
      qaDecisionScheduled = false;
      await openQaDecision(ctx);
    }, 250);
    tick();
  }

  /** Start a fresh QA round on the approved execution (the /forge qa command and the BLOCKED dialog). */
  async function startQaRound(ctx: any): Promise<boolean> {
    if (!workflow || workflow.approved !== true || workflow.planValid !== true || typeof workflow.approvedPlanHash !== 'string' || workflow.approvedPlanHash.length === 0 || !['EXECUTE', 'QA'].includes(workflow.phase)) {
      notify(ctx, 'No approved execution is available for QA.', 'warning');
      return false;
    }
    invalidateGateWork();
    qaDecisionEpoch++; qaDecisionScheduled = false;
    workflow = { ...workflow, active: true, phase: 'QA', qaStatus: null, qaRetries: 0, qaEvidencePending: false, reworkDecisionPending: false, workingTreeAtQa: null,
      deliveryPath: null, commitMessagePath: null, commitMessage: null, deliveryRetries: 0,
      gateAgents: { ...(workflow.gateAgents ?? {}), QA: [] }, gateAgentsSpawned: { ...(workflow.gateAgentsSpawned ?? {}), QA: [] } };
    saveState(); updateDashboard(ctx);
    await syncGateModel(ctx);
    pi.sendUserMessage(qaInstruction(workflow), { attribution: 'agent' });
    return true;
  }

  /** Forge's QA decision dialog: after FAIL/BLOCKED, only the human starts a fix plan (which needs plan approval again). */
  async function openQaDecision(ctx: any): Promise<boolean> {
    if (qaDecisionOpen) return false;
    if (!(workflow?.active && workflow.reworkDecisionPending === true)) {
      notify(ctx, 'No QA result awaits your decision.', 'warning');
      return false;
    }
    if (ctx.mode !== 'tui' || typeof ctx.ui?.select !== 'function') {
      notify(ctx, 'The Forge QA decision needs the interactive OMP TUI. Use /forge rework to plan a fix or /forge qa to rerun QA.', 'warning');
      return false;
    }
    qaDecisionOpen = true;
    try {
      const failed = workflow.qaStatus === 'FAIL';
      const snapshot = { slug: workflow.slug, reportPath: workflow.qaReportPath };
      const stale = () => !workflow?.active || workflow.reworkDecisionPending !== true ||
        workflow.slug !== snapshot.slug || workflow.qaReportPath !== snapshot.reportPath;
      const staleNotice = () => notify(ctx, 'Forge state changed while the QA decision was open. Nothing changed; run /forge review again.', 'warning');
      const choices = failed
        ? [QA_PLAN_FIX, ...(typeof ctx.ui.editor === 'function' ? [QA_PLAN_FIX_NOTES] : []), QA_LATER]
        : [QA_RERUN, QA_PLAN_FIX, ...(typeof ctx.ui.editor === 'function' ? [QA_PLAN_FIX_NOTES] : []), QA_LATER];
      const title = failed
        ? `Forge · QA FAILED — plan a fix? (report: ${workflow.qaReportPath ?? 'n/a'})`
        : `Forge · QA BLOCKED — evidence incomplete. How to continue? (report: ${workflow.qaReportPath ?? 'n/a'})`;
      for (;;) {
        const choice = await ctx.ui.select(title, choices);
        if (stale()) { staleNotice(); return false; }
        if (choice === QA_RERUN) return await startQaRound(ctx);
        if (choice === QA_PLAN_FIX || choice === QA_PLAN_FIX_NOTES) {
          let notes = '';
          if (choice === QA_PLAN_FIX_NOTES) {
            const feedback = await ctx.ui.editor('Forge · What should the fix plan address?', '');
            if (stale()) { staleNotice(); return false; }
            if (feedback == null || !String(feedback).trim()) continue;
            notes = String(feedback);
          }
          invalidateGateWork();
          workflow = approveReworkTransition(workflow, notes);
          saveState(); updateDashboard(ctx);
          notify(ctx, 'Forge: planning the fix. You approve the fix plan before any code changes.');
          await syncGateModel(ctx);
          pi.sendUserMessage(`[FORGE QA REWORK — APPROVED BY THE OPERATOR]\nThe operator chose to plan a fix for the QA ${failed ? 'failures' : 'gaps'}.\n\n${phaseInstruction(workflow)}`, { attribution: 'agent' });
          return true;
        }
        notify(ctx, `QA report kept; nothing changed. Run /forge review to decide, /forge rework to plan a fix${failed ? '' : ', /forge qa to rerun QA'}, or /forge off.`);
        return false;
      }
    } finally {
      qaDecisionOpen = false;
    }
  }

  /** Send the execution turn for an approved plan, optionally after compaction.
   * `send` is single-use, so compaction callbacks can never dispatch twice. */
  async function dispatchApprovedExecution(ctx: any, mode: 'keep' | 'compact', planContent: string) {
    const snapshot = gateSnapshot(ctx);
    const planPath = workflow?.planPath;
    const canDispatch = () => isCurrentGate(snapshot, ctx) && workflow.phase === 'EXECUTE' && workflow.approved === true && workflow.planValid === true;
    const exitedPlanMode = await exitNativePlanMode(ctx);
    if (!canDispatch()) return;
    if (!exitedPlanMode) {
      workflow = { ...workflow, active: false };
      saveState(); updateDashboard(ctx);
      notify(ctx, 'Plan approved, but native OMP Plan Mode is active and would block implementation writes. Exit it with /plan, then run /forge resume.', 'warning');
      return;
    }
    await syncGateModel(ctx);
    if (!canDispatch()) return;
    let sent = false;
    const send = () => {
      if (sent || !canDispatch()) return;
      sent = true;
      pi.sendUserMessage(`[FORGE PLAN APPROVED — ${planPath}]\nThe operator approved this plan in the Forge plan review. Execute it now.\n\n${planContent}`, { attribution: 'agent' });
    };
    if (mode === 'compact' && typeof ctx.compact === 'function') {
      const fallback = (err: unknown) => {
        if (sent || !canDispatch()) return;
        notify(ctx, `Compaction failed (${String(err)}); executing with the full context.`, 'warning');
        send();
      };
      void Promise.resolve(ctx.compact({ suppressContinuation: true, onComplete: send, onError: fallback })).catch(fallback);
      return;
    }
    if (mode === 'compact') notify(ctx, 'Compaction is unavailable here; executing with the full context.', 'warning');
    send();
  }

  /** Forge's own plan approval dialog. Only an explicit human choice approves. */
  async function openForgeReview(ctx: any): Promise<boolean> {
    if (reviewOpen) return false;
    if (!(workflow?.active && workflow.phase === 'PLAN' && workflow.planWritten && workflow.planValid &&
        workflow.approvedPlanHash && !workflow.approved)) {
      notify(ctx, 'No proposed Forge plan awaits review.', 'warning');
      return false;
    }
    if (ctx.mode !== 'tui' || typeof ctx.ui?.select !== 'function') {
      notify(ctx, 'Forge plan review needs the interactive OMP TUI.', 'warning');
      return false;
    }
    const file = readPlanFile(ctx, workflow.planPath);
    if (!file.ok) {
      resetProposal(ctx, `Forge cannot read ${workflow.planPath}: ${file.error} Write the plan again and call forge_plan_propose.`);
      return false;
    }
    const content = file.content;
    if (validatePlanContract(content).hash !== workflow.approvedPlanHash) {
      resetProposal(ctx, `Plan ${workflow.planPath} changed after it was proposed. Call forge_plan_propose again.`);
      return false;
    }
    reviewOpen = true;
    try {
      workflow = { ...workflow, reviewRequested: false };
      saveState(); updateDashboard(ctx);
      pi.sendMessage({ customType: 'forge-plan-review', content: `Forge plan review · ${workflow.planPath}\n\n${content}`, display: true, excludeFromContext: true });
      const choices = [REVIEW_KEEP, REVIEW_COMPACT, ...(typeof ctx.ui.editor === 'function' ? [REVIEW_REFINE] : []), REVIEW_LATER];
      const snapshot = { slug: workflow.slug, hash: workflow.approvedPlanHash };
      const stale = () => !workflow?.active || workflow.phase !== 'PLAN' || workflow.approved ||
        workflow.slug !== snapshot.slug || workflow.approvedPlanHash !== snapshot.hash;
      const staleNotice = () => notify(ctx, 'Forge state changed while the review was open. Nothing was approved; run /forge review again.', 'warning');
      for (;;) {
        const choice = await ctx.ui.select(`Forge · Approve plan ${workflow.planPath}?`, choices);
        if (stale()) { staleNotice(); return false; }
        if (choice === REVIEW_KEEP || choice === REVIEW_COMPACT) {
          const mode = choice === REVIEW_COMPACT ? 'compact' : 'keep';
          workflow = { ...approvedExecutionState(workflow, `forge-plan-review:${mode}`, 'forge-plan-review'), reviewRequested: false };
          saveState(); updateDashboard(ctx);
          notify(ctx, 'Forge approved. Execution starts now; QA runs automatically afterward.');
          await dispatchApprovedExecution(ctx, mode, content);
          return true;
        }
        if (choice === REVIEW_REFINE) {
          const feedback = await ctx.ui.editor('Forge · What should change in the plan?', '');
          if (stale()) { staleNotice(); return false; }
          if (feedback == null || !String(feedback).trim()) continue;
          invalidateGateWork();
          workflow = { ...workflow, approved: false, planWritten: false, planValid: false, approvedPlanHash: null,
            reviewRequested: false, proposalRetries: 0, businessTopics: [], requirements: [], testCases: [], qualityGates: [],
            gateAgents: { ...(workflow.gateAgents ?? {}), PLAN: [] }, agentRetries: { ...(workflow.agentRetries ?? {}), PLAN: 0 } };
          saveState(); updateDashboard(ctx);
          pi.sendUserMessage(`[FORGE PLAN REFINE]\nThe operator requested changes to ${workflow.planPath}:\n${String(feedback).trim()}\n\n${phaseInstruction(workflow)}`, { attribution: 'agent' });
          return false;
        }
        notify(ctx, 'Plan kept for review; nothing was approved. Run /forge review when ready.');
        return false;
      }
    } finally {
      reviewOpen = false;
    }
  }

  function recoveryKey(ctx: any, suggestion: any) {
    return `${ctx.sessionManager?.getSessionId?.() ?? 'session'}:${workflow?.slug ?? 'none'}:${workflow?.phase ?? 'none'}:${suggestion.key}:${workflow?.planPath ?? ''}:${workflow?.approvedPlanHash ?? ''}`;
  }

  // The dialog is advisory until the user explicitly accepts. No model or
  // session event can silently promote a workflow into Execution or Delivery.
  async function showStateRecovery(ctx: any, force = false): Promise<boolean> {
    if (ctx.agent?.kind !== 'main' || ctx.mode !== 'tui' || typeof ctx.ui?.select !== 'function') return false;
    if (!workflow && pendingCheckpointRecovery) return await showMissingBranchRecovery(ctx, force);
    const suggestion = recoveryProposal(workflow);
    if (!suggestion) {
      if (force) notify(ctx, 'Forge checkpoint has no detectable contradiction. No state change needed.');
      return false;
    }
    const key = recoveryKey(ctx, suggestion);
    if (!force && skippedRecovery.has(key)) return false;
    const stateAtPrompt = workflow;
    const options = [
      `Switch: ${suggestion.current} → ${suggestion.target}`,
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
    try {
      workflow = applyRecoveryProposal(workflow, suggestion);
      saveState(); updateDashboard(ctx);
      notify(ctx, `Forge state switched to ${workflow.phase} after your confirmation. ${suggestion.explanation} No approval or QA PASS was granted.`);
      return true;
    } catch (err) {
      notify(ctx, `Forge recovery refused: ${String(err)}`, 'error');
      return false;
    }
  }

  function scheduleStateRecoveryPopup(ctx: any) {
    if (recoveryPopupScheduled || ctx.agent?.kind !== 'main' || ctx.mode !== 'tui') return;
    const current = recoveryProposal(workflow);
    const pendingKey = workflow ? '' : orphanKey(pendingCheckpointRecovery);
    if (!current && !pendingKey) return;
    if (current && skippedRecovery.has(recoveryKey(ctx, current))) return;
    if (!current && skippedRecovery.has(pendingKey)) return;
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

  type PastedImage = { type: 'image'; data: string; mimeType?: string };
  function isPastedImage(value: unknown): value is PastedImage {
    if (!value || typeof value !== 'object') return false;
    const img = value as Record<string, unknown>; // plain object checked above
    return img.type === 'image' && typeof img.data === 'string' && img.data.length > 0;
  }

  function saveRequirementImages(slug: string, images: unknown[], prefix = 'image'): string[] {
    const valid = images.filter(isPastedImage);
    if (!valid.length) return [];
    const dir = join(attachmentRoot, slug);
    mkdirSync(dir, { recursive: true });
    return valid.map((img, index) => {
      const ext = String(img.mimeType ?? '').split('/')[1]?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'img';
      const file = join(dir, `${prefix}-${index + 1}.${ext}`);
      writeFileSync(file, Buffer.from(img.data, 'base64'));
      return file;
    });
  }

  async function begin(requirement: string, ctx: any, useInputReplacement = false, images: unknown[] = []) {
    if (workflow?.active) {
      notify(ctx, 'A Forge workflow is active. Type a prompt to steer it, or use /forge off.', 'warning');
      return null;
    }
    if (!requirement.trim()) return null;
    workspaceDir = ctx.cwd || workspaceDir;
    activeSessionManager = ctx.sessionManager;
    currentSessionIdentity = sessionIdentity(ctx.sessionManager, workspaceDir);
    if (ctx.agent?.kind !== 'main' || ctx.mode !== 'tui') {
      notify(ctx, 'Forge requires the interactive OMP TUI for its plan approval dialog.', 'warning');
      return null;
    }
    if (!(await exitNativePlanMode(ctx))) {
      notify(ctx, 'Forge runs its own plan mode, but native OMP Plan Mode is active and could not be exited. Exit it with /plan, then start Forge again.', 'warning');
      return null;
    }
    let skillPins;
    try { skillPins = snapshotSkillPins(configuredSkills); }
    catch (err) { notify(ctx, `Forge cannot start: ${String(err)}`, 'error'); return null; }
    const available = new Set(listInstalledAgents());
    const missing = listAssignedAgentNames(configuredAgents).filter(name => !available.has(name));
    if (missing.length) {
      notify(ctx, `Forge cannot start: missing required OMP agent definitions: ${missing.join(', ')}. Check /agents or reinstall the Forge agent files.`, 'error');
      return null;
    }
    let next = initialState(requirement, undefined, configuredAgents, configuredSkills, skillPins, { planReview });
    if (images.length) {
      let paths: string[];
      try { paths = saveRequirementImages(next.slug, images); }
      catch (err) { notify(ctx, `Forge cannot start: could not save pasted images: ${String(err)}`, 'error'); return null; }
      if (paths.length) next = { ...next, requirement: `${next.requirement}\n\nAttached images (pasted with this requirement; open each with the read tool):\n${paths.map((p, i) => `- [Image #${i + 1}] ${p}`).join('\n')}` };
    }
    invalidateGateWork();
    workflow = next;
    pendingCheckpointRecovery = null; reviewEpoch++; reviewScheduled = false;
    saveState();
    updateDashboard(ctx);
    notify(ctx, 'Forge: PLAN (Forge plan mode: you explore, plan and propose) → Approval → Execute → QA → Delivery');
    await syncGateModel(ctx);
    const instruction = phaseInstruction(workflow);
    if (!useInputReplacement) pi.sendUserMessage(instruction, { attribution: 'agent' });
    return instruction;
  }

  const promptPreview = (text: string) => {
    const flat = text.replace(/\s+/g, ' ');
    return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat || '(images only)';
  };

  /** A prompt the user types while the workflow runs steers it: it is recorded as a
   * requirement amendment and the workflow re-enters the gate that must absorb it. */
  function steer(text: string, images: unknown[], ctx: unknown): string | null {
    const from = workflow.phase;
    const revoked = workflow.approved === true;
    let paths: string[];
    try { paths = saveRequirementImages(workflow.slug, images, `steering-${(workflow.steeringRevision ?? 0) + 1}-image`); }
    catch (err) { notify(ctx, `Forge steering not applied: could not save pasted images: ${String(err)}`, 'error'); return null; }
    const directive = [text, paths.length ? `Attached images (pasted with this prompt; open each with the read tool):\n${paths.map((p, i) => `- [Image #${i + 1}] ${p}`).join('\n')}` : '']
      .filter(Boolean).join('\n\n');
    try { workflow = steerTransition(workflow, directive); }
    catch (err) { notify(ctx, `Forge steering not applied: ${err instanceof Error ? err.message : String(err)}`, 'warning'); return null; }
    invalidateGateWork();
    reviewEpoch++; reviewScheduled = false;
    saveState(); updateDashboard(ctx);
    notify(ctx, `Forge steering #${workflow.steeringRevision} · ${from} → ${workflow.phase}${revoked ? ' · approval revoked, the revised plan needs new approval' : ''} · prompt "${promptPreview(text)}" from user`, revoked ? 'warning' : 'info');
    return steeringInstruction(workflow, { from, revoked });
  }

  readConfig();

  const z = pi.zod;
  const qaStatus = z.enum(['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN']);
  const severity = z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
  pi.registerTool({
    name: 'forge_plan_propose',
    label: 'Propose Forge Plan for Approval',
    description: 'Forge plan mode: submit the Forge plan file for human approval. Write the complete plan to the local:// path named in the PLAN gate first. Forge validates the plan contract and opens its approval dialog after this turn ends. Changes no project files.',
    loadMode: 'essential',
    approval: 'read',
    parameters: z.object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const fail = (text: string) => ({ content: [{ type: 'text', text: `Forge plan proposal rejected: ${text}` }], isError: true });
      if (ctx.agent?.kind !== 'main') return fail('only the main Forge session can propose the plan.');
      if (!workflow?.active || workflow.phase !== 'PLAN') return fail('only valid during the Forge PLAN gate.');
      if (workflow.reworkDecisionPending === true) return fail('QA is waiting for the user\'s decision (Forge QA dialog or /forge rework). End your turn; do not draft a fix plan yet.');
      if (workflow.planWritten && workflow.planValid && !workflow.approved) {
        return fail('a plan is already awaiting human review. End your turn and wait for the decision.');
      }
      const planPath = forgePlanPath(workflow);
      const file = readPlanFile(ctx, planPath);
      if (!file.ok) return fail(`${file.error} Write the complete plan to ${planPath} first.`);
      const contract = validatePlanContract(file.content);
      if (workflow.reworkBaseHash && contract.hash === workflow.reworkBaseHash) {
        contract.valid = false;
        contract.issues.push('Rework plan is identical to the previously approved plan. Address the QA failures first.');
      }
      if (!contract.valid) {
        workflow = { ...workflow, planIssues: contract.issues };
        saveState();
        return fail(`fix the plan contract, rewrite ${planPath}, then call forge_plan_propose again:\n${contract.issues.join('\n')}`);
      }
      try { assertPlanProposable(workflow, file.content); }
      catch (err) { return fail(`${err instanceof Error ? err.message : String(err)} Then call forge_plan_propose again.`); }
      workflow = {
        ...workflow, planWritten: true, planValid: true, planPath, approvedPlanHash: contract.hash,
        businessTopics: contract.topics, requirements: contract.requirements, testCases: contract.testCases,
        qualityGates: contract.qualityGates, planIssues: [], reviewRequested: true, proposalRetries: 0,
      };
      saveState(); updateDashboard(ctx);
      notify(ctx, `Forge VALID PLAN: ${contract.topics.length} business topics, ${contract.requirements.length} requirements, ${contract.testCases.length} test cases; the approval dialog opens when this turn ends.`);
      return {
        content: [{ type: 'text', text: `[FORGE PLAN PROPOSED] ${planPath} passed the plan contract. Forge opens the human approval dialog when this turn ends. End your turn now: do not implement, do not call forge_plan_propose again, and do not ask the user to approve in chat.` }],
        details: { planPath, hash: contract.hash },
      };
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
        const details = summary + (failures.length ? '\nNon-passing business cases:\n' + failures.join('\n') : '\nAll submitted business test cases passed.') + (report.problems.length ? '\n\nGate blockers:\n' + report.problems.join('\n') : '');
        // FAIL/BLOCKED: the human decides in Forge's QA dialog before any fix is planned.
        const follow = workflow?.reworkDecisionPending === true
          ? `\n\n[FORGE QA ${report.status} — WAITING FOR THE USER]\nForge showed the user the QA summary table and asks how to continue when this turn ends. End your turn now with a one-line pointer to that table: do not draft a fix plan, edit code or rerun checks.`
          : '';
        return { content: [{ type: 'text', text: details + follow }], details: { status: report.status, reportPath: mdPath } };
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

  pi.on('session_start', async (_event, ctx) => {
    if (ctx.agent?.kind !== 'main') return;
    workspaceDir = ctx.cwd || workspaceDir;
    if (!checkpointsPruned) { checkpointsPruned = true; try { pruneForgeCheckpoints(checkpointRoot); } catch { /* best effort */ } }
    reviewEpoch++; reviewScheduled = false;
    recoveryPopupEpoch++; recoveryPopupScheduled = false; readConfig(); restoreState(ctx); updateDashboard(ctx); scheduleStateRecoveryPopup(ctx);
  });
  for (const eventName of ['session_switch', 'session_branch', 'session_tree'] as const) {
    pi.on(eventName, async (_event: any, ctx) => {
      if (ctx.agent?.kind !== 'main') return;
      reviewEpoch++; reviewScheduled = false; recoveryPopupEpoch++; recoveryPopupScheduled = false;
      workspaceDir = ctx.cwd || workspaceDir;
      restoreState(ctx);
      updateDashboard(ctx); scheduleStateRecoveryPopup(ctx);
    });
  }

  pi.on('input', async (event, ctx) => {
    if (ctx.agent?.kind !== 'main' || ctx.mode !== 'tui') return;
    const text = String(event.text ?? '').trim();
    const images = Array.isArray(event.images) ? event.images : [];
    // A prompt typed while the workflow runs may steer it. The human decides: steer
    // (re-enter the gate that absorbs it) or cancel (nothing changes, work continues).
    if (workflow?.active && !workflow.deliveryPath && event.source === 'interactive' && !text.startsWith('/') && (text || images.length)) {
      const prompt = text.replace(/^forge\s*:\s*/i, '').trim();
      const route = steeringRoute(workflow);
      const snapshot = gateSnapshot(ctx);
      const keepWorking = (reason: string) => {
        ctx.ui?.setEditorText?.(text);
        notify(ctx, `${reason} Forge continues ${workflow?.phase ?? 'its current gate'}; your prompt is back in the editor${images.length ? ' (attach images again)' : ''}.`);
        return { handled: true };
      };
      if (!route) return keepWorking('Forge steering is unavailable here.');
      if (typeof ctx.ui?.select !== 'function') return keepWorking('Forge needs the interactive selector to confirm steering.');
      const effect = route.revoked ? 'revokes approval, re-plan and approve again' : 're-plan before approval';
      const steerChoice = `Steer · ${route.from} → ${route.to} · ${effect}`;
      const cancelChoice = `Cancel · keep working on ${route.from}`;
      const choice = await ctx.ui.select(`Forge steering · prompt "${promptPreview(prompt)}" from user`, [steerChoice, cancelChoice]);
      if (!isCurrentGate(snapshot, ctx)) {
        notify(ctx, 'Forge state changed while the steering dialog was open. Nothing was steered; submit the prompt again in the intended workflow.', 'warning');
        return { handled: true };
      }
      if (choice !== steerChoice) return keepWorking('Forge steering cancelled.');
      const instruction = steer(prompt, images, ctx);
      if (!instruction) return keepWorking('Forge steering was not applied.');
      const steeredSnapshot = gateSnapshot(ctx);
      // The running turn now works for a superseded gate: stop it instead of paying
      // for its remaining tokens and time. Its specialists' late results are ignored.
      if (ctx.isIdle?.() === false) await ctx.abort?.();
      if (!isCurrentGate(steeredSnapshot, ctx)) {
        notify(ctx, 'Forge state changed while stopping the previous turn. The obsolete steering instruction was not dispatched.', 'warning');
        return { handled: true };
      }
      await syncGateModel(ctx);
      if (ctx.isIdle?.() === false) {
        pi.sendUserMessage(instruction, { deliverAs: 'followUp' });
        return { handled: true };
      }
      return { text: instruction };
    }
    const explicitPrefix = /^forge\s*:\s*/i.test(text);
    if (!explicitPrefix && !autoStart) return;
    if (!isAutoEligible(text, event.source, Boolean(workflow?.active), images.length > 0 && !explicitPrefix)) return;
    if (ctx.sessionModes?.getState?.().plan?.status !== 'inactive') return;
    const requirement = explicitPrefix ? text.replace(/^forge\s*:\s*/i, '').trim() : text;
    if (!requirement) return;
    const instruction = await begin(requirement, ctx, true, images);
    if (instruction) return { text: instruction };
  });

  pi.registerCommand('forge', {
    description: 'Start Forge, manage Gate Skills and gate models (/forge model), and inspect workflow. Configure Forge subagent models using OMP /agents.',
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
      if (command.type === 'agentHelp') return notify(ctx, 'Agent assignment commands have been removed to reduce duplication. Use OMP /agents to configure the Forge agents (forge-plan-critic, forge-code-reviewer). /forge agents shows the read-only Gate mapping.', 'warning');
      if (command.type === 'autoHelp') return notify(ctx, 'Usage: /forge auto on | /forge auto off. Bare /forge auto is not a requirement and will not start a workflow.', 'warning');
      if (command.type === 'auto') {
        try { saveConfig(command.enabled); notify(ctx, `Forge global auto-start ${command.enabled ? 'ON' : 'OFF'}.`); }
        catch (err) { notify(ctx, `Could not save config: ${String(err)}`, 'error'); }
        return;
      }
      if (command.type === 'planReview') {
        if (command.enabled === null) return notify(ctx, `Forge plan review is ${planReview ? 'ON' : 'OFF'} for new workflows${workflow?.active ? ` (this workflow: ${workflow.planReview === true ? 'ON' : 'OFF'})` : ''}. Usage: /forge planreview on|off. ON: forge-plan-critic reviews every plan before approval.`);
        try {
          persistConfig({ planReview: command.enabled }); planReview = command.enabled;
          notify(ctx, `Forge plan review ${command.enabled ? 'ON' : 'OFF'} for new workflows${workflow?.active ? '; the running workflow keeps its setting' : ''}.`);
        } catch (err) { notify(ctx, `Could not save config: ${String(err)}`, 'error'); }
        return;
      }
      if (command.type === 'modelInvalid') return notify(ctx, command.message, 'warning');
      if (command.type === 'models') return notify(ctx, `Forge gate models (main session; applied when a gate starts; thinking level kept):\n${formatGateModels(configuredGateModels)}\nSubagent models: OMP /agents.`);
      if (command.type === 'modelSet') {
        if (command.selector !== null && !(typeof ctx.models?.resolve === 'function' && ctx.models.resolve(command.selector))) {
          return notify(ctx, `Model "${command.selector}" not found among authenticated models; nothing changed.`, 'error');
        }
        try { persistConfig({ gateModels: { ...configuredGateModels, [command.gate]: command.selector } }); }
        catch (err) { return notify(ctx, `Could not save config: ${String(err)}`, 'error'); }
        notify(ctx, `Forge ${command.gate} model → ${command.selector ?? 'keep current model'}.`);
        // Gate models are live config: a change to the running gate applies now.
        if (workflow?.active && currentSkillGate(workflow.phase, workflow.qaStatus) === command.gate) {
          appliedGateKey = null;
          await syncGateModel(ctx);
        }
        return;
      }
      if (command.type === 'modelReset') {
        try { persistConfig({ gateModels: cloneGateModels() }); }
        catch (err) { return notify(ctx, `Could not save config: ${String(err)}`, 'error'); }
        return notify(ctx, `Forge gate models reset:\n${formatGateModels(configuredGateModels)}`);
      }
      if (command.type === 'recover') {
        await showStateRecovery(ctx, true);
        return;
      }
      if (command.type === 'status') {
        if (!workflow && pendingCheckpointRecovery) {
          const p = pendingCheckpointRecovery;
          const declined = declinedRecovery.has(orphanKey(p));
          notify(ctx, `Forge: RECOVERY_AVAILABLE | previousGate: ${p.state.phase} | requirement: ${String(p.state.requirement).replace(/[\r\n]/g, ' ').slice(0, 80)} | saved: ${p.savedAt ?? 'unknown'} | source: ${p.source} | other workflows: ${(p.alternatives ?? []).length} | approved in current branch: no | edits: ${declined ? 'allowed (recovery declined; Git writes still blocked)' : 'paused until recovery decision'} | action: /forge recover. Historical approval cannot be transferred across branches.`, 'warning');
          return;
        }
        const mismatch = recoveryProposal(workflow);
        if (mismatch) notify(ctx, `Forge state warning: ${mismatch.explanation} Run /forge recover to confirm a safe correction.`, 'warning');
        const missingAgents = missingGateAgentsFor(workflow);
        if (workflow?.phase === 'PLAN' && workflow.planWritten && workflow.planValid && !workflow.approved) {
          notify(ctx, 'Forge plan awaits your approval. Run /forge review to open the approval dialog.', 'info');
        }
        notify(ctx, `Forge: ${workflow?.phase ?? 'inactive'} | requirement: ${workflow?.requirement ? String(workflow.requirement).replace(/[\r\n]/g, ' ').slice(0, 80) : '(none)'} | slug: ${workflow?.slug ?? '-'} | approved: ${workflow?.approved === true ? 'yes' : 'no'} | QA: ${workflow?.qaStatus ?? 'pending'} | rework: ${workflow?.reworkCycles ?? 0} | steering: ${workflow?.steeringRevision ?? 0} | waiting agents: ${missingAgents.join(',') || 'none'}${workflow?.phase === 'EXECUTE' && !workflow.active ? ' | action: /forge qa reviews existing work without rerunning implementation; /forge resume retries execution.' : ''} | plan review: ${workflow?.planReview === true ? 'ON' : 'OFF'} | global auto: ${autoStart ? 'ON' : 'OFF'}`);
        return;
      }
      if (command.type === 'report') {
        notify(ctx, workflow?.qaReportPath ? `Last QA report: ${workflow.qaReportPath}` : 'No Forge QA report in this session yet.', workflow?.qaReportPath ? 'info' : 'warning');
        return;
      }
      if (command.type === 'delivery') {
        if (workflow?.phase === 'QA' && workflow.qaStatus === 'PASS' && !workflow.deliveryPath) {
          workflow = { ...workflow, active: true, deliveryRetries: 0 }; saveState();
          await syncGateModel(ctx);
          pi.sendUserMessage(deliveryInstruction(workflow), { attribution: 'agent' });
          return;
        }
        if (workflow?.deliveryPath) {
          notify(ctx, `Delivery: ${workflow.deliveryPath}; copy commit message from: ${workflow.commitMessagePath}`);
          return;
        }
        return notify(ctx, 'No QA-PASS delivery is available.', 'warning');
      }
      if (command.type === 'rework') {
        if (!workflow || !['FAIL', 'BLOCKED'].includes(workflow.qaStatus) || !['QA', 'PLAN'].includes(workflow.phase)) {
          return notify(ctx, 'Rework requires a previous QA FAIL/BLOCKED.', 'warning');
        }
        // Typing /forge rework is the human's go-ahead to plan a fix; the fix plan still needs approval.
        invalidateGateWork();
        qaDecisionEpoch++; qaDecisionScheduled = false;
        workflow = approveReworkTransition(workflow); saveState(); updateDashboard(ctx);
        await syncGateModel(ctx);
        pi.sendUserMessage(phaseInstruction(workflow), { attribution: 'agent' });
        return;
      }
      if (command.type === 'review') {
        await ctx.waitForIdle?.();
        if (workflow?.active && workflow.reworkDecisionPending === true) {
          if (workflow.qaSummary) pi.sendMessage({ customType: 'forge-qa-summary', content: workflow.qaSummary, display: true, excludeFromContext: true });
          await openQaDecision(ctx);
          return;
        }
        await openForgeReview(ctx);
        return;
      }
      if (command.type === 'cancel') {
        reviewEpoch++; reviewScheduled = false;
        invalidateGateWork();
        const cancelledSlug = workflow?.slug;
        workflow = null; pendingCheckpointRecovery = null; appliedGateKey = null;
        saveState(typeof cancelledSlug === 'string' ? cancelledSlug : undefined); updateDashboard(ctx);
        notify(ctx, 'Forge workflow cancelled. Native Plan Mode remains unchanged.');
        return;
      }
      if (command.type === 'qa') {
        await startQaRound(ctx);
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
        if (!workflow.active && workflow.phase === 'EXECUTE') {
          invalidateGateWork();
          workflow = { ...workflow, active: true, executionObserved: false, agentRetries: {} }; saveState();
          await syncGateModel(ctx);
          pi.sendUserMessage(executionInstruction(workflow), { attribution: 'agent' });
          return;
        }
        if (!workflow.active && workflow.phase === 'PLAN') {
          invalidateGateWork();
          workflow = { ...workflow, active: true }; saveState();
        }
        if (!workflow?.active) return notify(ctx, 'No active Forge workflow.', 'warning');
        if (workflow.phase === 'QA' && workflow.qaStatus === 'PASS') {
          await syncGateModel(ctx);
          pi.sendUserMessage(deliveryInstruction(workflow), { attribution: 'agent' });
          return;
        }
        if (workflow.phase === 'EXECUTE') return notify(ctx, 'Restored EXECUTE; approved plan retained. Inspect execution output before retrying writes. Use /forge qa when implementation is complete.', 'info');
        if (workflow.reworkDecisionPending === true) {
          await openQaDecision(ctx);
          return;
        }
        if (workflow.phase === 'QA') {
          await syncGateModel(ctx);
          pi.sendUserMessage(qaInstruction(workflow), { attribution: 'agent' });
          return;
        }
        if (workflow.phase === 'PLAN') {
          if (workflow.planWritten && workflow.planValid && !workflow.approved) {
            await openForgeReview(ctx);
            return;
          }
          workflow = { ...workflow, agentRetries: { ...(workflow.agentRetries ?? {}), PLAN: 0 } }; saveState();
          await syncGateModel(ctx);
          pi.sendUserMessage(phaseInstruction(workflow), { attribution: 'agent' });
          return;
        }
        await syncGateModel(ctx);
        pi.sendUserMessage(phaseInstruction(workflow), { attribution: 'agent' });
        return;
      }
      const requirement = command.requirement;
      if (!requirement) {
        // The main composer is the only OMP surface that delivers pasted images to
        // extensions (input event). Prefill it; the forge: input hook starts the run.
        if (typeof ctx.ui?.setEditorText !== 'function') {
          notify(ctx, 'This OMP client cannot prefill the prompt. Type "forge: <requirement>" in the prompt, or use /forge <requirement>.', 'warning');
          return;
        }
        ctx.ui.setEditorText('forge: ');
        notify(ctx, 'Forge: write your requirement after "forge: " in the prompt. Shift+Enter adds a line, Ctrl+V pastes an image. Press Enter to start.');
        return;
      }
      await begin(requirement, ctx);
    },
  });

  pi.on('before_agent_start', async (event, ctx) => {
    if (ctx.agent?.kind !== 'main' || !workflow?.active || workflow.phase !== 'EXECUTE') return;
    if (event.reason === 'revive') return;
    return { message: { customType: 'forge-execution-gate-v5', content: executionInstruction(workflow), display: true, attribution: 'agent' } };
  });

  // Forge's approval sends the execution turn itself. Observe that agent run;
  // never trigger QA just because the review dialog closed.
  pi.on('agent_start', async (_event, ctx) => {
    if (ctx.agent?.kind === 'main') updateDashboard(ctx);
    if (ctx.agent?.kind !== 'main' || !workflow?.active) return;
    if (workflow.phase === 'EXECUTE' && workflow.approved && !workflow.executionObserved) {
      workflow = { ...workflow, executionObserved: true };
      saveState();
      notify(ctx, 'Forge observed approved execution; QA will start after this execution turn settles.');
    }
  });

  pi.on('agent_end', async (_event, ctx) => {
    if (ctx.agent?.kind === 'main') {
      updateDashboard(ctx);
      // Retry point for a gate-model switch that threw earlier.
      await syncGateModel(ctx);
    }
  });

  pi.on('session_stop', async (event, ctx) => {
    if (ctx.agent?.kind === 'main') {
      updateDashboard(ctx);
      const lastAssistant = event.last_assistant_message;
      if (lastAssistant?.role === 'assistant' && (lastAssistant.stopReason === 'error' || lastAssistant.stopReason === 'aborted')) return;
    }
    scheduleStateRecoveryPopup(ctx);
    if (ctx.agent?.kind !== 'main' || !workflow?.active) return;
    if (ctx.hasPendingMessages?.()) return;


    if (workflow.reworkDecisionPending === true) {
      scheduleQaDecisionWhenIdle(ctx);
      return;
    }
    if (workflow.phase === 'EXECUTE') {
      if (!workflow.approved || !workflow.executionObserved) return;
      workflow = { ...workflow, phase: 'QA', qaStatus: null, qaRetries: 0, gateAgents: { ...(workflow.gateAgents ?? {}), QA: [] } };
      saveState(); updateDashboard(ctx);
      await syncGateModel(ctx);
      return { continue: true, additionalContext: qaInstruction(workflow) };
    }
    if (workflow.phase === 'QA' && workflow.qaStatus === 'PASS') {
      if ((workflow.deliveryRetries ?? 0) < 2) {
        workflow = { ...workflow, deliveryRetries: (workflow.deliveryRetries ?? 0) + 1 };
        saveState();
        await syncGateModel(ctx);
        return { continue: true, additionalContext: deliveryInstruction(workflow) };
      }
      workflow = { ...workflow, active: false };
      saveState();
      notify(ctx, 'QA passed, but delivery message not submitted. Run /forge delivery to retry.', 'warning');
      return;
    }
    if (workflow.phase === 'QA' && !workflow.qaStatus) {
      if (!hasAgents('QA') && (workflow.qaRetries ?? 0) < 1) {
        workflow = { ...workflow, qaRetries: 1 }; saveState();
        return { continue: true, additionalContext: qaInstruction(workflow) };
      }
      if (!hasAgents('QA')) {
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

    if (workflow.phase !== 'PLAN') return;
    if (workflow.planWritten && workflow.planValid && !workflow.approved) {
      if (workflow.reviewRequested) scheduleReviewWhenIdle(ctx);
      return;
    }
    const retries = workflow.agentRetries?.PLAN ?? 0;
    if (retries < 2) {
      workflow = { ...workflow, agentRetries: { ...(workflow.agentRetries ?? {}), PLAN: retries + 1 } }; saveState();
      return { continue: true, additionalContext: planDecisionReminder(workflow) };
    }
    notify(ctx, 'Forge PLAN is waiting for a plan proposal. Answer in the prompt to steer, or run /forge resume to resend the PLAN instruction.', 'warning');
  });

  // Before spawning a task: the QA reviewer runs only in QA; read-only research agents
  // run while planning or reviewing; approved execution may delegate to any helper.
  pi.on('before_subagent_spawn', async (event, ctx) => {
    if (ctx.agent?.kind !== 'main' || !workflow?.active) return;
    const conflict = recoveryProposal(workflow);
    if (conflict?.category === 'safety') {
      scheduleStateRecoveryPopup(ctx);
      return { block:true, reason:`Forge state needs human review before spawning agents: ${conflict.explanation}. Run /forge recover.` };
    }
    const selected = typeof event.agent === 'string' ? event.agent : String(event.agent?.name ?? '');
    const required = requiredAgentsFor(workflow);
    if (!required.includes(selected)) {
      if (guardedAgentNames.has(selected) || listAssignedAgentNames(workflow.agentAssignments).includes(selected)) {
        return { block: true, reason: `Forge ${workflow.phase}: ${selected} is not part of this gate (forge-plan-critic runs in PLAN only with plan review on; forge-code-reviewer runs in QA review).` };
      }
      if (workflow.phase === 'EXECUTE' && workflow.approved === true) return;
      if (RESEARCH_AGENTS.includes(selected)) return;
      return { block: true, reason: `Forge ${workflow.phase}: only read-only research agents (${RESEARCH_AGENTS.join(', ')})${required.length ? ` and ${required.join(', ')}` : ''} may run in this gate; got ${selected || 'unknown'}.` };
    }
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
    if (event.toolName !== 'task') return;
    const pending = runningTasks.get(id);
    if (id) runningTasks.delete(id);
    // No matching dispatch or errored task: never count as completed.
    if (!pending || !isCurrentGate(pending.scope, ctx) || event.isError) return;
    const outputs = (event.content ?? []).filter((x: any)=>x?.type==='text' && typeof x.text==='string' && x.text.trim()).map((x: any)=>x.text);
    // Empty successful tool results are not meaningful completed agent reports.
    if (!outputs.length && !event.details) return;
    const notes: string[] = [];
    for (const agent of pending.agents) {
      if (requiredAgentsFor(workflow).includes(agent) && (workflow.gateAgentsSpawned?.[workflow.phase] ?? []).includes(agent)) {
        markAgent(agent, ctx);
        const highFindings = extractHighFindings(outputs.join('\n'));
        workflow = { ...workflow, agentCompletions: [...(workflow.agentCompletions ?? []),
          { gate: pending.scope.phase, agent, resultId: id, reportedAt: new Date().toISOString(),
            resultPreview: outputs.join('\n').slice(0,800) || '[structured tool result]', highFindings }] };
        saveState();
        if (highFindings.length) notes.push(workflow.phase === 'PLAN'
          ? `Forge: ${agent} reported CRITICAL/HIGH ${highFindings.join(', ')}. Resolve each in the plan and cite its ID before forge_plan_propose.`
          : `Forge: ${agent} reported CRITICAL/HIGH ${highFindings.join(', ')}. Carry each in codeReview.findings under its ID at CRITICAL/HIGH, or start its evidence with "Disputed:" and your counter-evidence.`);
      }
    }
    return notes.length ? { additionalContext: notes.join('\n') } : undefined;
  });

  pi.on('tool_call', async (event, ctx) => {
    // Forge subagents run with independent sessions. Their Git tool calls must be
    // guarded too; checking main only leaves helper and QA child agents exposed.
    const childName = String(ctx.agent?.name ?? '');
    const isForgeChild = ctx.agent?.kind === 'sub' && (guardedAgentNames.has(childName) || listAssignedAgentNames(workflow?.agentAssignments).includes(childName));
    const tool = String(event.toolName ?? '');
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
      const scope = gateSnapshot(ctx);
      if (id && scope) runningTasks.set(id, { scope, agents: taskAgents(event.input) });
      if (taskAgents(event.input).some(a => requiredAgentsFor(workflow).includes(a))) {
        let skillBrief = '';
        try { skillBrief = skillBriefForGate(); }
        catch (err) { if (id) runningTasks.delete(id); return { block: true, reason: `Forge gate skill verification failed: ${String(err)}` }; }
        if (skillBrief) {
          const rewritten = injectGateSkillsIntoTask(event.input, workflow.phase, skillBrief);
          if (!rewritten) { if (id) runningTasks.delete(id); return { block: true, reason: 'Forge gate skills require task text on every subagent. Stepped tasks without task text cannot receive required skill instructions.' }; }
          return { input: rewritten };
        }
      }
    }
    const input = event.input ?? {};
    const stateConflict = recoveryProposal(workflow);
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
      if (!READ_ONLY_TOOLS.includes(tool)) return { block: true, reason: 'Forge specialist is read-only: it reviews and reports; no edits, shell or Git writes.' };
      return;
    }
    if (!workflow || (!workflow.active && workflow.deliveryPath)) return;
    if (!workflow.active && !READ_ONLY_TOOLS.includes(tool)) {
      return { block: true, reason: 'Forge is paused. Resume the workflow or cancel it before making changes.' };
    }
    if (workflow.reworkDecisionPending === true && ['forge_qa_submit', 'forge_plan_propose', 'write', 'edit', 'apply_patch'].includes(tool)) {
      return { block: true, reason: `Forge QA ${workflow.qaStatus} is waiting for the user's decision in the Forge QA dialog (or /forge rework, /forge qa). End your turn; do not plan a fix, edit files or resubmit QA.` };
    }
    if (workflow.phase === 'QA') {
      const delivery = workflow.qaStatus === 'PASS';
      if (READ_ONLY_TOOLS.includes(tool) || tool === 'task' || tool === 'todo' || tool === 'wait') return;
      if (delivery ? tool === 'forge_delivery_submit' : tool === 'forge_qa_scope' || tool === 'forge_qa_submit') return;
      if (['bash', 'shell', 'terminal', 'exec', 'run'].includes(tool)) {
        const cmd = String(input.command ?? input.cmd ?? '');
        if (isAllowedQaCommand(cmd)) return;
        return { block: true, reason: `Forge ${delivery ? 'delivery' : 'QA'} permits only conservative read-only Git/test commands. Record NOT_RUN if unavailable.` };
      }
      // Unknown tools can mutate files or external services (eval, AST/LSP edits,
      // MCP writes). Review and delivery must fail closed, just like pre-approval.
      return { block: true, reason: `Forge ${delivery ? 'delivery' : 'post-execution QA'} is read-only: tool ${tool} is not permitted.` };
    }
    if (workflow.phase === 'EXECUTE' && workflow.approved === true) return;

    // Phase-based permissions, NOT an all-tools Plan Mode precondition.
    // Read, grep, glob, task, and ask must work even when OMP's Plan Mode
    // temporarily becomes inactive or paused. This fixes the Discovery deadlock.
    const preApproval = ['PLAN', 'EXECUTE'].includes(workflow.phase);
    if (!preApproval) return;

    if (['read', 'grep', 'glob', 'ls', 'task', 'ask', 'todo', 'wait', 'web_search'].includes(tool)) return;
    // Control-plane only: proposes the Forge plan file for human review.
    if (tool === 'forge_plan_propose' && workflow.phase === 'PLAN') return;

    if (['write', 'edit', 'apply_patch'].includes(tool)) {
      // Forge's own plan mode: the single plan file of the current PLAN gate is
      // the only writable path before human approval. Native propose devices stay blocked.
      const planPath = forgePlanPath(workflow);
      const targets = editTargets(input);
      const destructive = tool === 'edit' && typeof input.input === 'string' && /^(?:REM|MV)\b/m.test(input.input);
      if (workflow.phase === 'PLAN' && tool !== 'apply_patch' && !destructive && targets.length > 0 && targets.every(t => t === planPath)) {
        if (workflow.planWritten && workflow.planValid) return { block: true, reason: 'The plan is awaiting human review in Forge. Wait for the decision (or /forge review); do not change it now.' };
        return;
      }
      const planHint = workflow.phase === 'PLAN' ? ` Only ${planPath} is writable during Forge PLAN (write, or edit without REM/MV); received ${JSON.stringify(targets.join(', '))}.` : '';
      return { block: true, reason: `Forge ${workflow.phase} is read-only: implementation writes require explicit human plan approval.${planHint}` };
    }

    if (['bash', 'shell', 'terminal', 'exec', 'run'].includes(tool)) {
      const command = String(input.command ?? input.cmd ?? '');
      if (isAllowedDiscoveryCommand(command)) return;
      return { block: true, reason: `Forge ${workflow.phase} permits only safe read-only inspection commands before Approval.` };
    }
    if (tool === 'python') return { block: true, reason: 'Python execution is not approved during Forge Discovery/Planning.' };

    // Unknown tools may write to the filesystem or external services. Fail
    // closed until an explicit audited read-only capability is added.
    return { block: true, reason: `Forge ${workflow.phase}: unknown tool ${tool} cannot run before human plan approval. Use read/grep/glob/task(scout)/ask.` };

  });
}

#!/usr/bin/env node
// Assemble self-contained adapter packages from the shared core.
//   dist/omp/omp-forge-global-v<ver>/      → bash install.sh into ~/.omp/agent
//   dist/claude-code/forge-marketplace/     → /plugin marketplace add <path>
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const DIST = join(ROOT, 'dist');
const coreFiles = readdirSync(join(ROOT, 'core')).filter(f => f.endsWith('.mjs'));
const agentFiles = readdirSync(join(ROOT, 'agents')).filter(f => /^forge-.*\.md$/.test(f));
const roleConfig = JSON.parse(readFileSync(join(ROOT, 'agents', 'roles.json'), 'utf8'));
const MODEL_PROFILE = process.env.FORGE_MODELS || 'rigor';
const roles = roleConfig.profiles?.[MODEL_PROFILE];
if (!roles) throw new Error(`Unknown FORGE_MODELS profile "${MODEL_PROFILE}". Use: ${Object.keys(roleConfig.profiles ?? {}).join(', ')}`);

rmSync(DIST, { recursive: true, force: true });

// ---------- OMP adapter ----------
const omp = join(DIST, 'omp', `omp-forge-global-v${VERSION}`);
mkdirSync(omp, { recursive: true });
for (const entry of readdirSync(join(ROOT, 'adapters', 'omp'))) {
  cpSync(join(ROOT, 'adapters', 'omp', entry), join(omp, entry), { recursive: true });
}
for (const f of coreFiles) cpSync(join(ROOT, 'core', f), join(omp, 'forge', f)); // flat vendoring keeps './core.mjs' imports
mkdirSync(join(omp, 'agents'), { recursive: true });
for (const f of agentFiles) cpSync(join(ROOT, 'agents', f), join(omp, 'agents', f));
cpSync(join(ROOT, 'skills'), join(omp, 'skills'), { recursive: true });
for (const sh of ['install.sh', 'uninstall.sh', 'smoke-install.sh', 'install-example-skills.sh']) {
  if (existsSync(join(omp, sh))) chmodSync(join(omp, sh), 0o755);
}

// ---------- Claude Code adapter ----------
const market = join(DIST, 'claude-code', 'forge-marketplace');
const plugin = join(market, 'plugins', 'forge');
mkdirSync(plugin, { recursive: true });
cpSync(join(ROOT, 'adapters', 'claude-code', 'plugin'), plugin, { recursive: true });
cpSync(join(ROOT, 'skills'), join(plugin, 'skills'), { recursive: true });
mkdirSync(join(plugin, 'core'), { recursive: true });
for (const f of coreFiles) cpSync(join(ROOT, 'core', f), join(plugin, 'core', f));
mkdirSync(join(plugin, 'agents'), { recursive: true });
const TOOL_MAP = { read: 'Read', grep: 'Grep', glob: 'Glob', edit: 'Edit', write: 'Write', ls: 'LS', bash: 'Bash' };
for (const f of agentFiles) {
  const name = f.replace(/\.md$/, '');
  const src = readFileSync(join(ROOT, 'agents', f), 'utf8');
  const m = src.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`Agent ${f} has no frontmatter`);
  const fm = Object.fromEntries(m[1].split('\n').map(l => l.match(/^([A-Za-z_-]+):\s*(.*)$/)).filter(Boolean).map(x => [x[1], x[2]]));
  const tools = (fm.tools ?? '').split(',').map(t => t.trim()).filter(Boolean).map(t => TOOL_MAP[t] ?? t);
  const description = String(fm.description ?? name).replace(/OMP Forge Global v5\s*·\s*/g, 'Forge · ');
  const body = m[2].replace(/OMP Forge Global/g, 'Forge')
    .replace(/writes the plan to local:\/\/ and submits native review/g, 'submits the plan through Claude Code native plan approval (ExitPlanMode)')
    .replace(/local:\/\/[^\s`'".,)]*/g, 'the plan file').replace(/xd:\/\/propose/g, 'ExitPlanMode')
    .replace(/\bOMP\b/g, 'Claude Code');
  const model = roles[name] ?? 'inherit';
  writeFileSync(join(plugin, 'agents', f), `---\nname: ${name}\ndescription: ${description}. Use only when the Forge workflow names this agent.\ntools: ${tools.join(', ')}\nmodel: ${model}\n---\n${body}`);
}
// One command per subcommand: Claude Code autocompletes command names, not arguments.
const SUBCOMMANDS = [
  ['status', 'Show the current Forge gate and waiting agents', ''],
  ['resume', 'List Forge workflows from other sessions of this project, or adopt one', '[number]'],
  ['approve', 'Approve the submitted plan yourself (when Forge could not see the native approval)', ''],
  ['plan', 'Show the path of the submitted/approved plan', ''],
  ['qa', 'Start or rerun independent QA for the approved execution', ''],
  ['rework', 'Plan a rework after QA FAIL/BLOCKED (needs new approval)', ''],
  ['delivery', 'Show or resume delivery (commit message for manual commit)', ''],
  ['report', 'Show the last QA report path', ''],
  ['agents', 'List the Forge specialist agents', ''],
  ['off', 'Cancel the Forge workflow (no files or Git state changed)', ''],
  ['trace', 'Log hook events for the live end-to-end coverage report', '[on|off]'],
];
const commandBody = invocation => `The user ran \`${invocation}\`.\n\nThe Forge plugin hook has already processed this command and attached its result as context that starts with "Forge" or "[FORGE".\n\n- If Forge attached a gate instruction, follow it exactly, starting now.\n- If Forge attached only a status or message, show it to the user verbatim and stop.\n- If no Forge context is present, tell the user the Forge hook did not run (check \`/hooks\`, and that \`node\` 22+ is on PATH) and do nothing else.\n`;
for (const [name, description, hint] of SUBCOMMANDS) {
  writeFileSync(join(plugin, 'commands', `forge-${name}.md`),
    `---\ndescription: Forge · ${description}\n${hint ? `argument-hint: ${hint}\n` : ''}disable-model-invocation: true\n---\n${commandBody(`/forge-${name}${hint ? ' $ARGUMENTS' : ''}`)}`);
}

const manifestPath = join(plugin, '.claude-plugin', 'plugin.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.version = VERSION;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
mkdirSync(join(market, '.claude-plugin'), { recursive: true });
writeFileSync(join(market, '.claude-plugin', 'marketplace.json'), JSON.stringify({
  name: 'forge-local',
  owner: { name: 'Forge' },
  plugins: [{ name: 'forge', source: './plugins/forge', description: manifest.description, version: VERSION }],
}, null, 2) + '\n');
for (const f of readdirSync(join(plugin, 'bin'))) chmodSync(join(plugin, 'bin', f), 0o755);

writeFileSync(join(market, 'README.md'), readFileSync(join(ROOT, 'README.md'), 'utf8').replace(/adapters\/claude-code\/README\.md/g, 'PLUGIN.md'));
cpSync(join(ROOT, 'docs', 'images'), join(market, 'docs', 'images'), { recursive: true });
for (const doc of ['E2E-TEST-PLAN_TH.md', 'ARCHITECTURE.md', 'DEVELOPMENT.md']) cpSync(join(ROOT, 'docs', doc), join(market, 'docs', doc));
cpSync(join(ROOT, 'adapters', 'claude-code', 'README.md'), join(market, 'PLUGIN.md'));
cpSync(join(ROOT, 'adapters', 'claude-code', 'QUICKSTART_TH.md'), join(market, 'QUICKSTART_TH.md'));
console.log(`Built Forge ${VERSION} (models: ${MODEL_PROFILE})\n  ${omp}\n  ${market}`);

// The `omp plugin` package (dist/omp/forge) runs from a cache that upgrades replace:
// bundled agents/skills must resolve from the package, user state must not live in it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync, writeFileSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const pluginRoot = fileURLToPath(new URL('../../forge/', import.meta.url));
const {default: forgeExtension} = await import(join(pluginRoot, 'forge', 'index.ts'));
const tmp = mkdtempSync(join(tmpdir(), 'omp-forge-plugin-tests-'));
process.on('exit', () => rmSync(tmp, {recursive: true, force: true}));
delete process.env.FORGE_CONFIG_PATH;
delete process.env.FORGE_REPORT_DIR;

const fakeZ = new Proxy({}, {get: () => () => ({optional() { return this; }})});
let seq = 0;
function setup() {
  const agentRoot = join(tmp, `agent-${++seq}`);
  mkdirSync(agentRoot, {recursive: true});
  process.env.PI_CODING_AGENT_DIR = agentRoot;
  const events = new Map(), commands = new Map(), tools = new Map(), entries = [], notifications = [];
  let plan = 'inactive';
  const pi = {
    zod: fakeZ, setLabel() {},
    on(event, handler) { events.set(event, handler); },
    registerCommand(name, cmd) { commands.set(name, cmd); },
    registerTool(tool) { tools.set(tool.name, tool); },
    sendUserMessage() {}, sendMessage() {},
    appendEntry(customType, data) { entries.push({type: 'custom', customType, data}); },
    async setModel() { return true; }, getThinkingLevel() {}, setThinkingLevel() {},
  };
  const ctx = {
    agent: {kind: 'main'}, mode: 'tui', cwd: tmp,
    sessionModes: {getState: () => ({plan: {status: plan}}), set: async ({action} = {}) => { plan = action === 'exit' ? 'inactive' : 'active'; return {ok: true, changed: true}; }},
    sessionManager: {getBranch: () => entries, getEntries: () => entries, getSessionId: () => `plugin-session-${seq}`, getSessionFile: () => join(agentRoot, 'session.jsonl')},
    ui: {notify: (message, level) => notifications.push({message, level})},
    hasPendingMessages: () => false, isIdle: () => true, setTimeout: () => {},
  };
  return {agentRoot, init: () => forgeExtension(pi), events, commands, tools, entries, notifications, ctx};
}

test('plugin package: bundled gate skills and agents resolve; config is written under the agent directory', async () => {
  const x = setup();
  x.init();
  await x.events.get('session_start')({}, x.ctx);
  await x.commands.get('forge').handler('planreview on', x.ctx);
  assert.equal(JSON.parse(readFileSync(join(x.agentRoot, 'forge', 'config.json'), 'utf8')).planReview, true);
  assert.equal(existsSync(join(pluginRoot, 'forge', 'config.json')), false, 'nothing is written into the plugin cache');
  await x.commands.get('forge').handler('agents', x.ctx);
  assert.match(x.notifications.at(-1).message, /forge-code-reviewer {2}found · forge-code-reviewer · plugin/);
  await x.commands.get('forge').handler('Build payment API', x.ctx);
  const state = x.entries.at(-1).data;
  assert.equal(state.active, true, x.notifications.map(n => n.message).join('\n'));
  assert.ok(state.skillPins['forge-plan-gate'].path.startsWith(realpathSync(join(pluginRoot, 'skills'))));
});

test('plugin package: a user copy of a gate skill wins over the bundled one', async () => {
  const x = setup();
  const dir = join(x.agentRoot, 'skills', 'forge-plan-gate');
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: forge-plan-gate\ndescription: My plan gate\n---\nMy planning rules\n');
  x.init();
  await x.events.get('session_start')({}, x.ctx);
  await x.commands.get('forge').handler('Build payment API', x.ctx);
  assert.equal(x.entries.at(-1).data.skillPins['forge-plan-gate'].path, realpathSync(join(dir, 'SKILL.md')));
});

test('plugin package: stays inactive beside an install.sh copy and adopts its config', async () => {
  const x = setup();
  const legacy = join(x.agentRoot, 'extensions', 'forge');
  mkdirSync(legacy, {recursive: true});
  writeFileSync(join(legacy, 'index.ts'), 'export default () => {};\n');
  writeFileSync(join(legacy, 'config.json'), '{"autoStart":true,"planReview":true}\n');
  x.init();
  assert.equal(x.commands.size, 0, 'no second /forge command');
  assert.equal(x.tools.size, 0, 'no second set of Forge tools');
  assert.equal(readFileSync(join(x.agentRoot, 'forge', 'config.json'), 'utf8'), '{"autoStart":true,"planReview":true}\n');
  await x.events.get('session_start')({}, x.ctx);
  const warning = x.notifications.at(-1);
  assert.equal(warning.level, 'warning');
  assert.ok(warning.message.includes(`mv "${legacy}"`), warning.message);
});

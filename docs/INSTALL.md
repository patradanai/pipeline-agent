# Install, update, and remove Forge

Forge is distributed as source in this repository. The repository root is also an OMP plugin marketplace (`.omp-plugin/marketplace.json`) whose plugin package, `dist/omp/forge/`, is committed, so OMP users can install without building. Building requires Node.js 22+; the legacy OMP installer requires Bash.

## 1. Get the source and build

Clone this repository using its HTTPS URL from your Git host, then build:

```bash
git clone <repository-url>
cd <repository-directory>
npm run build
```

The build creates:

- `dist/omp/forge/` — OMP plugin package (`package.json` declares `omp.extensions`; bundled `agents/` and `skills/`), plus `.omp-plugin/marketplace.json` at the repository root
- `dist/omp/omp-forge-global-v6.1.0/` — legacy OMP copy installer (`install.sh`)
- `dist/claude-code/forge-marketplace/` — local Claude Code marketplace

To build with a different model profile, set `FORGE_MODELS=rigor`, `balanced`, or `economy` before `npm run build`.

## 2A. Install on OMP

Add the repository as a marketplace (Git URL, `owner/repo` on GitHub, or the absolute path of a built clone), then install the plugin:

```bash
omp plugin marketplace add <repository-url or /absolute/path/to/clone>
omp plugin install forge@omp-forge            # add --scope project for one project only
```

Restart OMP, open a main interactive TUI session, and run `/forge status`. Start a task with `/forge <requirement>` or run `/forge` to prefill the prompt.

For local development, link the build output instead; a rebuild takes effect on the next OMP start:

```bash
omp plugin link ./dist/omp/forge
```

Where things live:

- Plugin code, bundled agents and gate skills: the OMP plugin cache. Upgrades replace it, so do not edit files there.
- Your Forge config: `~/.omp/agent/forge/config.json` (`$PI_CODING_AGENT_DIR/forge/config.json` with a custom agent directory). Reports, checkpoints and attachments stay under the agent directory as before.
- Your skill and agent customizations: `~/.omp/agent/skills/` and `~/.omp/agent/agents/`. Forge pins a user skill before the bundled skill of the same name, and `/forge skill create` writes there. For a same-named agent, OMP's agent precedence decides which copy runs; check `/agents`.

### Moving from install.sh to the plugin

If an `install.sh` copy is still at `~/.omp/agent/extensions/forge`, the plugin stays inactive (both would register `/forge`) and shows the exact command to park the old copy. Forge copies the old `config.json` to `~/.omp/agent/forge/config.json` first. Agents and gate skills that `install.sh` put under `~/.omp/agent` stay there; delete them if you want the plugin's bundled versions.

### Legacy: install.sh

```bash
cd dist/omp/omp-forge-global-v6.1.0
bash ./install.sh
```

By default the installer uses `~/.omp/agent`. To use a custom OMP agent directory:

```bash
PI_CODING_AGENT_DIR="$HOME/.config/omp/agent" bash ./install.sh
```

The installer copies the extension, installs missing bundled agents and gate skills, and preserves existing agent definitions, skills, and configuration. Existing agent or skill edits are not overwritten by default. Old files are backed up under `forge-backups/`.

To explicitly replace installed agent definitions with the bundled versions, first review your existing customizations, then run:

```bash
FORGE_REINSTALL_AGENTS=1 bash ./install.sh
```

The installer makes backups before replacing agent files. It does not require this flag for normal upgrades.

## 2B. Install on Claude Code

From the repository root, after building, use the absolute path to your clone in Claude Code:

```text
/plugin marketplace add /absolute/path/to/<repository-directory>/dist/claude-code/forge-marketplace
/plugin install forge@forge-local
```

Restart Claude Code and check `/hooks`, `/mcp`, and `/agents`. Start with `/forge <requirement>`. For details and known adapter limitations, see the [Claude Code guide](../adapters/claude-code/README.md) and [architecture notes](ARCHITECTURE.md#claude-code-adapter--known-gaps-validate-on-your-install).

## Update

OMP plugin:

```bash
omp plugin marketplace update omp-forge
omp plugin upgrade forge@omp-forge
```

Naming the plugin always reinstalls the catalog's current version, so a same-version rebuild is picked up too. Restart OMP afterward.

Legacy install.sh: fetch the new source, rebuild, and rerun the installer:

```bash
git pull
npm run build
cd dist/omp/omp-forge-global-v6.1.0
bash ./install.sh
```

Restart OMP after installation. Customized OMP agent prompts and existing config are preserved unless you explicitly request replacement. For Claude Code, rebuild and update/reinstall the local marketplace plugin through Claude Code's plugin manager.

## Remove or disable

OMP plugin: `omp plugin uninstall forge@omp-forge`, or `omp plugin disable forge@omp-forge` to keep it installed. Your config, reports and checkpoints under the agent directory are kept.

Legacy install.sh: run the bundled uninstaller:

```bash
cd dist/omp/omp-forge-global-v6.1.0
bash ./uninstall.sh
```

Restart OMP afterward. The uninstaller parks the extension and agent definitions instead of deleting them. It does not erase OMP session history, backups, gate skills, reports, or checkpoints. Review and remove those data files manually only after confirming you no longer need them.

For Claude Code, use its plugin management UI/command to uninstall `forge@forge-local`. Removing the plugin does not delete session data stored by Claude Code.

## Verify source before installation

Run the project test suite before installing a source checkout:

```bash
npm test
```

This rebuilds both adapter packages and runs core, example, OMP, installer-smoke, and Claude Code adapter tests. It does not replace a live OMP or Claude Code validation on your own host.

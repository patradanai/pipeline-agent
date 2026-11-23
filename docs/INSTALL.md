# Install, update, and remove Forge

Forge is distributed as source in this repository. Build the self-contained adapter packages locally. Requires Node.js 22+ and Bash for the OMP installer.

## 1. Get the source and build

Clone this repository using its HTTPS URL from your Git host, then build:

```bash
git clone <repository-url>
cd <repository-directory>
npm run build
```

The build creates:

- `dist/omp/omp-forge-global-v6.1.0/` — OMP extension package
- `dist/claude-code/forge-marketplace/` — local Claude Code marketplace

To build with a different model profile, set `FORGE_MODELS=rigor`, `balanced`, or `economy` before `npm run build`.

## 2A. Install on OMP

```bash
cd dist/omp/omp-forge-global-v6.1.0
bash ./install.sh
```

Restart OMP, open a main interactive TUI session, and run `/forge status`. Start a task with `/forge <requirement>` or run `/forge` to prefill the prompt.

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

Fetch the new source, rebuild, and rerun the OMP installer:

```bash
git pull
npm run build
cd dist/omp/omp-forge-global-v6.1.0
bash ./install.sh
```

Restart OMP after installation. Customized OMP agent prompts and existing config are preserved unless you explicitly request replacement. For Claude Code, rebuild and update/reinstall the local marketplace plugin through Claude Code's plugin manager.

## Remove or disable

For OMP, run the bundled uninstaller:

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

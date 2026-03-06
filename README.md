# ClawPack CLI

The command-line tool for [ClawPack](https://clawpack.io) — the agent registry. Push, pull, and run OpenClaw agent bundles.

<p align="center">
  <img src="https://raw.githubusercontent.com/pigeonflow/clawpack-cli/main/docs/cli.gif" alt="ClawPack CLI demo" width="640">
</p>

## Install

```bash
npm install -g @clawpack/cli
```

## Quick Start

```bash
# 1. Authenticate with the registry
clawpack login --api-key cd_xxx

# 2. Set up runtime credentials (one-time)
clawpack credentials set --provider github-copilot --api-key ghu_xxx --model github-copilot/claude-sonnet-4

# 3. Pull and run any agent
clawpack run hugo/caramelo
```

## Commands

### Registry

| Command | Description |
|---------|-------------|
| `clawpack login` | Authenticate with your registry access token |
| `clawpack whoami` | Show current user |
| `clawpack init` | Create a `manifest.json` in the current directory |
| `clawpack push [path]` | Bundle and publish an agent. Use `--org <slug>` to publish under an organization |
| `clawpack pull <owner/slug[@version]>` | Download and extract a bundle |
| `clawpack pull <owner/slug> --link` | Download, extract, and register in OpenClaw |
| `clawpack search <query>` | Search the registry |
| `clawpack list` | List your published bundles |
| `clawpack update` | Update the CLI to the latest version |

### `clawpack push`

Bundle and publish an agent to the registry.

```bash
# Push as public (default)
clawpack push .

# Push as private
clawpack push . --private

# Include a changelog
clawpack push . --changelog "Fixed memory leak in heartbeat loop"

# Publish under an organization
clawpack push . --org my-org

# Push from a specific path
clawpack push ./my-agent --private --changelog "Initial release"
```

The push command reads `manifest.json` from the target directory. Create one with `clawpack init`.

### `clawpack pull`

```bash
# Pull latest version
clawpack pull hugo/caramelo

# Pull specific version
clawpack pull hugo/caramelo@1.2.0

# Extract to a custom directory
clawpack pull hugo/caramelo --dir ./agents

# Pull and register in OpenClaw in one step
clawpack pull hugo/caramelo --link
```

### `clawpack search`

```bash
clawpack search "sales agent"
clawpack search translator --limit 5
```

### Agent Management

| Command | Description |
|---------|-------------|
| `clawpack link [path]` | Register a pulled agent in OpenClaw (post-install, auth, health check) |
| `clawpack unlink <name>` | Unregister an agent from OpenClaw (keeps workspace files) |
| `clawpack chat <owner/slug>` | Interactive chat session with a pulled agent |
| `clawpack parasite <owner/slug>` | Hot-swap a ClawPack agent onto another agent's channels |

### Runtime

| Command | Description |
|---------|-------------|
| `clawpack credentials set` | Configure provider/model/runtime for running agents |
| `clawpack credentials show` | Show stored runtime credentials |
| `clawpack credentials clear` | Remove stored credentials |
| `clawpack run <owner/slug[@version]>` | Pull + launch an agent locally |

### `clawpack run`

Pulls an agent bundle and launches it with a local runtime (OpenClaw by default).

```bash
# Uses stored credentials
clawpack run hugo/caramelo

# Override model
clawpack run hugo/caramelo --model github-copilot/claude-opus-4

# Use a different runtime
clawpack run hugo/caramelo --runtime nullclaw@latest

# Override provider and API key
clawpack run hugo/caramelo --provider openai --api-key sk-xxx

# Skip pull (use cached workspace)
clawpack run hugo/caramelo --no-pull
```

Agents are cached at `~/.clawpack/agents/<owner>/<slug>/workspace/`.

### `clawpack link`

Register an already-pulled agent directory in OpenClaw. Runs post-install scripts, sets up auth, and verifies the agent responds.

```bash
# Link current directory
clawpack link

# Link a specific path
clawpack link ./dr-contrato

# Override agent name and model
clawpack link ./dr-contrato --name my-lawyer --model openrouter/anthropic/claude-sonnet-4

# Skip health check
clawpack link ./dr-contrato --skip-health-check
```

Auth fallback chain: `--provider/--api-key` → `clawpack credentials` → `CLAWPACK_API_KEY` env → copy from main agent.

### `clawpack unlink`

Remove an agent from OpenClaw without deleting workspace files.

```bash
clawpack unlink dr-contrato
```

### `clawpack chat`

Interactive chat session with a pulled agent. Temporary registration — unregisters on exit.

```bash
clawpack chat hugo/caramelo
clawpack chat hugo/caramelo --model openrouter/anthropic/claude-opus-4
```

### `clawpack parasite`

Hot-swap any ClawPack agent onto another agent's channels. All messages that would go to the host get routed to the parasite instead. Press Ctrl+C to restore.

```bash
# Route all of main's channels to dr-contrato
clawpack parasite hmendes00/dr-contrato --host main

# Restore after a crash (reads saved state)
clawpack parasite --restore
```

**Use cases:**
- **Try before you buy** — test an agent on your real channels for 10 minutes
- **Specialist handoff** — swap in a legal agent for an hour
- **Demos** — show a client their agent on a live channel instantly

**Crash safety:** State is saved to `~/.clawpack/.parasite-state.json`. If the process dies, run `--restore` to recover.

### Supported Runtimes

| Runtime | Default | Install |
|---------|---------|---------|
| `openclaw@latest` | ✅ | `npm install -g openclaw` (auto-installed if missing) |
| `nullclaw@latest` | | [github.com/pigeonflow/brain-arch-v2](https://github.com/pigeonflow/brain-arch-v2) |

## Configuration

All config lives in `~/.clawpack/config.json`:

```json
{
  "apiKey": "cd_registry_token",
  "registry": "https://clawpack.io",
  "runtime": {
    "provider": "github-copilot",
    "apiKey": "ghu_xxx",
    "model": "github-copilot/claude-sonnet-4",
    "runtime": "openclaw@latest"
  }
}
```

Environment variables:
- `CLAWPACK_API_KEY` — override runtime API key
- `CLAWPACK_REGISTRY` — override registry URL

## License

MIT

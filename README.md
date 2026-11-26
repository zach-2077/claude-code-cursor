# claude-code-cursor (`ccc`)

English | [简体中文](./README.zh-CN.md)

Use **Claude Code (`claude` CLI)** as your agent harness (tool loop, permission approvals, diff previews, skills, hooks, and MCP) while routing inference to **models included in your Cursor subscription** (`composer-2.5`, `grok-4.7`, `gemini-4-carbon`, `gemini-4-neon`, `gemini-3.8-flash`, `kimi-k3`, etc.).

## How It Works

`claude-code-cursor` runs a local **Anthropic Messages API (`/v1/messages`)** proxy server and communicates directly with Cursor's Agent backend over **HTTP/2 Connect-RPC** (via `cursor-opencode-provider`):

```text
Claude Code (Harness)
  │  POST /v1/messages (Anthropic SSE, Claude tool vocabulary: Bash/Read/Edit/Write/Grep/Glob/Agent...)
  ▼
claude-code-cursor local proxy (src/server.ts)
  ├─ Auth (src/auth.ts): Reuses `cursor-agent login` credentials from macOS Keychain with auto JWT refresh
  ├─ Router (src/models.ts): Native Cursor model IDs, thinking effort & Max Mode context variants, fast Haiku routing
  ├─ Bidirectional Translation (src/translate/*):
  │    • Inbound: Claude Code tools/messages ──► Canonical OpenCode/Cursor tool schemas
  │    • Result sanitization: Strips Claude `Read` `1→` line prefixes & converts ripgrep output previews
  │    • Outbound: Cursor tool-call / thinking / text ──► Native Claude Code `tool_use` & Anthropic SSE
  ▼
Cursor Connect-RPC (HTTP/2 bidirectional stream)
  └─ Held Run Continuation during tool execution: 100% of file edits & shell commands stay under Claude Code's permission loop (no rogue subprocess writes, and compatible with enterprise teams that disable `cursor-agent --print`).
```

## Quick Start

### 1. Install & Build

Requires [Bun](https://bun.sh) (v1.2+) and Claude Code (`claude` CLI).

```bash
cd claude-code-cursor
bun install
bun run build
```

### 2. Authenticate with Cursor (skip if already logged in via `cursor-agent`)

Check your current login status and available Cursor models:

```bash
./bin/ccc.mjs status
./bin/ccc.mjs models
```

If you haven't logged in yet, run either:

```bash
cursor-agent login
# or use the built-in browser PKCE login:
./bin/ccc.mjs login
```

### 3. Launch Claude Code in One Command (Recommended)

`./bin/ccc.mjs` starts a local proxy on an ephemeral port, injects `--settings` for that session (without mutating `~/.claude/settings.json`), and cleans up the proxy process on exit:

```bash
# Launch interactive Claude Code with composer-2.5 (default)
./bin/ccc.mjs

# Specify another Cursor model (e.g. grok-4.7 or gemini-4-carbon)
./bin/ccc.mjs --ccc-model grok-4.7

# Control context window (Max Mode) & thinking effort
./bin/ccc.mjs --ccc-model grok-4.7 --ccc-max --effort low
./bin/ccc.mjs --ccc-model "gemini-4-carbon[1m]" --effort high
./bin/ccc.mjs --ccc-model grok-4.7 --ccc-autocompact 200k

# Single-shot non-interactive prompt (-p)
./bin/ccc.mjs -p "Summarize the directory structure of this project"
```

### 4. Background Daemon Mode

```bash
# Start background daemon (listens on 127.0.0.1:32125 by default, logs to ~/.claude/cache/claude-code-cursor.log)
./start-daemon.sh

# Stop background daemon cleanly (unloads LaunchAgent if present and frees the port)
./kill-daemon.sh
```

### 5. Switch Global `~/.claude/settings.json` Profile

Switch `~/.claude/settings.json` between **Cursor mode (`127.0.0.1:32125`)** and your **original gateway/Anthropic profile**, while preserving your existing `hooks`, `statusLine`, `permissions`, and other settings:

```bash
# Show active profile and daemon status
./switch-claude-config.sh status

# Toggle between 'cursor' and 'original' (default when called with no arguments)
./switch-claude-config.sh

# Explicitly switch to Cursor mode (and ensure the background daemon is running)
./switch-claude-config.sh cursor

# Explicitly restore your original profile (pass --kill-daemon to also stop the daemon)
./switch-claude-config.sh original
./switch-claude-config.sh original --kill-daemon
```

You can also run the proxy server in the foreground:

```bash
./bin/ccc.mjs serve --port 32125 --model composer-2.5
```

And connect from another terminal:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:32125 \
ANTHROPIC_AUTH_TOKEN=cursor-bridge \
ANTHROPIC_MODEL=composer-2.5 \
ANTHROPIC_SMALL_FAST_MODEL=composer-2.5 \
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
claude
```

## Context Window & Thinking Effort Inside Claude Code

Inside an interactive `claude` session, you can adjust both reasoning effort and context window tiers dynamically:

- **Thinking Effort**: Run `/effort low|medium|high|xhigh|max`, press `Alt+T` / `Option+T` to toggle extended thinking, or pass `--effort <level>`. `claude-code-cursor` maps Anthropic `output_config.effort` and `thinking` budgets directly onto Cursor's model reasoning variants.
- **Context Window & Max Mode**: Run `/model` inside Claude Code (or pass `--model`):
  - `grok-4.7-500k` — Cursor Max Mode (`500k` context)
  - `gemini-4-neon-1m[1m]` / `gemini-4-carbon-1m[1m]` — Cursor Max Mode (`1M` context, `[1m]` tells Claude Code's UI to unlock a 1M token meter)
  - Set `CLAUDE_CODE_MAX_CONTEXT_TOKENS` or `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` to customize auto-compaction thresholds.

## Development & Tests

```bash
bun test
bun run typecheck
```

## Acknowledgments

- Inspired by [Nomadcxx/opencode-cursor](https://github.com/Nomadcxx/opencode-cursor).
- Powered under the hood by [oakimov/cursor-opencode-provider](https://github.com/oakimov/cursor-opencode-provider) for Cursor Connect-RPC transport and tool continuation handling.

## License

Licensed under the [BSD 3-Clause License](./LICENSE).

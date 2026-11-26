# claude-code-cursor (`ccc`) — Use Cursor Subscription Models in Claude Code CLI

[![License: BSD-3-Clause](https://img.shields.io/badge/License-BSD_3--Clause-blue.svg)](./LICENSE)
[![Runtime: Bun >= 1.2](https://img.shields.io/badge/Bun-%3E%3D1.2-f9f1e1?logo=bun&logoColor=black)](https://bun.sh)
[![Protocol: Anthropic /v1/messages](https://img.shields.io/badge/API-Anthropic_%2Fv1%2Fmessages-d97757)](https://docs.anthropic.com)
[![Transport: Cursor Connect-RPC](https://img.shields.io/badge/Transport-HTTP%2F2_Connect--RPC-00A67E)](./llms.txt)
[![llms.txt](https://img.shields.io/badge/AI_Docs-llms.txt-purple)](./llms.txt)

**English** | [简体中文](./README.zh-CN.md)

**`claude-code-cursor` (`ccc`)** is an open-source, localhost **Anthropic Messages API (`/v1/messages`) proxy** that lets you run **Anthropic's Claude Code CLI (`claude`)** powered by models included in your **Cursor Pro, Business, or Enterprise subscription** (`composer-2.5`, `grok-4.7`, `gemini-4-carbon`, `gemini-4-neon`, `gemini-3.8-flash`, `kimi-k3`, and more).

Keep 100% of Claude Code's native agent harness — **interactive diff previews, tool permission prompts, `/effort` reasoning controls, Max Mode (`500k` / `1M` context), Skills, Hooks, Subagents (`Agent`), and MCP servers** — while routing model inference through Cursor's bidirectional **HTTP/2 Connect-RPC** protocol.

---

## Why `claude-code-cursor`?

Developers who already pay for Cursor often want to use **Claude Code (`claude` CLI)** as their terminal coding harness without paying separate per-token API bills or giving up Claude Code's permission model.

| Capability | `claude-code-cursor` (`ccc`) | `cursor-agent --print` Wrappers | `opencode-cursor` | Direct Anthropic API |
| :--- | :--- | :--- | :--- | :--- |
| **Frontend Harness** | **Claude Code CLI (`claude`)** | Custom / OpenCode | OpenCode | Claude Code CLI (`claude`) |
| **Uses Cursor Subscription** | **Yes** (Pro / Team / Enterprise) | Yes | Yes | No (separate billing) |
| **Works When `--print` Headless CLI Is Disabled by Enterprise Admin** | **Yes** (native HTTP/2 Connect-RPC) | **No** (blocked by team policy) | Depends on mode | N/A |
| **100% Safe File Edit Permissions** | **Yes** (held stream; Claude executes tools) | Risk of unapproved subprocess writes | OpenCode harness | Yes |
| **Dynamic `/effort` & Extended Thinking** | **Yes** (`low`/`medium`/`high`/`xhigh`/`max`) | Limited | Variant config | Yes |
| **Max Mode Context (`500k` / `1M`)** | **Yes** (`grok-4.7-500k`, `gemini-*-1m[1m]`) | Limited | Variant config | Tier-dependent |
| **Claude Skills, Hooks, Subagents & MCP** | **100% Native** | Partial / Broken | OpenCode plugins | 100% Native |

### Key Highlights

- **Zero API Keys Stored in Config**: Automatically reuses your existing `cursor-agent login` credentials from **macOS Keychain** with background JWT auto-refresh (or `ccc login` browser PKCE).
- **Enterprise-Ready (No `cursor-agent --print` Subprocess)**: Communicates over Cursor's HTTP/2 Connect-RPC agent stream, bypassing `"Your team administrator has disabled headless Cursor CLI usage"` restrictions cleanly.
- **No Unapproved Disk Mutations**: Pauses Cursor's run continuation while returning native Anthropic `tool_use` blocks so **Claude Code alone** prompts for permission and executes `Bash`, `Edit`, `Write`, `Read`, `Grep`, `Glob`, `Agent`, and `mcp__*` tools.
- **Lossless Tool Output Sanitization**: Strips Claude Code's `1→` line-number prefixes and `<system-reminder>` tags from `Read` results before sending context back to Cursor, preventing `Edit` `old_string` mismatches.
- **One-Command Profile Toggle**: Switch `~/.claude/settings.json` between **Cursor** and your **original Anthropic / LiteLLM gateway** anytime with `./switch-claude-config.sh`.

---

## Architecture: How It Works

```text
Claude Code CLI (`claude`)
  │  POST /v1/messages (Anthropic SSE, Claude tool vocabulary: Bash/Read/Edit/Write/Grep/Glob/Agent...)
  ▼
claude-code-cursor localhost proxy (src/server.ts — 127.0.0.1:32125)
  ├─ Auth Layer (src/auth.ts): Reads `cursor-agent login` token from macOS Keychain + auto-renews JWT
  ├─ Model Router (src/models.ts): Live Cursor catalog, `/effort` mapping, Max Mode (500k/1M), Haiku fast-routing
  ├─ Bidirectional Translator (src/translate/*):
  │    • Inbound: Claude Code tools & messages ──► Canonical OpenCode/Cursor tool schemas
  │    • Sanitizer: Strips Claude `Read` `1→` line numbers & formats ripgrep output previews
  │    • Outbound: Cursor tool-call / thinking / text ──► Native Claude `tool_use` + `thinking_delta` SSE
  ▼
Cursor Connect-RPC Backend (HTTP/2 bidirectional stream)
  └─ Held Run Continuation during tool execution: 100% of file edits & shell commands stay inside Claude Code.
```

---

## Quick Start

### 1. Prerequisites & Installation

Requires **[Bun](https://bun.sh)** (`>= 1.2`) and **[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)** (`claude`).

```bash
git clone https://github.com/zach-2077/claude-code-cursor.git
cd claude-code-cursor
bun install
bun run build
```

### 2. Authenticate with Cursor

If you already signed in via Cursor CLI (`cursor-agent`), **no extra login is needed**. Verify your session and list available models:

```bash
./bin/ccc.mjs status
./bin/ccc.mjs models
```

If not signed in yet, authenticate via either command:

```bash
cursor-agent login
# or use the built-in browser PKCE flow:
./bin/ccc.mjs login
```

### 3. Run Claude Code in One Command (Session-Scoped, Recommended)

`./bin/ccc.mjs` starts an ephemeral local proxy, passes `--settings` to `claude` for that terminal session only (leaving `~/.claude/settings.json` untouched), and stops the proxy automatically on exit:

```bash
# Launch interactive Claude Code with composer-2.5 (default)
./bin/ccc.mjs

# Launch with a specific Cursor model (e.g. grok-4.7, gemini-4-carbon, gemini-4-neon)
./bin/ccc.mjs --ccc-model grok-4.7

# Customize context window (Max Mode) & reasoning effort
./bin/ccc.mjs --ccc-model grok-4.7 --ccc-max --effort low
./bin/ccc.mjs --ccc-model "gemini-4-carbon[1m]" --effort high
./bin/ccc.mjs --ccc-model grok-4.7 --ccc-autocompact 200k

# Run a single non-interactive prompt (-p)
./bin/ccc.mjs -p "Summarize the architecture of this repository"
```

---

## Background Daemon & Global Config Switcher

If you want plain `claude` in **every terminal** to use Cursor models automatically:

### Start / Stop the Background Daemon

```bash
# Start background daemon on 127.0.0.1:32125 (logs to ~/.claude/cache/claude-code-cursor.log)
./start-daemon.sh

# Stop background daemon cleanly (unloads LaunchAgent if installed and frees port 32125)
./kill-daemon.sh
```

### Toggle `~/.claude/settings.json` Between Cursor and Original Mode

`./switch-claude-config.sh` backs up your existing `env` / `model` settings and switches between **Cursor (`127.0.0.1:32125`)** and your **original Anthropic or LiteLLM configuration**, while keeping `hooks`, `statusLine`, and `permissions` intact:

```bash
# Check active Claude Code profile and daemon health
./switch-claude-config.sh status

# Toggle between 'cursor' and 'original'
./switch-claude-config.sh

# Switch explicitly to Cursor mode (auto-starts daemon if needed)
./switch-claude-config.sh cursor

# Restore original profile (add --kill-daemon to also stop the background proxy)
./switch-claude-config.sh original
./switch-claude-config.sh original --kill-daemon
```

### Manual Environment Variables

You can also run the server in the foreground (`./bin/ccc.mjs serve --port 32125`) and connect manually:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:32125 \
ANTHROPIC_AUTH_TOKEN=cursor-bridge \
ANTHROPIC_MODEL=composer-2.5 \
ANTHROPIC_SMALL_FAST_MODEL=gemini-3.8-flash \
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
claude
```

---

## Changing Context Window (Max Mode) & Thinking Effort in Claude Code

Inside an interactive `claude` session, both **thinking effort** and **context window size** can be changed live without restarting the daemon:

1. **Thinking Effort (`/effort`)**:
   - Run `/effort low`, `/effort medium`, `/effort high`, `/effort xhigh`, or `/effort max` inside Claude Code (or press `Option+T` / `Alt+T`).
   - `claude-code-cursor` translates Anthropic `output_config.effort` and `thinking.budget_tokens` directly into Cursor's per-model reasoning variants.
2. **Max Mode Context Windows (`/model`)**:
   - `composer-2.5` — `200k` context window
   - `grok-4.7` (`256k`) / `grok-4.7-500k` (`500k` Cursor Max Mode)
   - `gemini-4-neon-1m[1m]` / `gemini-4-carbon-1m[1m]` (`1M` Cursor Max Mode; `[1m]` unlocks Claude Code's 1M UI context bar)
   - Tune auto-compaction anytime via `CLAUDE_CODE_MAX_CONTEXT_TOKENS` or `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`.

---

## Frequently Asked Questions (FAQ)

### Can I use my Cursor Pro or Enterprise subscription with Claude Code?
Yes. `claude-code-cursor` exposes a local Anthropic-compatible `/v1/messages` endpoint backed by your authenticated Cursor account, allowing `claude` CLI to run on Cursor's included models without a separate Anthropic API key.

### Does this fix `"Your team administrator has disabled headless Cursor CLI usage"`?
Yes. Enterprise Cursor teams frequently disable `cursor-agent --print` headless mode. Because `claude-code-cursor` speaks Cursor's HTTP/2 Connect-RPC protocol directly rather than shelling out to `cursor-agent --print`, it works seamlessly on enterprise accounts.

### Are my credentials or source code sent to any third-party proxy?
No. The proxy runs strictly on `127.0.0.1` on your own machine and connects directly to Cursor's official backend (`api2.cursor.sh`). Your tokens remain in macOS Keychain or `~/.local/share/opencode/auth.json`.

### Do Claude Code MCP servers, Skills, Hooks, and Subagents (`Agent`) still work?
Yes — 100% natively. Claude Code remains the outer orchestrator: MCP tools (`mcp__*`), `.claude/skills`, `hooks`, `TodoWrite`, and `Agent` subagents all execute inside Claude Code as usual.

---

## Development & Testing

```bash
bun test
bun run typecheck
```

For AI coding assistants and LLM indexers, see [`llms.txt`](./llms.txt).

## Acknowledgments

- Inspired by [Nomadcxx/opencode-cursor](https://github.com/Nomadcxx/opencode-cursor).
- Powered under the hood by [oakimov/cursor-opencode-provider](https://github.com/oakimov/cursor-opencode-provider) for Cursor Connect-RPC transport and held-stream continuation handling.

## License

Released under the [BSD 3-Clause License](./LICENSE).

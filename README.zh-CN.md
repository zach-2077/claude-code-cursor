# claude-code-cursor (`ccc`)

[English](./README.md) | 简体中文

用 **Claude Code (`claude` CLI)** 作为 Harness（工具循环、权限审批、Diff 预览、Skills、Hooks、MCP），底层直接调用 **Cursor 订阅提供的模型**（`composer-2.5`、`grok-4.7`、`gemini-4-carbon`、`gemini-4-neon`、`gemini-3.8-flash`、`kimi-k3` 等）。

## 工作原理

本项目在本地启动一个原生 **Anthropic Messages API (`/v1/messages`)** 代理网关，并在内部通过 `cursor-opencode-provider` 的 **HTTP/2 Connect-RPC 协议**与 Cursor Agent 后端双向流式通信：

```text
Claude Code (Harness)
  │  POST /v1/messages (Anthropic SSE, Claude 工具词表: Bash/Read/Edit/Write/Grep/Glob/Agent...)
  ▼
claude-code-cursor 本地代理 (src/server.ts)
  ├─ 鉴权层 (src/auth.ts): 自动复用 `cursor-agent login` 在 macOS Keychain 中的凭证并自动续期 JWT
  ├─ 路由层 (src/models.ts): 支持 Cursor 原生模型 ID、推理强度与 Max Mode 上下文变体，后台 Haiku 请求自动路由至快速模型
  ├─ 双向翻译层 (src/translate/*):
  │    • 入站: Claude Code tools/messages ──► Canonical OpenCode/Cursor 工具 Schema
  │    • 工具结果清洗: 自动剥离 Claude Read 的 `1→` 行号前缀、转换 ripgrep 行预览
  │    • 出站: Cursor tool-call / thinking / text ──► 还原为精确的 Claude Code tool_use 与 Anthropic SSE
  ▼
Cursor Connect-RPC (HTTP/2 双向流)
  └─ 工具执行期间挂起并保持心跳 (Held Run Continuation)，文件修改 100% 由 Claude Code 执行，无后台子进程越权写盘，且兼容禁用 `cursor-agent --print` 的企业团队账号。
```

## 快速开始

### 1. 安装与构建

需要安装 [Bun](https://bun.sh) (v1.2+) 与 Claude Code (`claude` CLI)。

```bash
cd claude-code-cursor
bun install
bun run build
```

### 2. 登录 Cursor（如果本机已登录过 `cursor-agent` 可直接跳过）

检查当前登录状态与可用模型：

```bash
./bin/ccc.mjs status
./bin/ccc.mjs models
```

若尚未登录，执行以下任一命令即可：

```bash
cursor-agent login
# 或使用内置浏览器 PKCE 登录：
./bin/ccc.mjs login
```

### 3. 一键启动 Claude Code（推荐）

`./bin/ccc.mjs` 会自动在空闲端口拉起本地代理，注入 `--settings`（覆盖 `~/.claude/settings.json` 中可能已有的网关配置，不修改原文件），并在退出时自动清理代理进程：

```bash
# 默认使用 composer-2.5 启动交互式 Claude Code
./bin/ccc.mjs

# 指定其他 Cursor 模型启动（如 grok-4.7 或 gemini-4-carbon）
./bin/ccc.mjs --ccc-model grok-4.7

# 调整上下文窗口 (Context Window) 与推理强度 (Thinking Effort)
./bin/ccc.mjs --ccc-model grok-4.7 --ccc-max --effort low
./bin/ccc.mjs --ccc-model "gemini-4-carbon[1m]" --effort high
./bin/ccc.mjs --ccc-model grok-4.7 --ccc-autocompact 200k

# 单次非交互运行 (-p)
./bin/ccc.mjs -p "总结当前项目的目录结构"
```

### 4. 后台常驻守护进程（Daemon 模式）

```bash
# 启动后台守护服务（默认监听 127.0.0.1:32125，写日志到 ~/.claude/cache/claude-code-cursor.log）
./start-daemon.sh

# 停止并彻底清理后台守护服务（同时卸载 LaunchAgent 防自动重启 + 释放端口）
./kill-daemon.sh
```

### 5. 一键切换全局 `~/.claude/settings.json` 配置

自动在 **Cursor 模式 (`127.0.0.1:32125`)** 与你原有的 **Original/LiteLLM 网关模式** 之间切换，同时保留 `hooks`、`statusLine`、`permissions` 等其他设置不变：

```bash
# 查看当前激活的配置与守护进程状态
./switch-claude-config.sh status

# 在 cursor <-> original 之间一键来回切换（不带参数即 toggle）
./switch-claude-config.sh

# 显式切到 Cursor 模式（并自动确保后台 daemon 已启动）
./switch-claude-config.sh cursor

# 显式切回原有配置（可选加 --kill-daemon 顺带停掉 Cursor 后台服务）
./switch-claude-config.sh original
./switch-claude-config.sh original --kill-daemon
```

也可以在前台独立运行网关服务：

```bash
./bin/ccc.mjs serve --port 32125 --model composer-2.5
```

然后在另一个终端连接：

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:32125 \
ANTHROPIC_AUTH_TOKEN=cursor-bridge \
ANTHROPIC_MODEL=composer-2.5 \
ANTHROPIC_SMALL_FAST_MODEL=composer-2.5 \
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
claude
```

## 在 Claude Code 内动态调整上下文窗口与推理强度

在交互式 `claude` 会话内可直接动态切换：

- **推理强度 (Thinking Effort)**：输入 `/effort low|medium|high|xhigh|max`、按 `Alt+T` / `Option+T` 开关深度思考，或启动时传 `--effort <level>`。网关会自动将 Anthropic 的 `output_config.effort` 与 `thinking` 参数映射到 Cursor 对应模型的推理变体。
- **上下文窗口与 Max Mode**：在会话内输入 `/model`（或启动传 `--model`）：
  - `grok-4.7-500k` — 开启 Cursor Max Mode（`500k` 上下文）
  - `gemini-4-neon-1m[1m]` / `gemini-4-carbon-1m[1m]` — 开启 Cursor Max Mode（`1M` 上下文，`[1m]` 后缀同时解锁 Claude Code 客户端 1M 上下文计量条）
  - 可通过 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 或 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 自定义自动压缩阈值。

## 测试

```bash
bun test
bun run typecheck
```

## 致谢

- 灵感来源于 [Nomadcxx/opencode-cursor](https://github.com/Nomadcxx/opencode-cursor)。
- 底层 Connect-RPC 传输与工具流续接基于 [oakimov/cursor-opencode-provider](https://github.com/oakimov/cursor-opencode-provider)。

## 许可证

基于 [BSD 3-Clause License](./LICENSE) 开源。

# claude-code-cursor (`ccc`) — 在 Claude Code CLI 中使用 Cursor 订阅模型

[![License: BSD-3-Clause](https://img.shields.io/badge/License-BSD_3--Clause-blue.svg)](./LICENSE)
[![Runtime: Bun >= 1.2](https://img.shields.io/badge/Bun-%3E%3D1.2-f9f1e1?logo=bun&logoColor=black)](https://bun.sh)
[![Protocol: Anthropic /v1/messages](https://img.shields.io/badge/API-Anthropic_%2Fv1%2Fmessages-d97757)](https://docs.anthropic.com)
[![Transport: Cursor Connect-RPC](https://img.shields.io/badge/Transport-HTTP%2F2_Connect--RPC-00A67E)](./llms.txt)
[![llms.txt](https://img.shields.io/badge/AI_Docs-llms.txt-purple)](./llms.txt)

[English](./README.md) | **简体中文**

**`claude-code-cursor` (`ccc`)** 是一个开源的本地 **Anthropic Messages API (`/v1/messages`) 转换网关**，让你直接以 **Claude Code CLI (`claude`)** 作为终端编程 Agent 外壳（Harness），底层无缝调用 **Cursor Pro / Business / Enterprise 订阅内包含的大模型**（`composer-2.5`、`grok-4.7`、`gemini-4-carbon`、`gemini-4-neon`、`gemini-3.8-flash`、`kimi-k3` 等）。

完整保留 Claude Code 原生的**工具权限审批、Diff 预览、`/effort` 推理强度调节、Max Mode 超长上下文（`500k` / `1M`）、Skills、Hooks、Subagents (`Agent`) 与 MCP 服务**，同时通过 **HTTP/2 Connect-RPC** 双向流协议与 Cursor 官方后端直连通信。

---

## 为什么选择 `claude-code-cursor`？

许多开发者已经订阅了 Cursor，但更喜欢 **Claude Code (`claude` CLI)** 的终端交互体验、Skills 生态和严格的权限审批机制。

| 能力对比 | `claude-code-cursor` (`ccc`) | `cursor-agent --print` 命令行封装 | `opencode-cursor` | 官方 Anthropic API |
| :--- | :--- | :--- | :--- | :--- |
| **前端交互外壳 (Harness)** | **Claude Code CLI (`claude`)** | 自定义 / OpenCode | OpenCode | Claude Code CLI (`claude`) |
| **复用 Cursor 订阅额度** | **支持**（个人 / 团队 / 企业版） | 支持 | 支持 | 不支持（按 Token 另计费） |
| **兼容禁用 `--print` 的企业账号** | **完美支持**（原生 HTTP/2 Connect-RPC） | **不支持**（会被企业策略拦截） | 视模式而定 | 不涉及 |
| **100% 安全的文件修改审批** | **支持**（挂起流续接，工具全由 Claude 执行） | 存在后台子进程越权写盘风险 | OpenCode 托管 | 支持 |
| **动态 `/effort` 与深度思考** | **支持**（`low`/`medium`/`high`/`xhigh`/`max`） | 受限 | 静态变体配置 | 支持 |
| **Max Mode 大上下文 (`500k`/`1M`)** | **支持**（`grok-4.7-500k`、`gemini-*-1m[1m]`） | 受限 | 静态变体配置 | 视账号等级而定 |
| **Claude Skills / Hooks / MCP / 子代理** | **100% 原生兼容** | 部分兼容 | OpenCode 插件体系 | 100% 原生兼容 |

### 核心特性

- **零明文密钥配置**：自动读取本机 `cursor-agent login` 保存在 **macOS Keychain** 中的凭证并自动续期 JWT（也支持 `./bin/ccc.mjs login` 浏览器 PKCE 登录）。
- **企业团队账号开箱即用**：不依赖 `cursor-agent --print` 无头子进程，彻底绕开企业管理员禁用无头 CLI（`"Your team administrator has disabled headless Cursor CLI usage"`）的限制。
- **杜绝越权改文件**：在工具调用阶段挂起 Connect-RPC 流并返回标准 Anthropic `tool_use` 事件，`Bash`、`Edit`、`Write`、`Read`、`Grep`、`Glob`、`Agent` 与 `mcp__*` 100% 由 Claude Code 审批并执行。
- **无损工具输出清洗**：自动剥离 Claude `Read` 返回的 `1→` 行号前缀与 `<system-reminder>` 标签，彻底避免模型生成 `Edit` `old_string` 时因行号污染而匹配失败。
- **一键双配置切换**：提供 `./switch-claude-config.sh`，随时在 **Cursor 模式** 与原有的 **Anthropic / LiteLLM 网关配置** 之间无损切换。

---

## 架构原理

```text
Claude Code CLI (`claude`)
  │  POST /v1/messages (Anthropic SSE, Claude 工具词表: Bash/Read/Edit/Write/Grep/Glob/Agent...)
  ▼
claude-code-cursor 本地代理 (src/server.ts — 127.0.0.1:32125)
  ├─ 鉴权层 (src/auth.ts): 自动复用 `cursor-agent login` 在 macOS Keychain 中的凭证并自动续期 JWT
  ├─ 路由层 (src/models.ts): 动态拉取模型目录、映射 `/effort` 推理强度与 Max Mode (500k/1M)、Haiku 快速路由
  ├─ 双向翻译层 (src/translate/*):
  │    • 入站: Claude Code tools/messages ──► Canonical OpenCode/Cursor 工具 Schema
  │    • 工具结果清洗: 自动剥离 Claude Read 的 `1→` 行号前缀、转换 ripgrep 行预览
  │    • 出站: Cursor tool-call / thinking / text ──► 还原为精确的 Claude `tool_use` 与 Anthropic SSE
  ▼
Cursor Connect-RPC (HTTP/2 双向流)
  └─ 工具执行期间挂起并保持心跳 (Held Run Continuation)，文件修改与命令执行 100% 留在 Claude Code 内。
```

---

## 快速开始

### 1. 环境准备与安装

需要安装 **[Bun](https://bun.sh)** (`>= 1.2`) 与 **Claude Code CLI** (`claude`)。

```bash
git clone https://github.com/zach-2077/claude-code-cursor.git
cd claude-code-cursor
bun install
bun run build
```

### 2. 登录 Cursor（已登录过 `cursor-agent` 可直接跳过）

检查当前登录状态与可用模型列表：

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

### 3. 一键启动 Claude Code（单次会话隔离，推荐）

`./bin/ccc.mjs` 会在空闲端口拉起本地网关，仅对当前会话注入 `--settings`（不改动全局 `~/.claude/settings.json`），退出后自动清理进程：

```bash
# 默认使用 composer-2.5 启动交互式 Claude Code
./bin/ccc.mjs

# 指定其他 Cursor 模型启动（如 grok-4.7、gemini-4-carbon、gemini-4-neon）
./bin/ccc.mjs --ccc-model grok-4.7

# 调整上下文窗口 (Max Mode) 与推理强度 (Thinking Effort)
./bin/ccc.mjs --ccc-model grok-4.7 --ccc-max --effort low
./bin/ccc.mjs --ccc-model "gemini-4-carbon[1m]" --effort high
./bin/ccc.mjs --ccc-model grok-4.7 --ccc-autocompact 200k

# 单次非交互运行 (-p)
./bin/ccc.mjs -p "总结当前仓库的架构设计"
```

---

## 后台常驻守护进程与全局配置切换

如果你希望在任意终端直接输入 `claude` 即可默认使用 Cursor 模型：

### 启动 / 停止后台守护进程（Daemon 模式）

```bash
# 启动后台守护服务（默认监听 127.0.0.1:32125，日志输出至 ~/.claude/cache/claude-code-cursor.log）
./start-daemon.sh

# 停止并彻底清理后台守护服务（自动卸载 LaunchAgent 防重启并释放 32125 端口）
./kill-daemon.sh
```

### 一键切换全局 `~/.claude/settings.json`

`./switch-claude-config.sh` 会自动备份你原有的网关配置，在 **Cursor 模式 (`127.0.0.1:32125`)** 与 **原有 Anthropic / LiteLLM 模式** 之间一键切换，同时完整保留 `hooks`、`statusLine`、`permissions` 等自定义设置：

```bash
# 查看当前激活的配置档案与守护进程状态
./switch-claude-config.sh status

# 在 cursor <-> original 之间一键来回切换
./switch-claude-config.sh

# 显式切到 Cursor 模式（若守护进程未运行会自动拉起）
./switch-claude-config.sh cursor

# 显式恢复原有配置（加 --kill-daemon 可同时停掉 Cursor 后台服务）
./switch-claude-config.sh original
./switch-claude-config.sh original --kill-daemon
```

### 手动环境变量连接方式

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:32125 \
ANTHROPIC_AUTH_TOKEN=cursor-bridge \
ANTHROPIC_MODEL=composer-2.5 \
ANTHROPIC_SMALL_FAST_MODEL=gemini-3.8-flash \
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
claude
```

---

## 在 Claude Code 内动态调整上下文窗口与推理强度

在交互式 `claude` 会话内无需重启网关即可实时切换：

1. **推理强度 (`/effort`)**：
   - 直接输入 `/effort low`、`/effort medium`、`/effort high`、`/effort xhigh` 或 `/effort max`（或按 `Option+T` / `Alt+T` 开关扩展思考）。
   - 网关会自动将 Anthropic 的 `output_config.effort` 与 `thinking.budget_tokens` 映射为对应 Cursor 模型的推理变体。
2. **上下文窗口与 Max Mode (`/model`)**：
   - `composer-2.5` — `200k` 上下文
   - `grok-4.7` (`256k`) / `grok-4.7-500k`（开启 Cursor `500k` Max Mode）
   - `gemini-4-neon-1m[1m]` / `gemini-4-carbon-1m[1m]`（开启 Cursor `1M` Max Mode，`[1m]` 后缀同时解锁 Claude Code 客户端 1M 上下文进度条）
   - 可通过 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 或 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 自定义自动压缩阈值。

---

## 常见问题 (FAQ)

### 可以直接用 Cursor Pro 或企业版订阅跑 Claude Code 吗？
可以。`claude-code-cursor` 在本地提供兼容 Anthropic `/v1/messages` 的接口并复用你的 Cursor 登录态，无需单独购买 Anthropic API Key。

### 企业管理员禁用了 `cursor-agent --print` 还能用吗？
可以。许多企业团队会报错 `"Your team administrator has disabled headless Cursor CLI usage"`，本项目直接走 HTTP/2 Connect-RPC 协议而非调用 `cursor-agent --print` 子进程，因此在企业账号下完全正常可用。

### 我的代码或密钥会经过第三方服务器吗？
不会。代理仅监听本机回环地址 `127.0.0.1` 并直连 Cursor 官方接口（`api2.cursor.sh`），凭证只保存在本机 Keychain 或本地目录中。

### Claude Code 的 MCP、Skills、Hooks 和子代理 (`Agent`) 还能正常用吗？
100% 原生可用。所有编排逻辑仍在 Claude Code 本地运行，MCP 工具（`mcp__*`）、Skills、Hooks 和子代理均不受影响。

---

## 开发与测试

```bash
bun test
bun run typecheck
```

面向 AI 搜索引擎与代码索引器的结构化文档请参阅 [`llms.txt`](./llms.txt)。

## 致谢

- 灵感来源于 [Nomadcxx/opencode-cursor](https://github.com/Nomadcxx/opencode-cursor)。
- 底层 Connect-RPC 传输与工具流挂起续接基于 [oakimov/cursor-opencode-provider](https://github.com/oakimov/cursor-opencode-provider)。

## 许可证

基于 [BSD 3-Clause License](./LICENSE) 开源。

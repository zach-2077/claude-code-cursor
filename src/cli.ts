import { spawn } from "node:child_process";
import { CursorCredentialManager } from "./auth.js";
import { parseTokenCountSpec, resolveConfig } from "./config.js";
import {
  CursorModelRegistry,
  getModelContextWindows,
  getModelSupportedEfforts,
} from "./models.js";
import { startProxyServer } from "./server.js";

const ALL_CLAUDE_CAPABILITIES =
  "effort,xhigh_effort,max_effort,thinking,adaptive_thinking,interleaved_thinking";

function formatTokensCompact(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) {
    return `${tokens / 1_000_000}m`;
  }
  return `${Math.round(tokens / 1_000)}k`;
}

function printHelp(): void {
  console.log(`claude-code-cursor (ccc) — Use Cursor-provided models with Claude Code as harness

Usage:
  ccc [options] [claude-args...]        Start local proxy + launch Claude Code directly
  ccc serve [options]                   Run standalone Anthropic /v1/messages proxy server
  ccc models                            List Cursor models, context tiers, and effort levels
  ccc status                            Check Cursor authentication and active model mapping
  ccc login                             Sign in to Cursor via browser PKCE OAuth

Model, Context Window & Thinking Effort options:
  --ccc-model <id>                      Primary Cursor model (e.g. composer-2.5, grok-4.7, gemini-4-carbon[1m])
  --ccc-opus-model <id>                 Cursor model mapped to Claude's \`opus\` alias
  --ccc-fast-model <id>                 Fast Cursor model mapped to Claude's \`haiku\` alias
  --ccc-effort <level>                  Default thinking effort: low | medium | high | xhigh | max | none
                                        (Inside CC you can also use \`/effort\` or \`--effort <level>\` live!)
  --ccc-max                             Enable Cursor Max Mode context tier (e.g. 500k on Grok 4.7, 1M on Gemini 4)
  --ccc-ctx <tokens>                    Set context window (e.g. 200k, 256k, 300k, 500k, 1m) for both Cursor & CC
  --ccc-autocompact <tokens>            Set Claude Code auto-compaction threshold (CLAUDE_CODE_AUTO_COMPACT_WINDOW)
  --ccc-debug                           Enable verbose request, variant, and tool-translation logs

Environment variables:
  CCC_MODEL, CCC_OPUS_MODEL, CCC_FAST_MODEL, CCC_EFFORT, CCC_MAX_MODE, CCC_CTX, CCC_AUTOCOMPACT, CCC_PORT

Examples:
  ccc                                                 # composer-2.5 (200k ctx)
  ccc --ccc-model grok-4.7 --effort low               # grok-4.7 (256k ctx, low reasoning effort)
  ccc --ccc-model grok-4.7 --ccc-max --effort xhigh   # grok-4.7 (500k max-mode ctx, xhigh effort)
  ccc --ccc-model gemini-4-carbon[1m] --effort high   # gemini-4-carbon (1M max-mode ctx, high effort)
`);
}

export interface ParsedCliOptions {
  subcommand: "claude" | "serve" | "models" | "status" | "login" | "help";
  port?: number;
  model?: string;
  opusModel?: string;
  fastModel?: string;
  effort?: string;
  maxMode?: boolean;
  contextTokens?: number;
  autoCompactWindow?: number;
  debug?: boolean;
  claudeArgs: string[];
}

export function parseCliArgs(argv: string[]): ParsedCliOptions {
  const first = argv[0];
  if (first === "--help" || first === "-h" || first === "help") {
    return { subcommand: "help", claudeArgs: [] };
  }

  if (first === "models" || first === "status" || first === "login") {
    return { subcommand: first, claudeArgs: argv.slice(1) };
  }

  if (first === "serve") {
    let port: number | undefined;
    let model: string | undefined;
    let opusModel: string | undefined;
    let fastModel: string | undefined;
    let effort: string | undefined;
    let maxMode: boolean | undefined;
    let contextTokens: number | undefined;
    let debug: boolean | undefined;
    const rest = argv.slice(1);
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]!;
      if ((arg === "--port" || arg === "-p") && rest[i + 1]) {
        port = Number(rest[++i]);
      } else if ((arg === "--model" || arg === "-m" || arg === "--ccc-model") && rest[i + 1]) {
        model = rest[++i];
      } else if ((arg === "--opus-model" || arg === "--ccc-opus-model") && rest[i + 1]) {
        opusModel = rest[++i];
      } else if ((arg === "--fast-model" || arg === "--ccc-fast-model") && rest[i + 1]) {
        fastModel = rest[++i];
      } else if ((arg === "--effort" || arg === "--ccc-effort") && rest[i + 1]) {
        effort = rest[++i];
      } else if (arg === "--max" || arg === "--ccc-max") {
        maxMode = true;
      } else if ((arg === "--ctx" || arg === "--ccc-ctx") && rest[i + 1]) {
        contextTokens = parseTokenCountSpec(rest[++i]);
      } else if (arg === "--debug" || arg === "--ccc-debug") {
        debug = true;
      } else if (arg === "--help" || arg === "-h") {
        return { subcommand: "help", claudeArgs: [] };
      }
    }
    return {
      subcommand: "serve",
      port,
      model,
      opusModel,
      fastModel,
      effort,
      maxMode,
      contextTokens,
      debug,
      claudeArgs: [],
    };
  }

  const rawArgs = first === "claude" ? argv.slice(1) : argv;
  let model: string | undefined;
  let opusModel: string | undefined;
  let fastModel: string | undefined;
  let effort: string | undefined;
  let maxMode: boolean | undefined;
  let contextTokens: number | undefined;
  let autoCompactWindow: number | undefined;
  let debug: boolean | undefined;
  const claudeArgs: string[] = [];

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i]!;
    if (arg === "--ccc-model" && rawArgs[i + 1]) {
      model = rawArgs[++i];
    } else if (arg === "--ccc-opus-model" && rawArgs[i + 1]) {
      opusModel = rawArgs[++i];
    } else if (arg === "--ccc-fast-model" && rawArgs[i + 1]) {
      fastModel = rawArgs[++i];
    } else if (arg === "--ccc-effort" && rawArgs[i + 1]) {
      effort = rawArgs[++i];
    } else if (arg === "--ccc-max") {
      maxMode = true;
    } else if (arg === "--ccc-ctx" && rawArgs[i + 1]) {
      contextTokens = parseTokenCountSpec(rawArgs[++i]);
    } else if (arg === "--ccc-autocompact" && rawArgs[i + 1]) {
      autoCompactWindow = parseTokenCountSpec(rawArgs[++i]);
    } else if (arg === "--ccc-debug") {
      debug = true;
    } else {
      if ((arg === "--model" || arg === "-m") && rawArgs[i + 1] && !model) {
        model = rawArgs[i + 1];
      }
      claudeArgs.push(arg);
    }
  }

  return {
    subcommand: "claude",
    model,
    opusModel,
    fastModel,
    effort,
    maxMode,
    contextTokens,
    autoCompactWindow,
    debug,
    claudeArgs,
  };
}

async function runStatus(): Promise<void> {
  const config = resolveConfig();
  const auth = new CursorCredentialManager(config.dataDir);
  console.log("claude-code-cursor status");
  console.log("─────────────────────────");
  try {
    const creds = await auth.resolveInitial();
    const expStr = creds.expiresAtMs ? new Date(creds.expiresAtMs).toISOString() : "unknown";
    console.log(`Auth:          OK (${creds.source})`);
    if (creds.subject) {
      console.log(`Account sub:   ${creds.subject}`);
    }
    console.log(`Token expiry:  ${expStr}`);
    const models = new CursorModelRegistry(
      {
        defaultModel: config.defaultModel,
        opusModel: config.opusModel,
        fastModel: config.fastModel,
        defaultEffort: config.defaultEffort,
        maxMode: config.maxMode,
        contextTokensOverride: config.contextTokensOverride,
      },
      undefined,
      config.cacheDir,
    );
    const token = await auth.getAccessToken();
    const catalog = await models.refresh(token, false);
    const resolved = models.resolve(config.defaultModel);
    console.log(`Models found:  ${catalog.length}`);
    console.log(
      `Default model: ${config.defaultModel} -> ${resolved.wireModelId} (ctx=${formatTokensCompact(resolved.contextWindowTokens)}, maxMode=${resolved.maxMode})`,
    );
    console.log(`Fast model:    ${config.fastModel} -> ${models.resolve(config.fastModel).wireModelId}`);
  } catch (err) {
    console.error(`Auth:          MISSING (${err instanceof Error ? err.message : String(err)})`);
    process.exitCode = 1;
  }
}

async function runModels(): Promise<void> {
  const config = resolveConfig();
  const auth = new CursorCredentialManager(config.dataDir);
  const token = await auth.getAccessToken();
  const registry = new CursorModelRegistry(config.defaultModel, config.fastModel, config.cacheDir);
  const catalog = await registry.refresh(token, true);

  console.log(`Available Cursor models (${catalog.length}):\n`);
  for (const m of catalog) {
    const windows = getModelContextWindows(m);
    const ctxLabel = windows.tiers.map(formatTokensCompact).join(" / ");
    const efforts = getModelSupportedEfforts(m);
    const effortLabel = efforts.length > 0 ? `efforts=[${efforts.join(", ")}]` : "efforts=[fixed]";
    const thinking = m.supportsThinking ? "thinking=yes" : "thinking=no";
    console.log(
      `  ${m.id.padEnd(26)} ${(m.displayName ?? "").padEnd(24)} ctx=[${ctxLabel}]  ${effortLabel}  (${thinking})`,
    );
  }
}

async function runLogin(): Promise<void> {
  const config = resolveConfig();
  const auth = new CursorCredentialManager(config.dataDir);
  console.log("Starting Cursor browser PKCE login...");
  const creds = await auth.interactiveBrowserLogin((url) => {
    console.log(`\nOpen this URL in your browser to sign in:\n  ${url}\n`);
    if (process.platform === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    }
  });
  console.log(`Logged in successfully (saved to ${config.dataDir}/auth.json, sub=${creds.subject ?? "ok"}).`);
}

async function runServe(opts: ParsedCliOptions): Promise<void> {
  const proxy = await startProxyServer({
    port: opts.port,
    defaultModel: opts.model,
    opusModel: opts.opusModel,
    fastModel: opts.fastModel,
    defaultEffort: opts.effort,
    maxMode: opts.maxMode,
    contextTokensOverride: opts.contextTokens,
    debug: opts.debug,
    workspaceRoot: process.cwd(),
  });

  const resolvedDefault = proxy.models.resolve(proxy.config.defaultModel);

  console.log(`claude-code-cursor proxy listening on ${proxy.baseUrl}`);
  console.log(
    `  Default model : ${proxy.config.defaultModel} -> ${resolvedDefault.wireModelId} (ctx=${formatTokensCompact(resolvedDefault.contextWindowTokens)}, maxMode=${resolvedDefault.maxMode})`,
  );
  console.log(`  Opus alias    : ${proxy.config.opusModel}`);
  console.log(`  Haiku alias   : ${proxy.config.fastModel}`);
  if (proxy.config.defaultEffort) {
    console.log(`  Default effort: ${proxy.config.defaultEffort}`);
  }
  console.log(`  Workspace     : ${proxy.config.workspaceRoot}\n`);
  console.log(`Run Claude Code in another terminal with:`);
  console.log(`  ANTHROPIC_BASE_URL=${proxy.baseUrl} \\`);
  console.log(`  ANTHROPIC_AUTH_TOKEN=cursor-bridge \\`);
  console.log(`  ANTHROPIC_MODEL=sonnet \\`);
  console.log(`  ANTHROPIC_DEFAULT_SONNET_MODEL='${proxy.config.defaultModel}' \\`);
  console.log(`  ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES='${ALL_CLAUDE_CAPABILITIES}' \\`);
  console.log(`  ANTHROPIC_DEFAULT_HAIKU_MODEL='${proxy.config.fastModel}' \\`);
  console.log(`  CLAUDE_CODE_MAX_CONTEXT_TOKENS=${resolvedDefault.contextWindowTokens} \\`);
  console.log(`  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \\`);
  console.log(`  claude`);

  const shutdown = async () => {
    await proxy.stop();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function runClaudeWithProxy(opts: ParsedCliOptions): Promise<void> {
  const proxy = await startProxyServer({
    port: 0,
    defaultModel: opts.model,
    opusModel: opts.opusModel,
    fastModel: opts.fastModel,
    defaultEffort: opts.effort,
    maxMode: opts.maxMode,
    contextTokensOverride: opts.contextTokens,
    autoCompactWindow: opts.autoCompactWindow,
    debug: opts.debug,
    workspaceRoot: process.cwd(),
  });

  const claudeBin = process.env.CLAUDE_BIN?.trim() || "claude";
  const resolvedDefault = proxy.models.resolve(proxy.config.defaultModel);
  const resolvedOpus = proxy.models.resolve(proxy.config.opusModel);

  // Strip bracket parameters in the ID sent to Claude Code so Claude Code's own
  // `[1m]` parser doesn't conflict with `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, while
  // keeping full bracketed config inside `proxy.models`!
  const sonnetWireId = resolvedDefault.wireModelId;
  const opusWireId = resolvedOpus.wireModelId;
  const haikuWireId = proxy.models.resolve(proxy.config.fastModel).wireModelId;

  const sonnetLabel = `${sonnetWireId} (${formatTokensCompact(resolvedDefault.contextWindowTokens)}${resolvedDefault.maxMode ? ", max" : ""})`;
  const opusLabel = `${opusWireId} (${formatTokensCompact(resolvedOpus.contextWindowTokens)}${resolvedOpus.maxMode ? ", max" : ""})`;

  const sonnetClaudeId =
    resolvedDefault.contextWindowTokens >= 1_000_000 ? `${sonnetWireId}[1m]` : sonnetWireId;
  const opusClaudeId =
    resolvedOpus.contextWindowTokens >= 1_000_000 ? `${opusWireId}[1m]` : opusWireId;

  const envOverrides: Record<string, string> = {
    ANTHROPIC_BASE_URL: proxy.baseUrl,
    ANTHROPIC_AUTH_TOKEN: "cursor-bridge",
    // Start on `sonnet` pinned to the chosen Cursor model + capabilities so `/effort`,
    // `/model`, thinking toggles (`Option+T`), and `ultrathink` all unlock natively in CC!
    ANTHROPIC_MODEL: "sonnet",
    ANTHROPIC_DEFAULT_SONNET_MODEL: sonnetClaudeId,
    ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: `Cursor: ${sonnetLabel}`,
    ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION: `Cursor model ${sonnetWireId} via claude-code-cursor`,
    ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES: ALL_CLAUDE_CAPABILITIES,
    ANTHROPIC_DEFAULT_OPUS_MODEL: opusClaudeId,
    ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: `Cursor: ${opusLabel}`,
    ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION: `Cursor model ${opusWireId} via claude-code-cursor`,
    ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES: ALL_CLAUDE_CAPABILITIES,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: haikuWireId,
    ANTHROPIC_SMALL_FAST_MODEL: haikuWireId,
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(resolvedDefault.contextWindowTokens),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };

  if (proxy.config.autoCompactWindow) {
    envOverrides.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(proxy.config.autoCompactWindow);
  }
  if (proxy.config.defaultEffort) {
    envOverrides.CLAUDE_CODE_EFFORT_LEVEL = proxy.config.defaultEffort;
  }

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...envOverrides,
  };
  delete childEnv.ANTHROPIC_API_KEY;

  const finalArgs = [...opts.claudeArgs];
  if (!finalArgs.includes("--settings")) {
    const inlineSettings: Record<string, unknown> = {
      env: envOverrides,
      model: "sonnet",
    };
    if (proxy.config.defaultEffort && proxy.config.defaultEffort !== "max" && proxy.config.defaultEffort !== "none") {
      inlineSettings.effortLevel = proxy.config.defaultEffort;
    }
    finalArgs.unshift("--settings", JSON.stringify(inlineSettings));
  }

  if (proxy.config.debug) {
    console.error(
      `[ccc] Started proxy at ${proxy.baseUrl} -> model=${sonnetWireId}, ctx=${resolvedDefault.contextWindowTokens}, maxMode=${resolvedDefault.maxMode}, effort=${proxy.config.defaultEffort ?? "cc-controlled"}`,
    );
  }

  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(claudeBin, finalArgs, {
      stdio: "inherit",
      env: childEnv,
      cwd: process.cwd(),
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal) {
        resolve(128);
      } else {
        resolve(code ?? 0);
      }
    });
  }).finally(async () => {
    await proxy.stop();
  });

  process.exit(exitCode);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const opts = parseCliArgs(argv);
  switch (opts.subcommand) {
    case "help":
      printHelp();
      return;
    case "status":
      await runStatus();
      return;
    case "models":
      await runModels();
      return;
    case "login":
      await runLogin();
      return;
    case "serve":
      await runServe(opts);
      return;
    case "claude":
      await runClaudeWithProxy(opts);
      return;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[ccc] Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

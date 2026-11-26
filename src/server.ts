import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { CursorCredentialManager } from "./auth.js";
import { ConnectRpcCursorBackend } from "./backends/connect-rpc.js";
import type { CursorBackend } from "./backends/types.js";
import { resolveConfig, type ProxyServerConfig } from "./config.js";
import { CursorModelRegistry, type ResolvedCursorModel } from "./models.js";
import type { AnthropicMessagesRequest } from "./translate/anthropic-types.js";
import {
  deriveSessionId,
  extractWorkspaceFromSystem,
  flattenSystemPrompt,
  translateAnthropicToV3Prompt,
} from "./translate/prompt.js";
import {
  collectV3StreamToAnthropicResponse,
  v3StreamToAnthropicSse,
} from "./translate/stream.js";
import { createToolTranslationRegistry } from "./translate/tools.js";

export interface RunningProxyServer {
  readonly port: number;
  readonly host: string;
  readonly baseUrl: string;
  readonly config: ProxyServerConfig;
  readonly models: CursorModelRegistry;
  readonly auth: CursorCredentialManager;
  stop(): Promise<void>;
}

export interface CreateServerDeps {
  backend?: CursorBackend;
  auth?: CursorCredentialManager;
  models?: CursorModelRegistry;
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendAnthropicError(
  res: http.ServerResponse,
  status: number,
  errorType: string,
  message: string,
): void {
  sendJson(res, status, {
    type: "error",
    error: {
      type: errorType,
      message,
    },
  });
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

const ROUTED_MODELS_LOG = path.join(os.homedir(), ".claude", "cache", "routed-models.jsonl");

async function recordRoutedModelCapture(resolved: ResolvedCursorModel, isMainTurn: boolean): Promise<void> {
  if (!isMainTurn) return;
  try {
    const ctxStr =
      resolved.contextWindowTokens >= 1_000_000 && resolved.contextWindowTokens % 1_000_000 === 0
        ? `${resolved.contextWindowTokens / 1_000_000}m`
        : `${Math.round(resolved.contextWindowTokens / 1_000)}k`;
    const parts = [`cursor`, ctxStr];
    if (resolved.resolvedEffort) parts.push(resolved.resolvedEffort);
    if (resolved.maxMode) parts.push("max");
    const line =
      JSON.stringify({
        ts: Date.now() / 1000,
        "x-litellm-model-name": resolved.wireModelId,
        "x-litellm-complexity-router-tier": parts.join(" · "),
      }) + "\n";
    await fs.appendFile(ROUTED_MODELS_LOG, line, "utf8");
  } catch {
    // Non-fatal if ~/.claude/cache doesn't exist
  }
}

export function estimateAnthropicInputTokens(body: AnthropicMessagesRequest): number {
  let chars = 0;
  const sys = flattenSystemPrompt(body.system);
  if (sys) chars += sys.length;
  for (const msg of body.messages ?? []) {
    if (!msg) continue;
    if (typeof msg.content === "string") {
      chars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      chars += JSON.stringify(msg.content).length;
    }
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    chars += JSON.stringify(body.tools).length;
  }
  return Math.max(1, Math.ceil(chars / 3.8));
}

export async function startProxyServer(
  configOverrides: Partial<ProxyServerConfig> = {},
  deps: CreateServerDeps = {},
): Promise<RunningProxyServer> {
  const config = resolveConfig(configOverrides);
  const auth = deps.auth ?? new CursorCredentialManager(config.dataDir);
  const models =
    deps.models ??
    new CursorModelRegistry(
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
  const backend = deps.backend ?? new ConnectRpcCursorBackend(config, auth);

  // Best-effort warm model discovery if not using a mock backend
  if (!deps.backend) {
    try {
      const token = await auth.getAccessToken();
      await models.refresh(token, false);
    } catch (err) {
      if (config.debug) {
        console.error("[ccc] Warm model discovery skipped:", err instanceof Error ? err.message : err);
      }
    }
  }

  const debugLog = (msg: string, meta?: Record<string, unknown>) => {
    if (!config.debug) return;
    console.error(`[ccc] ${msg}`, meta ? JSON.stringify(meta) : "");
  };

  const server = http.createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${config.host}`);
    const pathname = url.pathname;

    try {
      // Health check
      if (method === "GET" && pathname === "/health") {
        let authSource: string | null = null;
        try {
          const creds = await auth.resolveInitial();
          authSource = creds.source;
        } catch {
          authSource = null;
        }
        sendJson(res, 200, {
          ok: true,
          service: "claude-code-cursor",
          backend: backend.name,
          defaultModel: config.defaultModel,
          fastModel: config.fastModel,
          workspaceRoot: config.workspaceRoot,
          authSource,
          modelCount: models.getCatalog().length,
        });
        return;
      }

      // Silence Claude Code telemetry / event batch endpoints cleanly
      if (pathname.startsWith("/api/event_logging") || pathname === "/v1/telemetry") {
        sendJson(res, 200, { ok: true });
        return;
      }

      // Model catalog endpoint
      if (method === "GET" && (pathname === "/v1/models" || pathname === "/models")) {
        if (!models.isLoaded() && !deps.backend) {
          const token = await auth.getAccessToken();
          await models.refresh(token, false);
        }
        const nowIso = new Date().toISOString();
        const data = models.getCatalog().map((m) => ({
          type: "model",
          id: m.id,
          display_name: m.displayName ?? m.id,
          created_at: nowIso,
        }));
        sendJson(res, 200, {
          data,
          has_more: false,
          first_id: data[0]?.id ?? null,
          last_id: data[data.length - 1]?.id ?? null,
        });
        return;
      }

      // Token counting endpoint used by Claude Code for context management
      if (
        method === "POST" &&
        (pathname === "/v1/messages/count_tokens" || pathname === "/messages/count_tokens")
      ) {
        const body = (await readJsonBody(req)) as AnthropicMessagesRequest;
        const inputTokens = estimateAnthropicInputTokens(body);
        sendJson(res, 200, { input_tokens: inputTokens });
        return;
      }

      // Main Anthropic Messages endpoint
      if (method === "POST" && (pathname === "/v1/messages" || pathname === "/messages")) {
        const body = (await readJsonBody(req)) as AnthropicMessagesRequest;
        if (!body || !Array.isArray(body.messages)) {
          sendAnthropicError(res, 400, "invalid_request_error", "`messages` array is required.");
          return;
        }

        if (!models.isLoaded() && !deps.backend) {
          try {
            const token = await auth.getAccessToken();
            await models.refresh(token, false);
          } catch {
            // Let streamTurn surface auth errors if credentials are missing
          }
        }

        const resolvedModel = models.resolve({
          requestedModel: body.model,
          effort: body.output_config?.effort,
          thinking: body.thinking,
        });
        const systemText = flattenSystemPrompt(body.system);
        const requestWorkspace = extractWorkspaceFromSystem(systemText, config.workspaceRoot);
        const registry = createToolTranslationRegistry(body.tools, requestWorkspace);
        const v3Prompt = translateAnthropicToV3Prompt(body, registry);
        const hasTools = (registry.providerTools?.length ?? 0) > 0;
        const sessionId = deriveSessionId(body, hasTools);

        const abortController = new AbortController();
        res.on("close", () => {
          if (!res.writableEnded) {
            abortController.abort();
          }
        });

        const headers: Record<string, string> = {
          "x-opencode-directory": requestWorkspace,
        };
        if (sessionId) {
          headers["x-opencode-session-id"] = sessionId;
        }

        debugLog("POST /v1/messages", {
          requestedModel: body.model,
          wireModelId: resolvedModel.wireModelId,
          effort: resolvedModel.resolvedEffort ?? "default",
          maxMode: resolvedModel.maxMode,
          ctxWindow: resolvedModel.contextWindowTokens,
          variant: resolvedModel.variantParameters,
          stream: body.stream === true,
          messageCount: body.messages.length,
          toolCount: registry.providerTools?.length ?? 0,
          sessionId: sessionId ?? "ephemeral",
          workspace: requestWorkspace,
        });

        const v3Stream = await backend.streamTurn({
          model: resolvedModel,
          callOptions: {
            prompt: v3Prompt,
            ...(registry.providerTools ? { tools: registry.providerTools } : {}),
            ...(typeof body.max_tokens === "number" ? { maxOutputTokens: body.max_tokens } : {}),
            ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
            ...(typeof body.top_p === "number" ? { topP: body.top_p } : {}),
            ...(typeof body.top_k === "number" ? { topK: body.top_k } : {}),
            ...(Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0
              ? { stopSequences: body.stop_sequences }
              : {}),
            headers,
            abortSignal: abortController.signal,
          },
        });

        const includeThinking = body.thinking?.type !== "disabled";

        if (body.stream === true) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          });

          const sseStream = v3StreamToAnthropicSse(
            v3Stream,
            body.model || resolvedModel.wireModelId,
            registry,
            includeThinking,
          );
          const reader = sseStream.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done || res.writableEnded) break;
              const ok = res.write(value);
              if (!ok && !res.writableEnded) {
                await new Promise<void>((resolve) => res.once("drain", resolve));
              }
            }
          } finally {
            void recordRoutedModelCapture(resolvedModel, hasTools);
            try {
              reader.releaseLock();
            } catch {
              // ignore
            }
            if (!res.writableEnded) {
              res.end();
            }
          }
          return;
        }

        const responsePayload = await collectV3StreamToAnthropicResponse(
          v3Stream,
          body.model || resolvedModel.wireModelId,
          registry,
          includeThinking,
        );
        void recordRoutedModelCapture(resolvedModel, hasTools);
        sendJson(res, 200, responsePayload);
        return;
      }

      sendAnthropicError(res, 404, "not_found_error", `Unsupported route: ${method} ${pathname}`);
    } catch (err) {
      const statusCode =
        err && typeof err === "object" && "statusCode" in err && typeof (err as any).statusCode === "number"
          ? ((err as any).statusCode as number)
          : 500;
      const message = err instanceof Error ? err.message : String(err);
      debugLog("Request failed", { statusCode, message });
      if (!res.headersSent) {
        const errType =
          statusCode === 401 || statusCode === 403
            ? "authentication_error"
            : statusCode === 413 || statusCode === 400
              ? "invalid_request_error"
              : statusCode === 429
                ? "rate_limit_error"
                : "api_error";
        sendAnthropicError(res, statusCode, errType, message);
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(config.port, config.host);
  });

  const addr = server.address() as AddressInfo;
  const actualPort = addr.port;
  const baseUrl = `http://${config.host}:${actualPort}`;

  return {
    port: actualPort,
    host: config.host,
    baseUrl,
    config: { ...config, port: actualPort },
    models,
    auth,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

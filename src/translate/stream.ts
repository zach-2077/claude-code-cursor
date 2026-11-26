import { randomUUID } from "node:crypto";
import type { LanguageModelV3StreamPart, LanguageModelV3Usage } from "@ai-sdk/provider";
import type {
  AnthropicContentBlock,
  AnthropicMessagesResponse,
  AnthropicStopReason,
  AnthropicUsage,
} from "./anthropic-types.js";
import {
  translateProviderToolCallToHost,
  type ToolTranslationRegistry,
} from "./tools.js";

const SYNTHETIC_THINKING_SIGNATURE = "cursor-bridge-thinking-sig";

function formatSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function mapV3UsageToAnthropic(usage: LanguageModelV3Usage | undefined): AnthropicUsage {
  if (!usage) {
    return { input_tokens: 0, output_tokens: 0 };
  }

  const inputTotal = usage.inputTokens?.total ?? 0;
  const cacheRead = usage.inputTokens?.cacheRead ?? 0;
  const cacheWrite = usage.inputTokens?.cacheWrite ?? 0;
  const noCache =
    usage.inputTokens?.noCache ?? Math.max(0, inputTotal - cacheRead - cacheWrite);
  const outputTotal = usage.outputTokens?.total ?? 0;

  return {
    input_tokens: noCache,
    output_tokens: outputTotal,
    ...(cacheWrite > 0 ? { cache_creation_input_tokens: cacheWrite } : {}),
    ...(cacheRead > 0 ? { cache_read_input_tokens: cacheRead } : {}),
  };
}

function mapFinishReason(
  unified: string | undefined,
  sawToolUse: boolean,
): AnthropicStopReason {
  if (sawToolUse || unified === "tool-calls") {
    return "tool_use";
  }
  if (unified === "length") {
    return "max_tokens";
  }
  if (unified === "stop") {
    return "end_turn";
  }
  return "end_turn";
}

/**
 * Convert an AI SDK `LanguageModelV3StreamPart` ReadableStream into an Anthropic
 * `/v1/messages` Server-Sent Events (SSE) byte stream.
 */
export function v3StreamToAnthropicSse(
  v3Stream: ReadableStream<LanguageModelV3StreamPart>,
  modelName: string,
  registry: ToolTranslationRegistry,
  includeThinking = true,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const messageId = `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      type OpenBlockState = { index: number; kind: "thinking" | "text" };
      let messageStarted = false;
      let nextBlockIndex = 0;
      let openBlock: OpenBlockState | null = null;
      const getOpenBlock = (): OpenBlockState | null => openBlock;
      let sawToolUse = false;
      let sawAnyContentBlock = false;
      let finalUsage: AnthropicUsage = { input_tokens: 0, output_tokens: 0 };
      let stopReason: AnthropicStopReason = "end_turn";

      const emit = (event: string, payload: unknown) => {
        controller.enqueue(encoder.encode(formatSseEvent(event, payload)));
      };

      const ensureMessageStart = () => {
        if (messageStarted) return;
        messageStarted = true;
        emit("message_start", {
          type: "message_start",
          message: {
            id: messageId,
            type: "message",
            role: "assistant",
            model: modelName,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        });
      };

      const closeOpenBlock = () => {
        if (!openBlock) return;
        if (openBlock.kind === "thinking") {
          emit("content_block_delta", {
            type: "content_block_delta",
            index: openBlock.index,
            delta: {
              type: "signature_delta",
              signature: SYNTHETIC_THINKING_SIGNATURE,
            },
          });
        }
        emit("content_block_stop", {
          type: "content_block_stop",
          index: openBlock.index,
        });
        openBlock = null;
      };

      const ensureOpenBlock = (kind: "thinking" | "text"): number => {
        ensureMessageStart();
        if (openBlock && openBlock.kind === kind) {
          return openBlock.index;
        }
        closeOpenBlock();
        const index = nextBlockIndex++;
        sawAnyContentBlock = true;
        if (kind === "thinking") {
          emit("content_block_start", {
            type: "content_block_start",
            index,
            content_block: { type: "thinking", thinking: "" },
          });
        } else {
          emit("content_block_start", {
            type: "content_block_start",
            index,
            content_block: { type: "text", text: "" },
          });
        }
        openBlock = { index, kind };
        return index;
      };

      const reader = v3Stream.getReader();
      let streamDone = false;
      try {
        while (true) {
          const { done, value: part } = await reader.read();
          if (done) {
            streamDone = true;
            break;
          }

          switch (part.type) {
            case "stream-start":
              ensureMessageStart();
              break;

            case "reasoning-start":
              // Wait for non-empty reasoning-delta before opening a thinking block
              break;

            case "reasoning-delta": {
              if (!includeThinking || !part.delta) break;
              const idx = ensureOpenBlock("thinking");
              emit("content_block_delta", {
                type: "content_block_delta",
                index: idx,
                delta: {
                  type: "thinking_delta",
                  thinking: part.delta,
                },
              });
              break;
            }

            case "reasoning-end":
              if (getOpenBlock()?.kind === "thinking") {
                closeOpenBlock();
              }
              break;

            case "text-start":
              break;

            case "text-delta": {
              if (!part.delta) break;
              const idx = ensureOpenBlock("text");
              emit("content_block_delta", {
                type: "content_block_delta",
                index: idx,
                delta: {
                  type: "text_delta",
                  text: part.delta,
                },
              });
              break;
            }

            case "text-end":
              if (getOpenBlock()?.kind === "text") {
                closeOpenBlock();
              }
              break;

            // Ignore partial `tool-input-*` events from V3 if any; emit authoritative
            // translated tool_use on `tool-call` so argument rewriting is 100% atomic.
            case "tool-input-start":
            case "tool-input-delta":
            case "tool-input-end":
              break;

            case "tool-call": {
              ensureMessageStart();
              closeOpenBlock();
              const translated = translateProviderToolCallToHost(
                part.toolName,
                part.input,
                registry,
              );
              const idx = nextBlockIndex++;
              sawAnyContentBlock = true;
              sawToolUse = true;

              emit("content_block_start", {
                type: "content_block_start",
                index: idx,
                content_block: {
                  type: "tool_use",
                  id: part.toolCallId,
                  name: translated.name,
                  input: {},
                },
              });

              const inputJson = JSON.stringify(translated.input);
              emit("content_block_delta", {
                type: "content_block_delta",
                index: idx,
                delta: {
                  type: "input_json_delta",
                  partial_json: inputJson,
                },
              });

              emit("content_block_stop", {
                type: "content_block_stop",
                index: idx,
              });
              break;
            }

            case "finish": {
              finalUsage = mapV3UsageToAnthropic(part.usage);
              stopReason = mapFinishReason(part.finishReason?.unified, sawToolUse);
              break;
            }

            case "error": {
              const errMsg =
                part.error instanceof Error
                  ? part.error.message
                  : typeof part.error === "string"
                    ? part.error
                    : JSON.stringify(part.error);
              if (!messageStarted) {
                emit("error", {
                  type: "error",
                  error: {
                    type: "api_error",
                    message: errMsg,
                  },
                });
                controller.close();
                return;
              }
              closeOpenBlock();
              const idx = ensureOpenBlock("text");
              emit("content_block_delta", {
                type: "content_block_delta",
                index: idx,
                delta: {
                  type: "text_delta",
                  text: `\n\n[Cursor Backend Error: ${errMsg}]`,
                },
              });
              closeOpenBlock();
              break;
            }

            default:
              break;
          }
        }

        ensureMessageStart();
        closeOpenBlock();

        // Anthropic clients expect at least one content block on normal end_turn responses
        if (!sawAnyContentBlock && !sawToolUse) {
          const idx = ensureOpenBlock("text");
          emit("content_block_delta", {
            type: "content_block_delta",
            index: idx,
            delta: { type: "text_delta", text: "" },
          });
          closeOpenBlock();
        }

        if (sawToolUse) {
          stopReason = "tool_use";
        }

        emit("message_delta", {
          type: "message_delta",
          delta: {
            stop_reason: stopReason,
            stop_sequence: null,
          },
          usage: finalUsage,
        });

        emit("message_stop", {
          type: "message_stop",
        });

        controller.close();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        try {
          emit("error", {
            type: "error",
            error: {
              type: "api_error",
              message,
            },
          });
          controller.close();
        } catch {
          // already closed
        }
      } finally {
        try {
          if (!streamDone) {
            await reader.cancel();
          } else {
            reader.releaseLock();
          }
        } catch {
          // ignore
        }
      }
    },
  });
}

/**
 * Collect an AI SDK `LanguageModelV3StreamPart` stream into a single non-streaming
 * `AnthropicMessagesResponse` JSON object (`stream: false`).
 */
export async function collectV3StreamToAnthropicResponse(
  v3Stream: ReadableStream<LanguageModelV3StreamPart>,
  modelName: string,
  registry: ToolTranslationRegistry,
  includeThinking = true,
): Promise<AnthropicMessagesResponse> {
  const messageId = `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const content: AnthropicContentBlock[] = [];
  let thinkingBuf = "";
  let textBuf = "";
  let sawToolUse = false;
  let usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0 };
  let stopReason: AnthropicStopReason = "end_turn";

  const flushThinking = () => {
    if (!thinkingBuf) return;
    if (includeThinking) {
      content.push({
        type: "thinking",
        thinking: thinkingBuf,
        signature: SYNTHETIC_THINKING_SIGNATURE,
      });
    }
    thinkingBuf = "";
  };

  const flushText = () => {
    if (!textBuf) return;
    content.push({
      type: "text",
      text: textBuf,
    });
    textBuf = "";
  };

  const reader = v3Stream.getReader();
  try {
    while (true) {
      const { done, value: part } = await reader.read();
      if (done) break;
      switch (part.type) {
        case "reasoning-delta":
          flushText();
          thinkingBuf += part.delta ?? "";
          break;
        case "reasoning-end":
          flushThinking();
          break;
        case "text-delta":
          flushThinking();
          textBuf += part.delta ?? "";
          break;
        case "text-end":
          flushText();
          break;
        case "tool-call": {
          flushThinking();
          flushText();
          const translated = translateProviderToolCallToHost(
            part.toolName,
            part.input,
            registry,
          );
          sawToolUse = true;
          content.push({
            type: "tool_use",
            id: part.toolCallId,
            name: translated.name,
            input: translated.input,
          });
          break;
        }
        case "finish":
          usage = mapV3UsageToAnthropic(part.usage);
          stopReason = mapFinishReason(part.finishReason?.unified, sawToolUse);
          break;
        case "error": {
          const errMsg =
            part.error instanceof Error
              ? part.error.message
              : typeof part.error === "string"
                ? part.error
                : JSON.stringify(part.error);
          throw new Error(errMsg);
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }

  flushThinking();
  flushText();

  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }
  if (sawToolUse) {
    stopReason = "tool_use";
  }

  return {
    id: messageId,
    type: "message",
    role: "assistant",
    model: modelName,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  };
}

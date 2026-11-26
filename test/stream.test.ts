import { describe, expect, test } from "bun:test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { v3StreamToAnthropicSse, collectV3StreamToAnthropicResponse } from "../src/translate/stream.js";
import { createToolTranslationRegistry } from "../src/translate/tools.js";

function makeStream(parts: LanguageModelV3StreamPart[]): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(p);
      controller.close();
    },
  });
}

describe("Anthropic SSE & JSON response translation", () => {
  const registry = createToolTranslationRegistry(
    [
      {
        name: "Read",
        input_schema: {
          type: "object",
          properties: { file_path: { type: "string" } },
          required: ["file_path"],
          additionalProperties: false,
        },
      },
    ],
    "/workspace",
  );

  test("emits valid thinking + text + tool_use SSE sequence with stop_reason=tool_use", async () => {
    const stream = makeStream([
      { type: "stream-start", warnings: [] },
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", delta: "Inspecting file" },
      { type: "reasoning-end", id: "r1" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "Reading config." },
      { type: "text-end", id: "t1" },
      {
        type: "tool-call",
        toolCallId: "call_abc",
        toolName: "read",
        input: JSON.stringify({ filePath: "/workspace/config.json" }),
      },
      {
        type: "finish",
        finishReason: { unified: "tool-calls", raw: "tool-calls" },
        usage: {
          inputTokens: { total: 120, noCache: 20, cacheRead: 100, cacheWrite: 0 },
          outputTokens: { total: 35, text: 20, reasoning: 15 },
        },
      },
    ]);

    const sseBytes = v3StreamToAnthropicSse(stream, "composer-2.5", registry, true);
    const rawSse = await new Response(sseBytes).text();
    const events = rawSse
      .trim()
      .split("\n\n")
      .map((chunk) => {
        const lines = chunk.split("\n");
        const event = lines[0]?.replace("event: ", "");
        const data = JSON.parse(lines[1]?.replace("data: ", "") ?? "{}");
        return { event, data };
      });

    expect(events[0]?.event).toBe("message_start");
    expect(events.some((e) => e.data?.delta?.type === "thinking_delta")).toBe(true);
    expect(events.some((e) => e.data?.delta?.type === "signature_delta")).toBe(true);
    expect(events.some((e) => e.data?.delta?.type === "text_delta" && e.data.delta.text === "Reading config.")).toBe(true);

    const toolStart = events.find(
      (e) => e.event === "content_block_start" && e.data?.content_block?.type === "tool_use",
    );
    expect(toolStart?.data.content_block.name).toBe("Read");

    const toolDelta = events.find((e) => e.data?.delta?.type === "input_json_delta");
    expect(JSON.parse(toolDelta?.data.delta.partial_json)).toEqual({
      file_path: "/workspace/config.json",
    });

    const msgDelta = events.find((e) => e.event === "message_delta");
    expect(msgDelta?.data.delta.stop_reason).toBe("tool_use");
    expect(msgDelta?.data.usage).toEqual({
      input_tokens: 20,
      output_tokens: 35,
      cache_read_input_tokens: 100,
    });
    expect(events[events.length - 1]?.event).toBe("message_stop");
  });

  test("collects non-streaming response cleanly", async () => {
    const stream = makeStream([
      { type: "text-delta", id: "t1", delta: "PONG" },
      {
        type: "finish",
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
      },
    ]);

    const res = await collectV3StreamToAnthropicResponse(stream, "composer-2.5", registry, true);
    expect(res.stop_reason).toBe("end_turn");
    expect(res.content).toEqual([{ type: "text", text: "PONG" }]);
    expect(res.usage.input_tokens).toBe(10);
    expect(res.usage.output_tokens).toBe(1);
  });
});

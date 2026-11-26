import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { startProxyServer, type RunningProxyServer } from "../src/server.js";
import type { CursorBackend, StreamTurnInput } from "../src/backends/types.js";

describe("HTTP Proxy Server (/v1/messages, /v1/messages/count_tokens, /health)", () => {
  let proxy: RunningProxyServer;
  const capturedTurns: StreamTurnInput[] = [];

  const mockBackend: CursorBackend = {
    name: "mock-cursor",
    async streamTurn(input) {
      capturedTurns.push(input);
      const lastMsg = input.callOptions.prompt[input.callOptions.prompt.length - 1];
      const hasToolResult = lastMsg?.role === "tool";

      const parts: LanguageModelV3StreamPart[] = hasToolResult
        ? [
            { type: "text-delta", id: "t2", delta: "File says: hello" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: { total: 30, noCache: 30, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 5, text: 5, reasoning: 0 },
              },
            },
          ]
        : [
            {
              type: "tool-call",
              toolCallId: "toolu_mock_1",
              toolName: "read",
              input: JSON.stringify({ filePath: "/tmp/demo.txt" }),
            },
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: "tool-calls" },
              usage: {
                inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 10, text: 0, reasoning: 0 },
              },
            },
          ];

      return new ReadableStream({
        start(controller) {
          for (const p of parts) controller.enqueue(p);
          controller.close();
        },
      });
    },
  };

  beforeAll(async () => {
    proxy = await startProxyServer(
      { port: 0, defaultModel: "composer-2.5", fastModel: "gemini-3.8-flash" },
      { backend: mockBackend },
    );
  });

  afterAll(async () => {
    await proxy.stop();
  });

  test("GET /health reports service status", async () => {
    const res = await fetch(`${proxy.baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.backend).toBe("mock-cursor");
  });

  test("POST /v1/messages/count_tokens returns positive token estimate", async () => {
    const res = await fetch(`${proxy.baseUrl}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "composer-2.5",
        system: "You are a coding assistant.",
        messages: [{ role: "user", content: "Count these tokens please." }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.input_tokens).toBeGreaterThan(5);
  });

  test("POST /v1/messages?beta=true completes 2-turn Read tool loop and routes claude-haiku to fastModel", async () => {
    capturedTurns.length = 0;

    const tools = [
      {
        name: "Read",
        input_schema: {
          type: "object",
          properties: { file_path: { type: "string" } },
          required: ["file_path"],
          additionalProperties: false,
        },
      },
    ];

    // Turn 1: model requests Read tool
    const res1 = await fetch(`${proxy.baseUrl}/v1/messages?beta=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        stream: false,
        tools,
        metadata: { user_id: "user_1_session_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
        messages: [{ role: "user", content: "Read /tmp/demo.txt" }],
      }),
    });
    expect(res1.status).toBe(200);
    const turn1 = (await res1.json()) as any;
    expect(turn1.stop_reason).toBe("tool_use");
    expect(turn1.content[0]).toEqual({
      type: "tool_use",
      id: "toolu_mock_1",
      name: "Read",
      input: { file_path: "/tmp/demo.txt" },
    });
    expect(capturedTurns[0]?.model.wireModelId).toBe("gemini-3.8-flash");
    expect(capturedTurns[0]?.callOptions.headers?.["x-opencode-session-id"]).toBe(
      "cc-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    );

    // Turn 2: Claude Code returns Read tool_result with `1→` line numbers
    const res2 = await fetch(`${proxy.baseUrl}/v1/messages?beta=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "composer-2.5",
        stream: false,
        tools,
        metadata: { user_id: "user_1_session_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
        messages: [
          { role: "user", content: "Read /tmp/demo.txt" },
          { role: "assistant", content: turn1.content },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_mock_1",
                content: "     1→hello",
              },
            ],
          },
        ],
      }),
    });
    expect(res2.status).toBe(200);
    const turn2 = (await res2.json()) as any;
    expect(turn2.stop_reason).toBe("end_turn");
    expect(turn2.content[0].text).toBe("File says: hello");
  });
});

import { describe, expect, test } from "bun:test";
import {
  deriveSessionId,
  extractWorkspaceFromSystem,
  formatClaudeGrepForProvider,
  translateAnthropicToV3Prompt,
  unwrapClaudeCodeReadResult,
} from "../src/translate/prompt.js";
import { createToolTranslationRegistry } from "../src/translate/tools.js";

describe("Prompt translation & tool output normalization", () => {
  test("unwraps Claude Code Read line numbers and trailing system-reminder", () => {
    const raw =
      "     1→import http from \"node:http\";\n" +
      "     2→const port = 32125;\n" +
      "     3→\n" +
      "<system-reminder>\nWhenever you read a file, inspect carefully.\n</system-reminder>\n";

    expect(unwrapClaudeCodeReadResult(raw)).toBe(
      "import http from \"node:http\";\nconst port = 32125;\n",
    );
  });

  test("formats ripgrep content output into OpenCode line-preview format", () => {
    const rg = "src/server.ts:42:const port = 32125;\nsrc/server.ts:88:server.listen(port);";
    expect(formatClaudeGrepForProvider(rg)).toBe(
      "Found 2 matches\n" +
        "src/server.ts:\n" +
        "  Line 42: const port = 32125;\n" +
        "  Line 88: server.listen(port);",
    );
  });

  test("extracts workspace from Claude Code system prompt and session ID from metadata", () => {
    const sys = "You are Claude Code.\nPrimary working directory: /Users/dev/project\n";
    expect(extractWorkspaceFromSystem(sys, "/fallback")).toBe("/Users/dev/project");

    const sid = deriveSessionId(
      {
        model: "composer-2.5",
        messages: [{ role: "user", content: "hi" }],
        metadata: { user_id: "user_abc_account_def_session_12345678-aaaa-bbbb-cccc-1234567890ab" },
      },
      true,
    );
    expect(sid).toBe("cc-12345678-aaaa-bbbb-cccc-1234567890ab");

    // Ephemeral zero-tool helper calls get undefined sessionId
    expect(
      deriveSessionId(
        {
          model: "composer-2.5",
          messages: [{ role: "user", content: "Generate title" }],
          metadata: { user_id: "user_abc_session_12345678-aaaa-bbbb-cccc-1234567890ab" },
        },
        false,
      ),
    ).toBeUndefined();
  });

  test("splits combined user tool_result + user text into contiguous tool role then user role", () => {
    const registry = createToolTranslationRegistry(
      [
        {
          name: "Read",
          input_schema: { type: "object", properties: { file_path: { type: "string" } } },
        },
      ],
      "/workspace",
    );

    const prompt = translateAnthropicToV3Prompt(
      {
        model: "composer-2.5",
        system: [{ type: "text", text: "System prompt" }],
        messages: [
          { role: "user", content: "Check a.txt" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "Let me read a.txt", signature: "sig" },
              { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/workspace/a.txt" } },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_1", content: "     1→hello\n     2→world" },
              { type: "text", text: "Also check line 2" },
            ],
          },
        ],
      },
      registry,
    );

    expect(prompt.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "user"]);
    const toolMsg = prompt[3] as any;
    expect(toolMsg.content[0]).toEqual({
      type: "tool-result",
      toolCallId: "toolu_1",
      toolName: "read",
      output: { type: "text", value: "hello\nworld" },
    });
  });
});

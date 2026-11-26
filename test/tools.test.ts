import { describe, expect, test } from "bun:test";
import {
  createToolTranslationRegistry,
  translateHostToolUseToProvider,
  translateProviderToolCallToHost,
} from "../src/translate/tools.js";
import type { AnthropicToolDefinition } from "../src/translate/anthropic-types.js";

const CLAUDE_CODE_TOOLS: AnthropicToolDefinition[] = [
  {
    name: "Bash",
    description: "Executes a bash command",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout: { type: "number" },
        description: { type: "string" },
        run_in_background: { type: "boolean" },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "Read",
    description: "Reads a file",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        offset: { type: "number" },
        limit: { type: "number" },
      },
      required: ["file_path"],
      additionalProperties: false,
    },
  },
  {
    name: "Edit",
    description: "Performs exact string replacements",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["file_path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
  {
    name: "Write",
    description: "Writes a file",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        content: { type: "string" },
      },
      required: ["file_path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "Grep",
    description: "Ripgrep search",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        glob: { type: "string" },
        output_mode: { type: "string" },
        "-n": { type: "boolean" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "TodoWrite",
    description: "Manage todo list",
    input_schema: {
      type: "object",
      properties: {
        todos: { type: "array" },
      },
      required: ["todos"],
      additionalProperties: false,
    },
  },
  {
    name: "Agent",
    description: "Launch subagent",
    input_schema: {
      type: "object",
      properties: {
        description: { type: "string" },
        prompt: { type: "string" },
        subagent_type: { type: "string" },
      },
      required: ["description", "prompt"],
      additionalProperties: false,
    },
  },
];

describe("ToolTranslationRegistry", () => {
  const registry = createToolTranslationRegistry(CLAUDE_CODE_TOOLS, "/workspace/app");

  test("maps Claude Code tools to sorted canonical OpenCode v1 tool names", () => {
    const names = registry.providerTools?.map((t) => t.name);
    expect(names).toEqual(["bash", "edit", "grep", "read", "task", "todowrite", "write"]);
  });

  test("translates provider read/edit/write calls back to Claude Code file_path & snake_case keys", () => {
    const readCall = translateProviderToolCallToHost(
      "read",
      { filePath: "/workspace/app/index.ts", offset: 0, limit: 50 },
      registry,
    );
    expect(readCall).toEqual({
      name: "Read",
      input: { file_path: "/workspace/app/index.ts", offset: 1, limit: 50 },
    });

    const editCall = translateProviderToolCallToHost(
      "edit",
      {
        filePath: "/workspace/app/index.ts",
        oldString: "const a = 1;",
        newString: "const a = 2;",
        replaceAll: true,
      },
      registry,
    );
    expect(editCall).toEqual({
      name: "Edit",
      input: {
        file_path: "/workspace/app/index.ts",
        old_string: "const a = 1;",
        new_string: "const a = 2;",
        replace_all: true,
      },
    });
  });

  test("reroutes malformed full-file edit with empty oldString to Write", () => {
    const rerouted = translateProviderToolCallToHost(
      "edit",
      { filePath: "/workspace/app/new.ts", oldString: "", newString: "export default 42;\n" },
      registry,
    );
    expect(rerouted).toEqual({
      name: "Write",
      input: { file_path: "/workspace/app/new.ts", content: "export default 42;\n" },
    });
  });

  test("rewrites bash workdir into cd prefix when outside workspaceRoot and strips unsupported keys", () => {
    const bashCall = translateProviderToolCallToHost(
      "bash",
      { command: "npm test", workdir: "/workspace/app/packages/ui", extraKey: 123 },
      registry,
    );
    expect(bashCall.name).toBe("Bash");
    expect(bashCall.input.command).toBe("cd '/workspace/app/packages/ui' && npm test");
    expect(typeof bashCall.input.description).toBe("string");
    expect("workdir" in bashCall.input).toBe(false);
    expect("extraKey" in bashCall.input).toBe(false);
  });

  test("defaults Grep to content mode with line numbers and maps include -> glob", () => {
    const grepCall = translateProviderToolCallToHost(
      "grep",
      { pattern: "startProxyServer", path: "src", include: "*.ts" },
      registry,
    );
    expect(grepCall).toEqual({
      name: "Grep",
      input: {
        pattern: "startProxyServer",
        path: "src",
        glob: "*.ts",
        output_mode: "content",
        "-n": true,
      },
    });
  });

  test("populates TodoWrite activeForm and maps task -> Agent", () => {
    const todoCall = translateProviderToolCallToHost(
      "todowrite",
      { todos: [{ id: "1", content: "Run unit tests", status: "in_progress", priority: "high" }] },
      registry,
    );
    expect(todoCall).toEqual({
      name: "TodoWrite",
      input: {
        todos: [{ content: "Run unit tests", status: "in_progress", activeForm: "Run unit tests" }],
      },
    });

    const taskCall = translateProviderToolCallToHost(
      "task",
      { description: "Find routes", prompt: "Search all endpoints", subagent_type: "explore" },
      registry,
    );
    expect(taskCall).toEqual({
      name: "Agent",
      input: {
        description: "Find routes",
        prompt: "Search all endpoints",
        subagent_type: "Explore",
      },
    });
  });

  test("translates historical Claude Code tool_use blocks back into provider canonical shape", () => {
    const back = translateHostToolUseToProvider(
      "Edit",
      {
        file_path: "/workspace/app/a.ts",
        old_string: "foo",
        new_string: "bar",
        replace_all: false,
      },
      registry,
    );
    expect(back).toEqual({
      toolName: "edit",
      input: {
        filePath: "/workspace/app/a.ts",
        oldString: "foo",
        newString: "bar",
        replaceAll: false,
      },
    });
  });
});

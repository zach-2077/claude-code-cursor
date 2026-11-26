import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import type { AnthropicToolDefinition } from "./anthropic-types.js";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function defaultBashDescription(command: unknown): string {
  const text = typeof command === "string" ? command.trim() : "";
  if (!text) return "Run shell command";
  const clipped = text.length > 60 ? `${text.slice(0, 57)}...` : text;
  return `Run: ${clipped}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface ToolTranslationRegistry {
  /** Translated AI SDK V3 tools sorted deterministically for prompt-cache stability */
  providerTools: LanguageModelV3FunctionTool[] | undefined;
  /** Host tool name (e.g. "Read") -> Provider canonical name (e.g. "read") */
  hostToProviderName: Map<string, string>;
  /** Provider canonical name (e.g. "read") -> Host tool name (e.g. "Read") */
  providerToHostName: Map<string, string>;
  /** Original Claude Code input_schema by host tool name */
  hostSchemas: Map<string, JsonRecord>;
  /** Workspace root used for relative/workdir adjustments */
  workspaceRoot: string;
}

function getSchemaProperties(schema: JsonRecord | undefined): JsonRecord | undefined {
  if (!schema) return undefined;
  return isRecord(schema.properties) ? schema.properties : undefined;
}

function compareCanonicalKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortSchemaProperties(schema: JsonRecord): JsonRecord {
  const props = getSchemaProperties(schema);
  if (!props) return schema;
  const sortedProps: JsonRecord = {};
  for (const key of Object.keys(props).sort(compareCanonicalKeys)) {
    sortedProps[key] = props[key];
  }
  const required = Array.isArray(schema.required)
    ? [...schema.required].filter((k): k is string => typeof k === "string").sort(compareCanonicalKeys)
    : undefined;
  return {
    ...schema,
    properties: sortedProps,
    ...(required ? { required } : {}),
  };
}

/**
 * Determine the canonical OpenCode/Cursor tool name for a Claude Code tool name.
 */
export function resolveCanonicalProviderToolName(hostName: string): string {
  switch (hostName) {
    case "Bash":
      return "bash";
    case "Read":
      return "read";
    case "Write":
      return "write";
    case "Edit":
      return "edit";
    case "Glob":
      return "glob";
    case "Grep":
      return "grep";
    case "Agent":
    case "Task":
      return "task";
    case "TodoWrite":
      return "todowrite";
    case "WebFetch":
      return "webfetch";
    case "WebSearch":
      return "websearch";
    case "AskUserQuestion":
      return "question";
    case "Skill":
      return "skill";
    default:
      return hostName;
  }
}

function buildProviderToolSchema(
  hostName: string,
  providerName: string,
  hostSchema: JsonRecord,
): JsonRecord {
  const props = getSchemaProperties(hostSchema) ?? {};

  switch (providerName) {
    case "read":
      return sortSchemaProperties({
        type: "object",
        properties: {
          filePath: props.file_path ?? { type: "string", description: "Absolute path to the file to read" },
          ...(props.offset ? { offset: props.offset } : { offset: { type: "number" } }),
          ...(props.limit ? { limit: props.limit } : { limit: { type: "number" } }),
        },
        required: ["filePath"],
      });

    case "write":
      return sortSchemaProperties({
        type: "object",
        properties: {
          filePath: props.file_path ?? { type: "string", description: "Absolute path to the file to write" },
          content: props.content ?? { type: "string", description: "Complete file contents" },
        },
        required: ["filePath", "content"],
      });

    case "edit":
      return sortSchemaProperties({
        type: "object",
        properties: {
          filePath: props.file_path ?? { type: "string", description: "Absolute path to the file to edit" },
          oldString: props.old_string ?? { type: "string", description: "Exact text to replace" },
          newString: props.new_string ?? { type: "string", description: "Replacement text" },
          replaceAll: props.replace_all ?? { type: "boolean", description: "Replace all occurrences" },
        },
        required: ["filePath", "oldString", "newString"],
      });

    case "bash":
      return sortSchemaProperties({
        type: "object",
        properties: {
          command: props.command ?? { type: "string", description: "Shell command to execute" },
          description: props.description ?? { type: "string", description: "Short description of the command" },
          timeout: props.timeout ?? { type: "number", description: "Optional timeout in milliseconds" },
          workdir: { type: "string", description: "Optional working directory" },
        },
        required: ["command"],
      });

    case "glob":
      return sortSchemaProperties({
        type: "object",
        properties: {
          pattern: props.pattern ?? { type: "string", description: "Glob pattern to match files" },
          path: props.path ?? { type: "string", description: "Directory to search in" },
        },
        required: ["pattern"],
      });

    case "grep":
      return sortSchemaProperties({
        type: "object",
        properties: {
          pattern: props.pattern ?? { type: "string", description: "Regular expression pattern" },
          path: props.path ?? { type: "string", description: "File or directory to search in" },
          include: props.glob ?? { type: "string", description: "Glob pattern to filter files" },
        },
        required: ["pattern"],
      });

    case "task":
      return sortSchemaProperties({
        type: "object",
        properties: {
          description: props.description ?? { type: "string", description: "Short (3-5 word) task description" },
          prompt: props.prompt ?? { type: "string", description: "Detailed instructions for the subagent" },
          subagent_type: props.subagent_type ?? {
            type: "string",
            description: "Subagent type (e.g. general-purpose, Explore, Plan)",
          },
        },
        required: ["description", "prompt", "subagent_type"],
      });

    case "todowrite":
      return sortSchemaProperties({
        type: "object",
        properties: {
          todos: {
            type: "array",
            items: {
              type: "object",
              properties: {
                content: { type: "string" },
                status: { type: "string", enum: ["pending", "in_progress", "completed"] },
                priority: { type: "string", enum: ["high", "medium", "low"] },
                id: { type: "string" },
              },
              required: ["content", "status"],
            },
          },
        },
        required: ["todos"],
      });

    case "webfetch":
      return sortSchemaProperties({
        type: "object",
        properties: {
          url: props.url ?? { type: "string", description: "URL to fetch" },
          format: { type: "string", description: "Output format (markdown, text, html)" },
        },
        required: ["url"],
      });

    case "websearch":
      return sortSchemaProperties({
        type: "object",
        properties: {
          query: props.query ?? { type: "string", description: "Search query" },
        },
        required: ["query"],
      });

    case "question":
      return sortSchemaProperties({
        type: "object",
        properties: {
          questions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                question: { type: "string" },
                header: { type: "string" },
                multiple: { type: "boolean" },
                options: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      label: { type: "string" },
                      description: { type: "string" },
                    },
                    required: ["label", "description"],
                  },
                },
              },
              required: ["question", "header", "options"],
            },
          },
        },
        required: ["questions"],
      });

    case "skill":
      return sortSchemaProperties({
        type: "object",
        properties: {
          name: props.skill ?? { type: "string", description: "Skill name to invoke" },
          ...(props.args ? { args: props.args } : {}),
        },
        required: ["name"],
      });

    default:
      return sortSchemaProperties(hostSchema);
  }
}

export function createToolTranslationRegistry(
  tools: readonly AnthropicToolDefinition[] | undefined,
  workspaceRoot: string,
): ToolTranslationRegistry {
  const hostToProviderName = new Map<string, string>();
  const providerToHostName = new Map<string, string>();
  const hostSchemas = new Map<string, JsonRecord>();

  if (!tools || tools.length === 0) {
    return {
      providerTools: undefined,
      hostToProviderName,
      providerToHostName,
      hostSchemas,
      workspaceRoot,
    };
  }

  const translated: LanguageModelV3FunctionTool[] = [];

  for (const tool of tools) {
    if (!tool || typeof tool.name !== "string" || !tool.name.trim()) continue;
    // Skip Anthropic server-side tools that lack an input_schema
    if (!isRecord(tool.input_schema) && tool.type && tool.type !== "custom") {
      continue;
    }

    const hostName = tool.name.trim();
    const hostSchema: JsonRecord = isRecord(tool.input_schema)
      ? tool.input_schema
      : { type: "object", properties: {} };
    hostSchemas.set(hostName, hostSchema);

    let providerName = resolveCanonicalProviderToolName(hostName);
    // Guard against duplicate canonical names if both Agent and Task are present
    if (providerToHostName.has(providerName) && providerToHostName.get(providerName) !== hostName) {
      providerName = hostName;
    }

    hostToProviderName.set(hostName, providerName);
    providerToHostName.set(providerName, hostName);

    translated.push({
      type: "function",
      name: providerName,
      description: tool.description ?? "",
      inputSchema: buildProviderToolSchema(hostName, providerName, hostSchema) as any,
    });
  }

  translated.sort((a, b) => compareCanonicalKeys(a.name, b.name));

  return {
    providerTools: translated.length > 0 ? translated : undefined,
    hostToProviderName,
    providerToHostName,
    hostSchemas,
    workspaceRoot,
  };
}

/**
 * Translate a historical Claude Code `tool_use` block into the canonical
 * provider tool name + input expected by `cursor-opencode-provider`.
 */
export function translateHostToolUseToProvider(
  hostName: string,
  input: Record<string, unknown>,
  registry: ToolTranslationRegistry,
): { toolName: string; input: Record<string, unknown> } {
  const providerName =
    registry.hostToProviderName.get(hostName) ?? resolveCanonicalProviderToolName(hostName);

  switch (providerName) {
    case "read": {
      const filePath = str(input.file_path) ?? str(input.filePath) ?? str(input.path) ?? "";
      const out: JsonRecord = { filePath };
      if (typeof input.offset === "number") out.offset = input.offset;
      if (typeof input.limit === "number") out.limit = input.limit;
      return { toolName: providerName, input: out };
    }

    case "write": {
      const filePath = str(input.file_path) ?? str(input.filePath) ?? str(input.path) ?? "";
      const content = typeof input.content === "string" ? input.content : "";
      return { toolName: providerName, input: { filePath, content } };
    }

    case "edit": {
      const filePath = str(input.file_path) ?? str(input.filePath) ?? str(input.path) ?? "";
      const oldString = typeof input.old_string === "string" ? input.old_string : str(input.oldString) ?? "";
      const newString = typeof input.new_string === "string" ? input.new_string : str(input.newString) ?? "";
      const out: JsonRecord = { filePath, oldString, newString };
      if (typeof input.replace_all === "boolean") out.replaceAll = input.replace_all;
      return { toolName: providerName, input: out };
    }

    case "bash": {
      const out: JsonRecord = { command: typeof input.command === "string" ? input.command : "" };
      if (typeof input.timeout === "number") out.timeout = input.timeout;
      if (typeof input.description === "string") out.description = input.description;
      return { toolName: providerName, input: out };
    }

    case "grep": {
      const out: JsonRecord = { pattern: typeof input.pattern === "string" ? input.pattern : "" };
      if (typeof input.path === "string") out.path = input.path;
      if (typeof input.glob === "string") out.include = input.glob;
      return { toolName: providerName, input: out };
    }

    case "glob": {
      const out: JsonRecord = { pattern: typeof input.pattern === "string" ? input.pattern : "" };
      if (typeof input.path === "string") out.path = input.path;
      return { toolName: providerName, input: out };
    }

    case "task": {
      return {
        toolName: providerName,
        input: {
          description: str(input.description) ?? "Delegated task",
          prompt: str(input.prompt) ?? "",
          subagent_type: str(input.subagent_type) ?? "general-purpose",
        },
      };
    }

    case "todowrite": {
      const todos = Array.isArray(input.todos)
        ? input.todos.filter(isRecord).map((item, idx) => ({
            id: str(item.id) ?? String(idx + 1),
            content: str(item.content) ?? "",
            status: str(item.status) ?? "pending",
            priority: str(item.priority) ?? "medium",
          }))
        : [];
      return { toolName: providerName, input: { todos } };
    }

    case "webfetch":
      return {
        toolName: providerName,
        input: { url: str(input.url) ?? "" },
      };

    case "websearch":
      return {
        toolName: providerName,
        input: { query: str(input.query) ?? "" },
      };

    case "question": {
      const questions = Array.isArray(input.questions)
        ? input.questions.filter(isRecord).map((q) => ({
            question: str(q.question) ?? "",
            header: str(q.header) ?? "Question",
            multiple: q.multiSelect === true || q.multiple === true,
            options: Array.isArray(q.options) ? q.options : [],
          }))
        : [];
      return { toolName: providerName, input: { questions } };
    }

    case "skill":
      return {
        toolName: providerName,
        input: {
          name: str(input.skill) ?? str(input.name) ?? "",
          ...(typeof input.args === "string" ? { args: input.args } : {}),
        },
      };

    default:
      return { toolName: providerName, input };
  }
}

function normalizeClaudeSubagentType(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return "general-purpose";
  const lower = value.toLowerCase();
  if (lower === "general" || lower === "generalpurpose" || lower === "general-purpose" || lower === "unspecified") {
    return "general-purpose";
  }
  if (lower === "explore") return "Explore";
  if (lower === "plan") return "Plan";
  return value;
}

function filterAllowedSchemaKeys(
  candidate: JsonRecord,
  hostSchema: JsonRecord | undefined,
): JsonRecord {
  if (!hostSchema || hostSchema.additionalProperties !== false) {
    return candidate;
  }
  const props = getSchemaProperties(hostSchema);
  if (!props) return candidate;
  const filtered: JsonRecord = {};
  for (const [k, v] of Object.entries(candidate)) {
    if (Object.hasOwn(props, k)) {
      filtered[k] = v;
    }
  }
  return filtered;
}

/**
 * Translate a streamed `LanguageModelV3ToolCall` from `cursor-opencode-provider`
 * back into the exact Claude Code tool name and input schema.
 */
export function translateProviderToolCallToHost(
  providerName: string,
  rawInput: unknown,
  registry: ToolTranslationRegistry,
): { name: string; input: Record<string, unknown> } {
  let parsed: JsonRecord = {};
  if (typeof rawInput === "string") {
    try {
      const candidate = JSON.parse(rawInput);
      if (isRecord(candidate)) parsed = candidate;
    } catch {
      parsed = {};
    }
  } else if (isRecord(rawInput)) {
    parsed = { ...rawInput };
  }

  // Case-insensitive fallback lookup if provider emitted a variant casing
  let hostName = registry.providerToHostName.get(providerName);
  if (!hostName) {
    const lower = providerName.toLowerCase();
    for (const [pName, hName] of registry.providerToHostName.entries()) {
      if (pName.toLowerCase() === lower || hName.toLowerCase() === lower) {
        hostName = hName;
        break;
      }
    }
  }

  // Malformed full-file edit with empty oldString -> reroute to Write if Write is available
  const canonical = providerName.toLowerCase();
  if (canonical === "edit") {
    const oldStr = parsed.oldString ?? parsed.old_string;
    const newStr = parsed.newString ?? parsed.new_string ?? parsed.content;
    const writeHostName = registry.providerToHostName.get("write");
    if (
      writeHostName &&
      (oldStr === undefined || oldStr === "") &&
      typeof newStr === "string"
    ) {
      const filePath = str(parsed.filePath) ?? str(parsed.path) ?? str(parsed.file_path) ?? "";
      if (filePath) {
        return {
          name: writeHostName,
          input: filterAllowedSchemaKeys(
            { file_path: filePath, content: newStr },
            registry.hostSchemas.get(writeHostName),
          ),
        };
      }
    }
  }

  const resolvedHostName = hostName ?? providerName;
  const hostSchema = registry.hostSchemas.get(resolvedHostName);
  const hostProps = getSchemaProperties(hostSchema);

  switch (canonical) {
    case "read": {
      const filePath = str(parsed.filePath) ?? str(parsed.path) ?? str(parsed.file_path) ?? "";
      const out: JsonRecord = { file_path: filePath };
      if (typeof parsed.offset === "number" && Number.isFinite(parsed.offset)) {
        out.offset = Math.max(1, Math.floor(parsed.offset));
      }
      if (typeof parsed.limit === "number" && Number.isFinite(parsed.limit) && parsed.limit > 0) {
        out.limit = Math.floor(parsed.limit);
      }
      return { name: resolvedHostName, input: filterAllowedSchemaKeys(out, hostSchema) };
    }

    case "write": {
      const filePath = str(parsed.filePath) ?? str(parsed.path) ?? str(parsed.file_path) ?? "";
      const content =
        typeof parsed.content === "string"
          ? parsed.content
          : typeof parsed.contents === "string"
            ? parsed.contents
            : typeof parsed.file_text === "string"
              ? parsed.file_text
              : "";
      return {
        name: resolvedHostName,
        input: filterAllowedSchemaKeys({ file_path: filePath, content }, hostSchema),
      };
    }

    case "edit": {
      const filePath = str(parsed.filePath) ?? str(parsed.path) ?? str(parsed.file_path) ?? "";
      const oldString =
        typeof parsed.oldString === "string"
          ? parsed.oldString
          : typeof parsed.old_string === "string"
            ? parsed.old_string
            : "";
      const newString =
        typeof parsed.newString === "string"
          ? parsed.newString
          : typeof parsed.new_string === "string"
            ? parsed.new_string
            : "";
      const out: JsonRecord = {
        file_path: filePath,
        old_string: oldString,
        new_string: newString,
      };
      const replaceAll = parsed.replaceAll ?? parsed.replace_all;
      if (typeof replaceAll === "boolean") {
        out.replace_all = replaceAll;
      }
      return { name: resolvedHostName, input: filterAllowedSchemaKeys(out, hostSchema) };
    }

    case "bash":
    case "shell": {
      let command = typeof parsed.command === "string" ? parsed.command : str(parsed.cmd) ?? "";
      const workdir = str(parsed.workdir) ?? str(parsed.working_directory) ?? str(parsed.cwd);
      // Claude Code's Bash tool runs in the session cwd and has no `workdir` parameter.
      if (workdir && workdir !== registry.workspaceRoot && (!hostProps || !Object.hasOwn(hostProps, "workdir"))) {
        command = `cd ${shellQuote(workdir)} && ${command}`;
      }
      const out: JsonRecord = { command };
      if (!hostProps || Object.hasOwn(hostProps, "description")) {
        out.description = str(parsed.description) ?? defaultBashDescription(command);
      }
      if (typeof parsed.timeout === "number" && Number.isFinite(parsed.timeout) && parsed.timeout > 0) {
        out.timeout = Math.min(600_000, Math.floor(parsed.timeout));
      }
      if (typeof parsed.run_in_background === "boolean") {
        out.run_in_background = parsed.run_in_background;
      }
      return { name: resolvedHostName, input: filterAllowedSchemaKeys(out, hostSchema) };
    }

    case "glob": {
      const pattern =
        str(parsed.pattern) ?? str(parsed.glob_pattern) ?? str(parsed.globPattern) ?? "**/*";
      const out: JsonRecord = { pattern };
      const searchPath = str(parsed.path) ?? str(parsed.target_directory);
      if (searchPath) out.path = searchPath;
      return { name: resolvedHostName, input: filterAllowedSchemaKeys(out, hostSchema) };
    }

    case "grep": {
      const pattern = str(parsed.pattern) ?? "";
      const out: JsonRecord = { pattern };
      const searchPath = str(parsed.path);
      if (searchPath) out.path = searchPath;
      const glob = str(parsed.include) ?? str(parsed.glob);
      if (glob) out.glob = glob;
      // Default to content + line numbers so Cursor receives matched line previews
      const mode = str(parsed.output_mode);
      if (!hostProps || Object.hasOwn(hostProps, "output_mode")) {
        out.output_mode = mode ?? "content";
      }
      if ((!hostProps || Object.hasOwn(hostProps, "-n")) && out.output_mode === "content") {
        out["-n"] = typeof parsed["-n"] === "boolean" ? parsed["-n"] : true;
      }
      if (typeof parsed["-i"] === "boolean") out["-i"] = parsed["-i"];
      return { name: resolvedHostName, input: filterAllowedSchemaKeys(out, hostSchema) };
    }

    case "task":
    case "subagent": {
      const out: JsonRecord = {
        description: str(parsed.description) ?? "Subagent task",
        prompt: str(parsed.prompt) ?? "",
      };
      if (!hostProps || Object.hasOwn(hostProps, "subagent_type")) {
        out.subagent_type = normalizeClaudeSubagentType(parsed.subagent_type ?? parsed.agent);
      }
      if (typeof parsed.run_in_background === "boolean" || parsed.background === true) {
        out.run_in_background = parsed.run_in_background === true || parsed.background === true;
      }
      return { name: resolvedHostName, input: filterAllowedSchemaKeys(out, hostSchema) };
    }

    case "todowrite": {
      const rawTodos = Array.isArray(parsed.todos) ? parsed.todos.filter(isRecord) : [];
      const todos = rawTodos.map((item) => {
        const content = str(item.content) ?? "";
        const rawStatus = str(item.status) ?? "pending";
        const status =
          rawStatus === "in_progress" || rawStatus === "completed" || rawStatus === "pending"
            ? rawStatus
            : rawStatus === "cancelled"
              ? "completed"
              : "pending";
        return {
          content,
          status,
          activeForm: str(item.activeForm) ?? content,
        };
      });
      return { name: resolvedHostName, input: filterAllowedSchemaKeys({ todos }, hostSchema) };
    }

    case "webfetch": {
      const url = str(parsed.url) ?? "";
      const prompt =
        str(parsed.prompt) ?? "Extract the relevant content and key information from this page.";
      return {
        name: resolvedHostName,
        input: filterAllowedSchemaKeys({ url, prompt }, hostSchema),
      };
    }

    case "websearch": {
      const query = str(parsed.query) ?? "";
      return {
        name: resolvedHostName,
        input: filterAllowedSchemaKeys({ query }, hostSchema),
      };
    }

    case "question": {
      const rawQuestions = Array.isArray(parsed.questions)
        ? parsed.questions.filter(isRecord)
        : [];
      const questions = rawQuestions.map((q) => {
        const header = (str(q.header) ?? "Question").slice(0, 12);
        const options = Array.isArray(q.options)
          ? q.options.filter(isRecord).map((opt) => ({
              label: str(opt.label) ?? "Option",
              description: str(opt.description) ?? "",
            }))
          : [];
        return {
          question: str(q.question) ?? "",
          header,
          multiSelect: q.multiple === true || q.multiSelect === true,
          options,
        };
      });
      return {
        name: resolvedHostName,
        input: filterAllowedSchemaKeys({ questions }, hostSchema),
      };
    }

    case "skill": {
      const skill = str(parsed.name) ?? str(parsed.skill) ?? str(parsed.id) ?? "";
      const out: JsonRecord = { skill };
      if (typeof parsed.args === "string") out.args = parsed.args;
      return { name: resolvedHostName, input: filterAllowedSchemaKeys(out, hostSchema) };
    }

    default:
      return { name: resolvedHostName, input: filterAllowedSchemaKeys(parsed, hostSchema) };
  }
}

import { createHash } from "node:crypto";
import path from "node:path";
import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import type {
  AnthropicContentBlock,
  AnthropicMessagesRequest,
  AnthropicToolResultBlock,
} from "./anthropic-types.js";
import {
  translateHostToolUseToProvider,
  type ToolTranslationRegistry,
} from "./tools.js";

const WORKING_DIR_PATTERNS = [
  /Primary working directory:\s*([^\r\n]+)/i,
  /Working directory:\s*([^\r\n]+)/i,
  /cwd:\s*([^\r\n]+)/i,
];

const SESSION_UUID_RE = /session_([0-9a-fA-F-]{8,})/;
const CLAUDE_READ_LINE_RE = /^ *\d+→(.*)$/;
const SYSTEM_REMINDER_TRAIL_RE = /\n*<system-reminder>[\s\S]*?<\/system-reminder>\s*$/;
const RIPGREP_LINE_RE = /^(.+?):(\d+):(.*)$/;

export function flattenSystemPrompt(
  system: AnthropicMessagesRequest["system"],
): string | undefined {
  if (!system) return undefined;
  if (typeof system === "string") {
    return system.trim().length > 0 ? system : undefined;
  }
  if (Array.isArray(system)) {
    const joined = system
      .filter((b) => b && b.type === "text" && typeof b.text === "string" && b.text.length > 0)
      .map((b) => b.text)
      .join("\n\n");
    return joined.trim().length > 0 ? joined : undefined;
  }
  return undefined;
}

/**
 * Extract Claude Code's workspace directory from its system prompt when present.
 */
export function extractWorkspaceFromSystem(
  systemText: string | undefined,
  fallbackWorkspace: string,
): string {
  if (systemText) {
    for (const re of WORKING_DIR_PATTERNS) {
      const m = re.exec(systemText);
      const candidate = m?.[1]?.trim();
      if (candidate && path.isAbsolute(candidate)) {
        return candidate;
      }
    }
  }
  return fallbackWorkspace;
}

function extractFirstUserText(req: AnthropicMessagesRequest): string {
  for (const msg of req.messages ?? []) {
    if (msg?.role !== "user") continue;
    if (typeof msg.content === "string" && msg.content.trim()) {
      return msg.content.trim();
    }
    if (Array.isArray(msg.content)) {
      const texts = msg.content
        .filter((b): b is Extract<AnthropicContentBlock, { type: "text" }> => b?.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (texts) return texts;
    }
  }
  return "";
}

/**
 * Derive a stable session ID so `cursor-opencode-provider` preserves held Connect-RPC
 * tool-continuation streams across Turn 1 -> Tool Result Turn 2.
 * Returns `undefined` for zero-tool helper calls (title generation, command safety checks)
 * so they run as isolated ephemeral runs without disturbing the main conversation.
 */
export function deriveSessionId(
  req: AnthropicMessagesRequest,
  hasTools: boolean,
): string | undefined {
  if (!hasTools) {
    return undefined;
  }

  const userId = req.metadata?.user_id;
  if (typeof userId === "string" && userId.trim()) {
    const match = SESSION_UUID_RE.exec(userId);
    if (match?.[1]) {
      return `cc-${match[1]}`;
    }
    return `cc-${createHash("sha256").update(userId).digest("hex").slice(0, 24)}`;
  }

  const anchor = extractFirstUserText(req);
  if (!anchor) return undefined;
  return `cc-${createHash("sha256").update(anchor).digest("hex").slice(0, 24)}`;
}

/**
 * Unwrap Claude Code's `Read` tool `     1→content` envelope into raw file contents
 * so Cursor's native `read_result` receives exact file lines without `1→` prefixes.
 */
export function unwrapClaudeCodeReadResult(text: string): string {
  if (!text) return text;
  // Strip trailing <system-reminder> injected by Claude Code onto Read results
  const cleaned = text.replace(SYSTEM_REMINDER_TRAIL_RE, "");
  const lines = cleaned.split("\n");
  if (lines.length === 0) return text;

  // Verify whether at least the first non-empty lines match `     N→...`
  let checked = 0;
  let matched = 0;
  for (const line of lines) {
    if (line === "") continue;
    checked++;
    if (CLAUDE_READ_LINE_RE.test(line)) {
      matched++;
    }
    if (checked >= 5) break;
  }

  if (checked === 0 || matched < checked) {
    return cleaned;
  }

  return lines
    .map((line) => {
      const m = CLAUDE_READ_LINE_RE.exec(line);
      return m ? (m[1] ?? "") : line;
    })
    .join("\n");
}

/**
 * Format Claude Code's ripgrep (`filepath:line:content`) output into OpenCode's
 * `Found N matches\nfilepath:\n  Line N: content` shape so `cursor-opencode-provider`
 * encodes rich line previews in `grep_result` instead of falling back to file paths only.
 */
export function formatClaudeGrepForProvider(text: string): string {
  const trimmed = text.replace(SYSTEM_REMINDER_TRAIL_RE, "").trim();
  if (!trimmed || /^Found \d+ matches\b/.test(trimmed)) {
    return trimmed || "(no matches)";
  }

  const lines = trimmed.split("\n");
  const grouped = new Map<string, Array<{ lineNo: string; content: string }>>();
  let hitCount = 0;

  for (const line of lines) {
    const m = RIPGREP_LINE_RE.exec(line);
    if (!m) {
      // Not a ripgrep content line (e.g. files_with_matches list or count summary)
      if (hitCount === 0) return trimmed;
      continue;
    }
    const file = m[1]!;
    const lineNo = m[2]!;
    const content = m[3] ?? "";
    if (file.includes("://")) continue;
    let bucket = grouped.get(file);
    if (!bucket) {
      bucket = [];
      grouped.set(file, bucket);
    }
    bucket.push({ lineNo, content });
    hitCount++;
  }

  if (hitCount === 0) {
    return trimmed;
  }

  const out: string[] = [`Found ${hitCount} matches`];
  for (const [file, entries] of grouped.entries()) {
    out.push(`${file}:`);
    for (const entry of entries) {
      out.push(`  Line ${entry.lineNo}: ${entry.content}`);
    }
  }
  return out.join("\n");
}

function extractToolResultContent(
  block: AnthropicToolResultBlock,
): { text: string; images: Array<{ mediaType: string; data: string }> } {
  if (typeof block.content === "string") {
    return { text: block.content, images: [] };
  }
  if (!Array.isArray(block.content)) {
    return { text: "", images: [] };
  }
  const texts: string[] = [];
  const images: Array<{ mediaType: string; data: string }> = [];
  for (const part of block.content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && "text" in part && typeof part.text === "string") {
      texts.push(part.text);
    } else if (part.type === "image" && "source" in part && part.source && typeof part.source === "object") {
      const src = part.source as { type?: string; media_type?: string; data?: string };
      if (src.type === "base64" && typeof src.data === "string") {
        images.push({
          mediaType: src.media_type || "image/png",
          data: src.data,
        });
      }
    }
  }
  return { text: texts.join("\n"), images };
}

/**
 * Translate an Anthropic `/v1/messages` request into an AI SDK `LanguageModelV3Prompt`.
 */
export function translateAnthropicToV3Prompt(
  req: AnthropicMessagesRequest,
  registry: ToolTranslationRegistry,
): LanguageModelV3Prompt {
  const prompt: LanguageModelV3Prompt = [];

  const systemText = flattenSystemPrompt(req.system);
  if (systemText) {
    prompt.push({ role: "system", content: systemText });
  }

  // Track provider tool names by tool_use_id so subsequent tool_result blocks correlate cleanly
  const toolNameByCallId = new Map<string, string>();

  for (const msg of req.messages ?? []) {
    if (!msg) continue;

    if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        if (msg.content.length > 0) {
          prompt.push({
            role: "assistant",
            content: [{ type: "text", text: msg.content }],
          });
        }
        continue;
      }

      if (!Array.isArray(msg.content)) continue;
      const parts: any[] = [];
      for (const block of msg.content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
          parts.push({ type: "text", text: block.text });
        } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.length > 0) {
          parts.push({ type: "reasoning", text: block.thinking });
        } else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
          const rawInput =
            block.input && typeof block.input === "object" && !Array.isArray(block.input)
              ? (block.input as Record<string, unknown>)
              : {};
          const translated = translateHostToolUseToProvider(block.name, rawInput, registry);
          toolNameByCallId.set(block.id, translated.toolName);
          parts.push({
            type: "tool-call",
            toolCallId: block.id,
            toolName: translated.toolName,
            input: translated.input,
          });
        }
      }
      if (parts.length > 0) {
        prompt.push({ role: "assistant", content: parts });
      }
      continue;
    }

    // msg.role === "user"
    if (typeof msg.content === "string") {
      if (msg.content.length > 0) {
        prompt.push({
          role: "user",
          content: [{ type: "text", text: msg.content }],
        });
      }
      continue;
    }

    if (!Array.isArray(msg.content)) continue;

    const toolResults: AnthropicToolResultBlock[] = [];
    const userParts: any[] = [];

    for (const block of msg.content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "tool_result") {
        toolResults.push(block);
      } else if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
        userParts.push({ type: "text", text: block.text });
      } else if (block.type === "image" && block.source) {
        if (block.source.type === "base64" && typeof block.source.data === "string") {
          userParts.push({
            type: "file",
            mediaType: block.source.media_type || "image/png",
            data: block.source.data,
          });
        } else if (block.source.type === "url" && typeof block.source.url === "string") {
          userParts.push({
            type: "file",
            mediaType: block.source.media_type || "image/png",
            data: new URL(block.source.url),
          });
        }
      }
    }

    // Emit tool results FIRST so they sit immediately adjacent to the prior assistant `tool-call` message!
    const validToolResultParts: any[] = [];
    for (const tr of toolResults) {
      const callId = tr.tool_use_id;
      const toolName = toolNameByCallId.get(callId);
      const extracted = extractToolResultContent(tr);

      if (!toolName) {
        // Orphaned tool result (e.g. after context compaction dropped the assistant turn):
        // preserve as user text rather than crashing correlation.
        if (extracted.text) {
          userParts.unshift({
            type: "text",
            text: `[Tool result ${callId}]: ${extracted.text}`,
          });
        }
        continue;
      }

      let formattedText = extracted.text;
      if (!tr.is_error) {
        if (toolName === "read") {
          formattedText = unwrapClaudeCodeReadResult(formattedText);
        } else if (toolName === "grep") {
          formattedText = formatClaudeGrepForProvider(formattedText);
        }
      }

      if (extracted.images.length > 0 && !tr.is_error) {
        const contentItems: any[] = [];
        if (formattedText) {
          contentItems.push({ type: "text", text: formattedText });
        }
        for (const img of extracted.images) {
          contentItems.push({
            type: "media",
            mediaType: img.mediaType,
            data: img.data,
          });
        }
        validToolResultParts.push({
          type: "tool-result",
          toolCallId: callId,
          toolName,
          output: { type: "content", value: contentItems },
        });
      } else {
        validToolResultParts.push({
          type: "tool-result",
          toolCallId: callId,
          toolName,
          output: {
            type: tr.is_error ? "error-text" : "text",
            value: formattedText || (tr.is_error ? "Tool execution failed" : "(no output)"),
          },
        });
      }
    }

    if (validToolResultParts.length > 0) {
      prompt.push({
        role: "tool",
        content: validToolResultParts,
      });
    }

    if (userParts.length > 0) {
      prompt.push({
        role: "user",
        content: userParts,
      });
    }
  }

  // Ensure prompt always ends or contains at least one non-system message
  if (!prompt.some((m) => m.role !== "system")) {
    prompt.push({
      role: "user",
      content: [{ type: "text", text: "Hello" }],
    });
  }

  return prompt;
}

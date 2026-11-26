export interface AnthropicCacheControl {
  type: "ephemeral";
  ttl?: string;
}

export interface AnthropicTextBlock {
  type: "text";
  text: string;
  cache_control?: AnthropicCacheControl;
}

export interface AnthropicThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export interface AnthropicRedactedThinkingBlock {
  type: "redacted_thinking";
  data: string;
}

export interface AnthropicImageSource {
  type: "base64" | "url";
  media_type?: string;
  data?: string;
  url?: string;
}

export interface AnthropicImageBlock {
  type: "image";
  source: AnthropicImageSource;
  cache_control?: AnthropicCacheControl;
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  cache_control?: AnthropicCacheControl;
}

export type AnthropicToolResultContentPart =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | { type: string; [key: string]: unknown };

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: string | AnthropicToolResultContentPart[];
  is_error?: boolean;
  cache_control?: AnthropicCacheControl;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicToolDefinition {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  type?: string;
  cache_control?: AnthropicCacheControl;
}

export interface AnthropicThinkingConfig {
  type: "enabled" | "disabled" | "adaptive";
  budget_tokens?: number;
}

export interface AnthropicMessagesRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicTextBlock[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: AnthropicToolDefinition[];
  tool_choice?: {
    type: "auto" | "any" | "tool" | "none";
    name?: string;
    disable_parallel_tool_use?: boolean;
  };
  thinking?: AnthropicThinkingConfig;
  output_config?: {
    effort?: "low" | "medium" | "high" | "xhigh" | "max" | string;
  };
  metadata?: {
    user_id?: string;
    [key: string]: unknown;
  };
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export type AnthropicStopReason = "end_turn" | "max_tokens" | "stop_sequence" | "tool_use";

export interface AnthropicMessagesResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: AnthropicStopReason | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

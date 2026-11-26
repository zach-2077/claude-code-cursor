import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { ResolvedCursorModel } from "../models.js";

export interface StreamTurnInput {
  model: ResolvedCursorModel;
  callOptions: LanguageModelV3CallOptions;
}

export interface CursorBackend {
  readonly name: string;
  streamTurn(input: StreamTurnInput): Promise<ReadableStream<LanguageModelV3StreamPart>>;
}

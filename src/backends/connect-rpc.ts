import fs from "node:fs/promises";
import { createCursor } from "cursor-opencode-provider";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { CursorCredentialManager } from "../auth.js";
import type { ProxyServerConfig } from "../config.js";
import type { CursorBackend, StreamTurnInput } from "./types.js";

export class ConnectRpcCursorBackend implements CursorBackend {
  public readonly name = "connect-rpc";
  private sdkPromise: Promise<ReturnType<typeof createCursor>> | null = null;

  constructor(
    private readonly config: ProxyServerConfig,
    private readonly auth: CursorCredentialManager,
  ) {}

  private async getSdk(): Promise<ReturnType<typeof createCursor>> {
    if (!this.sdkPromise) {
      this.sdkPromise = (async () => {
        await fs.mkdir(this.config.cacheDir, { recursive: true });
        return createCursor({
          name: "cursor",
          getAccessToken: (opts) => this.auth.getAccessToken(opts),
          workspaceRoot: this.config.workspaceRoot,
          cacheDir: this.config.cacheDir,
          telemetryEnabled: false,
        });
      })();
    }
    return this.sdkPromise;
  }

  async streamTurn(input: StreamTurnInput): Promise<ReadableStream<LanguageModelV3StreamPart>> {
    const sdk = await this.getSdk();
    const lm = sdk.languageModel(input.model.wireModelId);

    const providerOptions = input.model.cursorProviderOptions
      ? {
          ...(input.callOptions.providerOptions ?? {}),
          cursor: {
            ...((input.callOptions.providerOptions?.cursor as Record<string, unknown>) ?? {}),
            ...input.model.cursorProviderOptions,
          },
        }
      : input.callOptions.providerOptions;

    const result = await lm.doStream({
      ...input.callOptions,
      ...(providerOptions ? { providerOptions: providerOptions as any } : {}),
    });

    return result.stream;
  }
}

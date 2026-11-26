import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "cursor-opencode-provider/models";
import { CursorModelRegistry } from "../src/models.js";

const MOCK_CATALOG: ModelInfo[] = [
  {
    id: "grok-4.7",
    displayName: "Grok 4.7",
    supportsThinking: true,
    supportsMaxMode: true,
    maxContext: 256_000,
    maxContextForMaxMode: 256_000,
    variants: [
      {
        key: "grok-4.7",
        displayName: "Grok 4.7 Low",
        isDefaultNonMax: false,
        isDefaultMax: false,
        parameterValues: [
          { id: "context", value: "256k" },
          { id: "reasoning_effort", value: "low" },
          { id: "fast", value: "false" },
        ],
      },
      {
        key: "grok-4.7",
        displayName: "Grok 4.7 Extra High",
        isDefaultNonMax: true,
        isDefaultMax: true,
        parameterValues: [
          { id: "context", value: "256k" },
          { id: "reasoning_effort", value: "xhigh" },
          { id: "fast", value: "false" },
        ],
      },
      {
        key: "grok-4.7",
        displayName: "Grok 4.7 500k Low",
        isDefaultNonMax: false,
        isDefaultMax: false,
        isMaxMode: true,
        parameterValues: [
          { id: "context", value: "500k" },
          { id: "reasoning_effort", value: "low" },
          { id: "fast", value: "false" },
        ],
      },
      {
        key: "grok-4.7",
        displayName: "Grok 4.7 500k Extra High",
        isDefaultNonMax: false,
        isDefaultMax: false,
        isMaxMode: true,
        parameterValues: [
          { id: "context", value: "500k" },
          { id: "reasoning_effort", value: "xhigh" },
          { id: "fast", value: "false" },
        ],
      },
    ],
  },
  {
    id: "gemini-4-carbon",
    displayName: "Gemini 4 Carbon",
    supportsThinking: true,
    supportsMaxMode: true,
    maxContext: 300_000,
    maxContextForMaxMode: 1_000_000,
    variants: [
      {
        key: "gemini-4-carbon",
        displayName: "Gemini 4 Carbon Medium",
        isDefaultNonMax: true,
        isDefaultMax: false,
        parameterValues: [
          { id: "context", value: "300k" },
          { id: "reasoning_effort", value: "medium" },
        ],
      },
      {
        key: "gemini-4-carbon",
        displayName: "Gemini 4 Carbon High",
        isDefaultNonMax: false,
        isDefaultMax: false,
        parameterValues: [
          { id: "context", value: "300k" },
          { id: "reasoning_effort", value: "high" },
        ],
      },
      {
        key: "gemini-4-carbon",
        displayName: "Gemini 4 Carbon 1M High",
        isDefaultNonMax: false,
        isDefaultMax: true,
        isMaxMode: true,
        parameterValues: [
          { id: "context", value: "1m" },
          { id: "reasoning_effort", value: "high" },
        ],
      },
    ],
  },
];

describe("Context window & thinking effort variant resolution", () => {
  test("maps Claude Code output_config.effort to exact Cursor variant tuple", () => {
    const reg = new CursorModelRegistry("grok-4.7", "grok-4.7");
    reg.setCatalogForTests(MOCK_CATALOG);

    const low = reg.resolve({ requestedModel: "grok-4.7", effort: "low" });
    expect(low.contextWindowTokens).toBe(256_000);
    expect(low.maxMode).toBe(false);
    expect(low.resolvedEffort).toBe("low");
    expect(low.variantParameters).toEqual([
      { id: "context", value: "256k" },
      { id: "reasoning_effort", value: "low" },
      { id: "fast", value: "false" },
    ]);

    // `max` clamps down to `xhigh` when `xhigh` is the highest advertised tier
    const clamped = reg.resolve({ requestedModel: "grok-4.7", effort: "max" });
    expect(clamped.resolvedEffort).toBe("xhigh");
  });

  test("unlocks Grok 4.7 500k tier via --ccc-max or [500k] bracket", () => {
    const reg = new CursorModelRegistry({
      defaultModel: "grok-4.7[500k]",
      fastModel: "grok-4.7",
    });
    reg.setCatalogForTests(MOCK_CATALOG);

    // Even when Claude Code sends plain `grok-4.7` on the wire, inherited [500k] bracket wins
    const res = reg.resolve({ requestedModel: "grok-4.7", effort: "low" });
    expect(res.maxMode).toBe(true);
    expect(res.contextWindowTokens).toBe(500_000);
    expect(res.variantParameters).toEqual([
      { id: "context", value: "500k" },
      { id: "reasoning_effort", value: "low" },
      { id: "fast", value: "false" },
    ]);
  });

  test("preserves Gemini 4 Carbon [1m] max-mode tier after Claude Code strips [1m] suffix", () => {
    const reg = new CursorModelRegistry({
      defaultModel: "gemini-4-carbon[1m]",
      fastModel: "gemini-4-carbon",
    });
    reg.setCatalogForTests(MOCK_CATALOG);

    // Claude Code strips `[1m]` and sends `requestedModel: "gemini-4-carbon"` with `effort: "xhigh"`
    const res = reg.resolve({ requestedModel: "gemini-4-carbon", effort: "xhigh" });
    expect(res.maxMode).toBe(true);
    expect(res.contextWindowTokens).toBe(1_000_000);
    // Clamped from xhigh -> high (highest advertised on gemini-4-carbon)
    expect(res.resolvedEffort).toBe("high");
    expect(res.variantParameters).toEqual([
      { id: "context", value: "1m" },
      { id: "reasoning_effort", value: "high" },
    ]);
  });

  test("resolves stateless hyphenated suffixes like gemini-4-carbon-1m and grok-4.7-500k", () => {
    const reg = new CursorModelRegistry("composer-2.5", "composer-2.5");
    reg.setCatalogForTests(MOCK_CATALOG);

    const g1m = reg.resolve({ requestedModel: "gemini-4-carbon-1m", effort: "high" });
    expect(g1m.wireModelId).toBe("gemini-4-carbon");
    expect(g1m.maxMode).toBe(true);
    expect(g1m.contextWindowTokens).toBe(1_000_000);

    const grok500 = reg.resolve({ requestedModel: "grok-4.7-500k", effort: "low" });
    expect(grok500.wireModelId).toBe("grok-4.7");
    expect(grok500.maxMode).toBe(true);
    expect(grok500.contextWindowTokens).toBe(500_000);
    expect(grok500.variantParameters).toEqual([
      { id: "context", value: "500k" },
      { id: "reasoning_effort", value: "low" },
      { id: "fast", value: "false" },
    ]);
  });
});

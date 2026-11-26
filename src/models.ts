import {
  CURSOR_VARIANT_PARAMETERS_KEY,
  CURSOR_WIRE_MODEL_ID_KEY,
  discoverModels,
  parseCursorContextLimit,
  type ModelInfo,
  type ModelParameterValue,
  type ModelVariant,
} from "cursor-opencode-provider/models";
import type { AnthropicThinkingConfig } from "./translate/anthropic-types.js";

export type CanonicalEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ResolveModelInput {
  requestedModel?: string;
  /** From Claude Code `output_config.effort` (`low`|`medium`|`high`|`xhigh`|`max`) */
  effort?: string;
  /** From Claude Code `thinking` config (`enabled`|`adaptive`|`disabled`, `budget_tokens`) */
  thinking?: AnthropicThinkingConfig;
  /** Force Cursor max-mode context tier (e.g. 500k on Grok 4.7, 1M on Gemini 4) */
  maxMode?: boolean;
  /** Explicit target context window in tokens (e.g. 500_000, 1_000_000) */
  targetContextTokens?: number;
}

export interface ResolvedCursorModel {
  requestedModel: string;
  wireModelId: string;
  resolvedEffort?: string;
  maxMode: boolean;
  contextWindowTokens: number;
  variantParameters?: ModelParameterValue[];
  cursorProviderOptions: Record<string, unknown>;
}

const BRACKET_MODEL_RE = /^([^\[\]]+)\[(.*)\]$/;
const EFFORT_ORDER: readonly CanonicalEffort[] = ["none", "low", "medium", "high", "xhigh", "max"];
const EFFORT_PARAM_IDS = new Set(["effort", "reasoning_effort", "reasoning"]);

export interface ParsedBracketModel {
  baseId: string;
  /** Explicit `key=value` pairs inside `[...]` */
  parameters?: ModelParameterValue[];
  /** Shorthand context token tier inside `[...]`, e.g. `grok-4.7[500k]` or `gemini-4-carbon[1m]` */
  contextHintTokens?: number;
  /** Shorthand `[max]` inside `[...]` */
  maxHint?: boolean;
  /** Shorthand effort inside `[...]`, e.g. `grok-4.7[low]` */
  effortHint?: CanonicalEffort;
}

export function parseBracketedModel(raw: string): ParsedBracketModel {
  const trimmed = raw.trim();
  const match = BRACKET_MODEL_RE.exec(trimmed);
  if (!match) {
    return { baseId: trimmed };
  }
  const baseId = match[1]!.trim();
  const inside = match[2]!.trim();
  if (!inside) {
    return { baseId };
  }

  const params: ModelParameterValue[] = [];
  let contextHintTokens: number | undefined;
  let maxHint: boolean | undefined;
  let effortHint: CanonicalEffort | undefined;

  for (const part of inside.split(",")) {
    const token = part.trim();
    if (!token) continue;
    const eq = token.indexOf("=");
    if (eq > 0) {
      const id = token.slice(0, eq).trim();
      const value = token.slice(eq + 1).trim();
      if (id && value) {
        params.push({ id, value });
        if (id === "context") {
          contextHintTokens = parseCursorContextLimit(value) ?? contextHintTokens;
        } else if (EFFORT_PARAM_IDS.has(id) && isCanonicalEffort(value.toLowerCase())) {
          effortHint = value.toLowerCase() as CanonicalEffort;
        }
      }
      continue;
    }

    const lower = token.toLowerCase();
    if (lower === "max") {
      maxHint = true;
      continue;
    }
    if (isCanonicalEffort(lower)) {
      effortHint = lower;
      continue;
    }
    const ctxLimit = parseCursorContextLimit(lower);
    if (ctxLimit !== undefined) {
      contextHintTokens = ctxLimit;
    }
  }

  return {
    baseId,
    ...(params.length > 0 ? { parameters: params } : {}),
    ...(contextHintTokens !== undefined ? { contextHintTokens } : {}),
    ...(maxHint ? { maxHint: true } : {}),
    ...(effortHint ? { effortHint } : {}),
  };
}

function isCanonicalEffort(val: string): val is CanonicalEffort {
  return (EFFORT_ORDER as readonly string[]).includes(val);
}

export function normalizeRequestedEffort(
  effort?: string,
  thinking?: AnthropicThinkingConfig,
): CanonicalEffort | undefined {
  if (thinking?.type === "disabled") {
    return "none";
  }
  if (typeof effort === "string" && effort.trim()) {
    const lower = effort.trim().toLowerCase();
    if (lower === "ultracode") return "xhigh";
    if (isCanonicalEffort(lower)) return lower;
  }
  if (thinking?.type === "enabled" && typeof thinking.budget_tokens === "number") {
    const b = thinking.budget_tokens;
    if (b <= 0) return "none";
    if (b <= 4096) return "low";
    if (b <= 12000) return "medium";
    if (b <= 24000) return "high";
    return "xhigh";
  }
  return undefined;
}

function getVariantContextTokens(v: ModelVariant): number | undefined {
  const ctxVal = v.parameterValues.find((p) => p.id === "context")?.value;
  return parseCursorContextLimit(ctxVal);
}

function getVariantEffort(v: ModelVariant): string | undefined {
  return v.parameterValues.find((p) => EFFORT_PARAM_IDS.has(p.id))?.value?.toLowerCase();
}

function isVariantFast(v: ModelVariant): boolean {
  return v.parameterValues.find((p) => p.id === "fast")?.value === "true";
}

/**
 * Compute the base and max context window sizes advertised across a model's variants.
 */
export function getModelContextWindows(model: ModelInfo | undefined): {
  baseTokens: number;
  maxTokens: number;
  tiers: number[];
} {
  if (!model) {
    return { baseTokens: 200_000, maxTokens: 200_000, tiers: [200_000] };
  }
  const tierSet = new Set<number>();
  if (model.maxContext) tierSet.add(model.maxContext);
  if (model.maxContextForMaxMode) tierSet.add(model.maxContextForMaxMode);
  for (const v of model.variants) {
    const t = getVariantContextTokens(v);
    if (t) tierSet.add(t);
  }
  const tiers = [...tierSet].sort((a, b) => a - b);
  const baseTokens = model.maxContext ?? tiers[0] ?? 200_000;
  const maxTokens = tiers[tiers.length - 1] ?? model.maxContextForMaxMode ?? baseTokens;
  return {
    baseTokens,
    maxTokens,
    tiers: tiers.length > 0 ? tiers : [baseTokens],
  };
}

export function getModelSupportedEfforts(model: ModelInfo | undefined): string[] {
  if (!model) return [];
  const seen = new Set<string>();
  for (const v of model.variants) {
    const eff = getVariantEffort(v);
    if (eff) seen.add(eff);
    const optFor = v.parameterValues.find((p) => p.id === "optimize_for")?.value;
    if (optFor) seen.add(`optimize_for=${optFor}`);
  }
  return [...seen];
}

/**
 * Pick the closest supported effort value from candidates without inventing unadvertised tuples.
 * Follows Claude Code's rule: fall back to the highest supported level at or below requested,
 * or the lowest available level if requested is below all supported levels.
 */
function pickBestEffortMatch(
  candidates: readonly ModelVariant[],
  requested: CanonicalEffort,
): ModelVariant | undefined {
  // Handle `auto-smart` which uses `optimize_for` (`cost` | `balanced` | `intelligence`)
  const hasOptimizeFor = candidates.some((v) =>
    v.parameterValues.some((p) => p.id === "optimize_for"),
  );
  if (hasOptimizeFor) {
    const targetOpt =
      requested === "none" || requested === "low"
        ? "cost"
        : requested === "xhigh" || requested === "max"
          ? "intelligence"
          : "balanced";
    return candidates.find((v) =>
      v.parameterValues.some((p) => p.id === "optimize_for" && p.value === targetOpt),
    );
  }

  const exact = candidates.find((v) => getVariantEffort(v) === requested);
  if (exact) return exact;

  const reqIdx = EFFORT_ORDER.indexOf(requested);
  // Highest supported <= requested
  for (let i = reqIdx - 1; i >= 0; i--) {
    const level = EFFORT_ORDER[i]!;
    const found = candidates.find((v) => getVariantEffort(v) === level);
    if (found) return found;
  }
  // Lowest supported > requested (e.g. `none` requested on a model whose minimum is `low`)
  for (let i = reqIdx + 1; i < EFFORT_ORDER.length; i++) {
    const level = EFFORT_ORDER[i]!;
    const found = candidates.find((v) => getVariantEffort(v) === level);
    if (found) return found;
  }
  return undefined;
}

function selectCatalogVariant(
  model: ModelInfo,
  opts: {
    explicitParams?: ModelParameterValue[];
    effort?: CanonicalEffort;
    wantMaxMode: boolean;
    targetContextTokens?: number;
  },
): { variant?: ModelVariant; maxMode: boolean; contextTokens: number } {
  const windows = getModelContextWindows(model);
  if (model.variants.length === 0) {
    const maxMode = opts.wantMaxMode;
    return {
      maxMode,
      contextTokens: maxMode ? windows.maxTokens : windows.baseTokens,
    };
  }

  // 1. If user gave explicit `[k=v,...]` parameters, match against advertised variants
  if (opts.explicitParams && opts.explicitParams.length > 0) {
    const subsetMatch = model.variants.find((v) =>
      opts.explicitParams!.every((ep) =>
        v.parameterValues.some((vp) => vp.id === ep.id && vp.value === ep.value),
      ),
    );
    if (subsetMatch) {
      const isMax = subsetMatch.isMaxMode === true || opts.wantMaxMode;
      return {
        variant: subsetMatch,
        maxMode: isMax,
        contextTokens:
          getVariantContextTokens(subsetMatch) ?? (isMax ? windows.maxTokens : windows.baseTokens),
      };
    }
  }

  // 2. Filter by target context window or maxMode tier first
  let pool = [...model.variants];
  if (opts.targetContextTokens !== undefined) {
    // Pick variants whose context tier >= targetContextTokens (smallest sufficient), else largest tier
    const withCtx = pool
      .map((v) => ({ v, ctx: getVariantContextTokens(v) }))
      .filter((x): x is { v: ModelVariant; ctx: number } => x.ctx !== undefined);
    if (withCtx.length > 0) {
      const sufficient = withCtx
        .filter((x) => x.ctx >= opts.targetContextTokens!)
        .sort((a, b) => a.ctx - b.ctx);
      const chosenTier =
        sufficient[0]?.ctx ?? withCtx.sort((a, b) => b.ctx - a.ctx)[0]!.ctx;
      pool = withCtx.filter((x) => x.ctx === chosenTier).map((x) => x.v);
    }
  } else if (opts.wantMaxMode) {
    const maxPool = pool.filter((v) => v.isMaxMode === true);
    if (maxPool.length > 0) {
      pool = maxPool;
    }
  } else {
    const nonMaxPool = pool.filter((v) => v.isMaxMode !== true);
    if (nonMaxPool.length > 0) {
      pool = nonMaxPool;
    }
  }

  // Prefer non-fast unless user explicitly requested fast=true
  const nonFast = pool.filter((v) => !isVariantFast(v));
  const scoped = nonFast.length > 0 ? nonFast : pool;

  // 3. Filter by effort if specified
  let chosen: ModelVariant | undefined;
  if (opts.effort) {
    chosen = pickBestEffortMatch(scoped, opts.effort);
  }
  if (!chosen) {
    chosen =
      (opts.wantMaxMode
        ? scoped.find((v) => v.isDefaultMax)
        : scoped.find((v) => v.isDefaultNonMax)) ??
      scoped.find((v) => v.isDefaultNonMax) ??
      scoped[0];
  }

  const isMax = chosen?.isMaxMode === true || opts.wantMaxMode;
  const contextTokens =
    (chosen ? getVariantContextTokens(chosen) : undefined) ??
    (isMax ? windows.maxTokens : windows.baseTokens);

  return {
    variant: chosen,
    maxMode: isMax,
    contextTokens,
  };
}

function matchCatalogModel(
  candidate: string,
  catalog: readonly ModelInfo[],
): {
  model: ModelInfo;
  hyphenEffort?: CanonicalEffort;
  hyphenContextTokens?: number;
  hyphenMax?: boolean;
} | undefined {
  const exact = catalog.find((m) => m.id === candidate);
  if (exact) return { model: exact };

  const stripped = candidate.startsWith("cursor-") ? candidate.slice("cursor-".length) : candidate;
  const exactStripped = catalog.find((m) => m.id === stripped);
  if (exactStripped) return { model: exactStripped };

  // Sort longest ID first so `gemini-4-carbon` wins before any shorter prefix
  const sorted = [...catalog].sort((a, b) => b.id.length - a.id.length);
  for (const model of sorted) {
    if (stripped.startsWith(`${model.id}-`)) {
      const rest = stripped.slice(model.id.length + 1).toLowerCase();
      let hyphenEffort: CanonicalEffort | undefined;
      let hyphenContextTokens: number | undefined;
      let hyphenMax: boolean | undefined;

      for (const part of rest.split("-")) {
        if (!part) continue;
        if (part === "max") {
          // Notice `kimi-k3-max` / `deepseek-...-max` use `max` as an effort level if advertised,
          // otherwise treat `-max` as Max Mode context tier!
          const modelHasMaxEffort = model.variants.some((v) => getVariantEffort(v) === "max");
          if (modelHasMaxEffort && !hyphenEffort) {
            hyphenEffort = "max";
          } else {
            hyphenMax = true;
          }
          continue;
        }
        if (isCanonicalEffort(part)) {
          hyphenEffort = part;
          continue;
        }
        const ctxLimit = parseCursorContextLimit(part);
        if (ctxLimit !== undefined) {
          hyphenContextTokens = ctxLimit;
        }
      }

      return {
        model,
        ...(hyphenEffort ? { hyphenEffort } : {}),
        ...(hyphenContextTokens !== undefined ? { hyphenContextTokens } : {}),
        ...(hyphenMax ? { hyphenMax: true } : {}),
      };
    }
  }
  return undefined;
}

function isClaudeBuiltInAlias(modelId: string): "haiku" | "sonnet" | "opus" | null {
  const lower = modelId.toLowerCase();
  if (lower === "haiku" || lower.startsWith("claude-haiku") || lower.includes("-haiku-")) {
    return "haiku";
  }
  if (lower === "sonnet" || lower.startsWith("claude-sonnet") || lower.includes("-sonnet-")) {
    return "sonnet";
  }
  if (
    lower === "opus" ||
    lower === "best" ||
    lower === "fable" ||
    lower.startsWith("claude-opus") ||
    lower.startsWith("claude-fable") ||
    lower.includes("-opus-") ||
    lower.includes("-fable-")
  ) {
    return "opus";
  }
  return null;
}

export interface ModelRegistryDefaults {
  defaultModel: string;
  opusModel?: string;
  fastModel: string;
  defaultEffort?: string;
  maxMode?: boolean;
  contextTokensOverride?: number;
}

export class CursorModelRegistry {
  private catalog: ModelInfo[] = [];
  private loaded = false;
  private readonly defaults: ModelRegistryDefaults;

  constructor(
    defaultModelOrOpts: string | ModelRegistryDefaults,
    fastModel?: string,
    private readonly cacheDir: string = "",
  ) {
    if (typeof defaultModelOrOpts === "string") {
      this.defaults = {
        defaultModel: defaultModelOrOpts,
        opusModel: defaultModelOrOpts,
        fastModel: fastModel ?? defaultModelOrOpts,
      };
    } else {
      this.defaults = defaultModelOrOpts;
    }
  }

  async refresh(token: string, forceRefresh = false): Promise<ModelInfo[]> {
    try {
      this.catalog = await discoverModels(token, this.cacheDir, { forceRefresh });
      this.loaded = true;
    } catch {
      // Keep existing catalog on transient errors
    }
    return this.catalog;
  }

  setCatalogForTests(models: ModelInfo[]): void {
    this.catalog = [...models];
    this.loaded = true;
  }

  getCatalog(): readonly ModelInfo[] {
    return this.catalog;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  resolve(input: string | ResolveModelInput | undefined): ResolvedCursorModel {
    const req: ResolveModelInput =
      typeof input === "string" || input === undefined ? { requestedModel: input } : input;

    const requestedModel = (req.requestedModel ?? "").trim() || this.defaults.defaultModel;
    const outerParsed = parseBracketedModel(requestedModel);

    const unprefixed = outerParsed.baseId
      .replace(/^cursor-acp\//, "")
      .replace(/^cursor\//, "");

    let targetRaw = requestedModel;
    const claudeTier = isClaudeBuiltInAlias(unprefixed);
    if (claudeTier) {
      const availableDirectly = this.catalog.some((m) => m.id === unprefixed);
      if (!availableDirectly) {
        targetRaw =
          claudeTier === "haiku"
            ? this.defaults.fastModel
            : claudeTier === "opus"
              ? (this.defaults.opusModel ?? this.defaults.defaultModel)
              : this.defaults.defaultModel;
      }
    }

    const targetParsed = parseBracketedModel(targetRaw);
    const baseCandidate = targetParsed.baseId
      .replace(/^cursor-acp\//, "")
      .replace(/^cursor\//, "");

    // Claude Code strips `[1m]` from `ANTHROPIC_DEFAULT_SONNET_MODEL` before sending
    // `body.model` on the wire. Inherit bracket hints from `defaults.defaultModel`
    // (or `defaults.opusModel`) whenever `baseCandidate` matches that configured model!
    const defaultParsed = parseBracketedModel(this.defaults.defaultModel);
    const defaultBase = defaultParsed.baseId.replace(/^cursor-acp\//, "").replace(/^cursor\//, "");
    const opusParsed = this.defaults.opusModel ? parseBracketedModel(this.defaults.opusModel) : undefined;
    const opusBase = opusParsed?.baseId.replace(/^cursor-acp\//, "").replace(/^cursor\//, "");
    const inheritedBracket =
      baseCandidate === defaultBase
        ? defaultParsed
        : baseCandidate === opusBase
          ? opusParsed
          : undefined;

    const effort =
      normalizeRequestedEffort(req.effort, req.thinking) ??
      outerParsed.effortHint ??
      targetParsed.effortHint ??
      inheritedBracket?.effortHint ??
      normalizeRequestedEffort(this.defaults.defaultEffort);

    const targetContextTokens =
      req.targetContextTokens ??
      outerParsed.contextHintTokens ??
      targetParsed.contextHintTokens ??
      inheritedBracket?.contextHintTokens ??
      this.defaults.contextTokensOverride;

    const wantMaxMode =
      req.maxMode === true ||
      outerParsed.maxHint === true ||
      targetParsed.maxHint === true ||
      inheritedBracket?.maxHint === true ||
      this.defaults.maxMode === true;

    let wireModelId = baseCandidate === "auto" ? "default" : baseCandidate;
    let catalogModel: ModelInfo | undefined;
    let hyphenEffort: CanonicalEffort | undefined;
    let hyphenContextTokens: number | undefined;
    let hyphenMax: boolean | undefined;

    if (this.catalog.length > 0) {
      const matched = matchCatalogModel(baseCandidate, this.catalog);
      if (matched) {
        catalogModel = matched.model;
        wireModelId = matched.model.id;
        hyphenEffort = matched.hyphenEffort;
        hyphenContextTokens = matched.hyphenContextTokens;
        hyphenMax = matched.hyphenMax;
      } else if (baseCandidate === "auto") {
        catalogModel = this.catalog.find((m) => m.id === "auto-smart");
        if (catalogModel) wireModelId = catalogModel.id;
      }
    }

    const effectiveEffort = effort ?? hyphenEffort;
    const effectiveTargetContext = targetContextTokens ?? hyphenContextTokens;
    const effectiveWantMax = wantMaxMode || hyphenMax === true;
    const explicitParams =
      outerParsed.parameters ?? targetParsed.parameters ?? inheritedBracket?.parameters;

    let variantParameters: ModelParameterValue[] | undefined = explicitParams;
    let resolvedMaxMode = effectiveWantMax;
    let contextWindowTokens = effectiveTargetContext ?? 200_000;
    let resolvedEffort: string | undefined = effectiveEffort;

    if (catalogModel) {
      const selected = selectCatalogVariant(catalogModel, {
        explicitParams,
        effort: effectiveEffort,
        wantMaxMode: effectiveWantMax,
        targetContextTokens: effectiveTargetContext,
      });
      if (selected.variant) {
        variantParameters = selected.variant.parameterValues.map((p) => ({ ...p }));
        resolvedEffort = getVariantEffort(selected.variant) ?? resolvedEffort;
      }
      resolvedMaxMode = selected.maxMode;
      contextWindowTokens = effectiveTargetContext ?? selected.contextTokens;
    } else if (effectiveTargetContext) {
      contextWindowTokens = effectiveTargetContext;
    }

    const cursorProviderOptions: Record<string, unknown> = {
      [CURSOR_WIRE_MODEL_ID_KEY]: wireModelId,
      maxMode: resolvedMaxMode,
    };
    if (variantParameters && variantParameters.length > 0) {
      cursorProviderOptions[CURSOR_VARIANT_PARAMETERS_KEY] = variantParameters;
    } else if (effectiveEffort) {
      cursorProviderOptions.reasoningEffort = effectiveEffort;
    }

    return {
      requestedModel,
      wireModelId,
      resolvedEffort,
      maxMode: resolvedMaxMode,
      contextWindowTokens,
      variantParameters,
      cursorProviderOptions,
    };
  }
}

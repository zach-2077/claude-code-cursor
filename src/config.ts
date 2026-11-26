import os from "node:os";
import path from "node:path";

export interface ProxyServerConfig {
  host: string;
  port: number;
  defaultModel: string;
  opusModel: string;
  fastModel: string;
  defaultEffort?: string;
  maxMode?: boolean;
  contextTokensOverride?: number;
  autoCompactWindow?: number;
  workspaceRoot: string;
  cacheDir: string;
  dataDir: string;
  debug: boolean;
}

export function parseTokenCountSpec(raw: string | number | undefined): number | undefined {
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
  }
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const trimmed = raw.trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)\s*([km])?$/.exec(trimmed);
  if (!match) return undefined;
  const num = Number(match[1]);
  const unit = match[2];
  const mult = unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1;
  const result = Math.floor(num * mult);
  return Number.isFinite(result) && result > 0 ? result : undefined;
}

export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CCC_DATA_DIR?.trim()) {
    return path.resolve(env.CCC_DATA_DIR.trim());
  }
  return path.join(os.homedir(), ".claude-code-cursor");
}

export function resolveCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CCC_CACHE_DIR?.trim()) {
    return path.resolve(env.CCC_CACHE_DIR.trim());
  }
  return path.join(resolveDataDir(env), "cache");
}

function parseBoolEnv(raw: string | undefined): boolean | undefined {
  if (!raw?.trim()) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return undefined;
}

export function resolveConfig(
  overrides: Partial<ProxyServerConfig> = {},
  env: NodeJS.ProcessEnv = process.env,
): ProxyServerConfig {
  const host = overrides.host ?? env.CCC_HOST?.trim() ?? "127.0.0.1";
  const rawPort = overrides.port ?? (env.CCC_PORT ? Number(env.CCC_PORT) : 32125);
  const port = Number.isFinite(rawPort) && rawPort >= 0 ? Math.floor(rawPort) : 32125;

  const defaultModel =
    overrides.defaultModel ??
    env.CCC_MODEL?.trim() ??
    env.CURSOR_DEFAULT_MODEL?.trim() ??
    "composer-2.5";

  const opusModel =
    overrides.opusModel ??
    env.CCC_OPUS_MODEL?.trim() ??
    defaultModel;

  const fastModel =
    overrides.fastModel ??
    env.CCC_FAST_MODEL?.trim() ??
    env.CURSOR_FAST_MODEL?.trim() ??
    defaultModel;

  const defaultEffort =
    overrides.defaultEffort ??
    env.CCC_EFFORT?.trim() ??
    undefined;

  const maxMode =
    overrides.maxMode ??
    parseBoolEnv(env.CCC_MAX_MODE);

  const contextTokensOverride =
    overrides.contextTokensOverride ??
    parseTokenCountSpec(env.CCC_CTX);

  const autoCompactWindow =
    overrides.autoCompactWindow ??
    parseTokenCountSpec(env.CCC_AUTOCOMPACT);

  const workspaceRoot = path.resolve(
    overrides.workspaceRoot ?? env.CCC_WORKSPACE?.trim() ?? process.cwd(),
  );

  const debug = overrides.debug ?? parseBoolEnv(env.CCC_DEBUG) ?? false;

  return {
    host,
    port,
    defaultModel,
    opusModel,
    fastModel,
    defaultEffort,
    maxMode,
    contextTokensOverride,
    autoCompactWindow,
    workspaceRoot,
    cacheDir: overrides.cacheDir ?? resolveCacheDir(env),
    dataDir: overrides.dataDir ?? resolveDataDir(env),
    debug,
  };
}

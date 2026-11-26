import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildLoginUrl,
  decodeJwtExpiryMs,
  decodeJwtPayload,
  exchangeApiKey,
  generatePkceChallenge,
  generatePkceParams,
  isExchangeableApiKey,
  isExpiringSoon,
  pollForTokens,
  refreshCursorSession,
} from "cursor-opencode-provider/auth";

export type AuthSource =
  | "env-access-token"
  | "env-api-key"
  | "stored-file"
  | "macos-keychain"
  | "linux-secret-tool"
  | "cursor-cli-config";

export interface ResolvedCredentials {
  accessToken: string;
  refreshToken?: string;
  apiKey?: string;
  source: AuthSource;
  expiresAtMs?: number | null;
  subject?: string;
}

interface StoredAuthRecord {
  accessToken: string;
  refreshToken?: string;
  apiKey?: string;
  updatedAt: number;
}

function readMacOsKeychainSecret(service: string): string | undefined {
  if (os.platform() !== "darwin") return undefined;
  try {
    const out = execFileSync("security", ["find-generic-password", "-s", service, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

async function readCursorCliAuthJson(): Promise<{ accessToken?: string; refreshToken?: string } | undefined> {
  const home = os.homedir();
  const candidates = [
    path.join(home, ".config", "cursor", "auth.json"),
    path.join(home, ".cursor", "cli-auth.json"),
    path.join(home, ".cursor-agent", "auth.json"),
  ];
  for (const file of candidates) {
    try {
      const raw = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
      const accessToken = typeof raw.accessToken === "string" ? raw.accessToken : undefined;
      const refreshToken = typeof raw.refreshToken === "string" ? raw.refreshToken : undefined;
      if (accessToken || refreshToken) {
        return { accessToken, refreshToken };
      }
    } catch {
      // ignore missing/unreadable files
    }
  }
  return undefined;
}

export class CursorCredentialManager {
  private cached: ResolvedCredentials | null = null;
  private inflightRefresh: Promise<string> | null = null;

  constructor(
    private readonly dataDir: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  private authFilePath(): string {
    return path.join(this.dataDir, "auth.json");
  }

  private async readStoredFile(): Promise<StoredAuthRecord | undefined> {
    try {
      const text = await fs.readFile(this.authFilePath(), "utf8");
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (typeof parsed.accessToken === "string" && parsed.accessToken.length > 0) {
        return {
          accessToken: parsed.accessToken,
          refreshToken: typeof parsed.refreshToken === "string" ? parsed.refreshToken : undefined,
          apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : undefined,
          updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
        };
      }
    } catch {
      // ignore
    }
    return undefined;
  }

  async saveStoredFile(record: Omit<StoredAuthRecord, "updatedAt">): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const payload: StoredAuthRecord = { ...record, updatedAt: Date.now() };
    await fs.writeFile(this.authFilePath(), JSON.stringify(payload, null, 2), { mode: 0o600 });
    this.cached = null;
  }

  async resolveInitial(): Promise<ResolvedCredentials> {
    // 1. Explicit env token
    const envToken = this.env.CURSOR_ACCESS_TOKEN?.trim();
    if (envToken) {
      return this.decorate({
        accessToken: envToken,
        source: "env-access-token",
      });
    }

    // 2. Explicit CURSOR_API_KEY
    const envApiKey = this.env.CURSOR_API_KEY?.trim();
    if (envApiKey) {
      if (isExchangeableApiKey(envApiKey)) {
        const pair = await exchangeApiKey(envApiKey);
        return this.decorate({
          accessToken: pair.accessToken,
          refreshToken: pair.refreshToken,
          apiKey: envApiKey,
          source: "env-api-key",
        });
      }
      return this.decorate({
        accessToken: envApiKey,
        source: "env-api-key",
      });
    }

    // 3. Stored file from `ccc login`
    const stored = await this.readStoredFile();
    if (stored) {
      return this.decorate({
        accessToken: stored.accessToken,
        refreshToken: stored.refreshToken,
        apiKey: stored.apiKey,
        source: "stored-file",
      });
    }

    // 4. macOS Keychain populated by `cursor-agent login`
    const keychainAccess = readMacOsKeychainSecret("cursor-access-token");
    const keychainRefresh = readMacOsKeychainSecret("cursor-refresh-token");
    if (keychainAccess) {
      return this.decorate({
        accessToken: keychainAccess,
        refreshToken: keychainRefresh ?? keychainAccess,
        source: "macos-keychain",
      });
    }

    // 5. Linux / XDG cursor CLI config files
    const cliJson = await readCursorCliAuthJson();
    if (cliJson?.accessToken) {
      return this.decorate({
        accessToken: cliJson.accessToken,
        refreshToken: cliJson.refreshToken ?? cliJson.accessToken,
        source: "cursor-cli-config",
      });
    }

    throw new Error(
      "No Cursor credentials found. Run `cursor-agent login`, `ccc login`, or set CURSOR_API_KEY.",
    );
  }

  private decorate(creds: ResolvedCredentials): ResolvedCredentials {
    const payload = decodeJwtPayload(creds.accessToken);
    const sub = typeof payload?.sub === "string" ? payload.sub : undefined;
    return {
      ...creds,
      expiresAtMs: decodeJwtExpiryMs(creds.accessToken),
      subject: sub,
    };
  }

  /**
   * AccessTokenProvider compatible with `cursor-opencode-provider`'s `getAccessToken`.
   */
  async getAccessToken(opts?: { forceRefresh?: boolean }): Promise<string> {
    if (!this.cached) {
      this.cached = await this.resolveInitial();
    }

    const needsRefresh =
      opts?.forceRefresh === true || isExpiringSoon(this.cached.accessToken, 300);

    if (!needsRefresh) {
      return this.cached.accessToken;
    }

    if (this.inflightRefresh) {
      return this.inflightRefresh;
    }

    this.inflightRefresh = this.refreshInternal().finally(() => {
      this.inflightRefresh = null;
    });
    return this.inflightRefresh;
  }

  private async refreshInternal(): Promise<string> {
    if (!this.cached) {
      this.cached = await this.resolveInitial();
    }

    // Re-read macOS Keychain first in case `cursor-agent` already refreshed it
    if (this.cached.source === "macos-keychain") {
      const freshKeychainAccess = readMacOsKeychainSecret("cursor-access-token");
      const freshKeychainRefresh = readMacOsKeychainSecret("cursor-refresh-token");
      if (freshKeychainAccess && !isExpiringSoon(freshKeychainAccess, 300)) {
        this.cached = this.decorate({
          accessToken: freshKeychainAccess,
          refreshToken: freshKeychainRefresh ?? freshKeychainAccess,
          source: "macos-keychain",
        });
        return this.cached.accessToken;
      }
    }

    if (this.cached.apiKey && isExchangeableApiKey(this.cached.apiKey)) {
      const pair = await exchangeApiKey(this.cached.apiKey);
      this.cached = this.decorate({
        ...this.cached,
        accessToken: pair.accessToken,
        refreshToken: pair.refreshToken,
      });
      if (this.cached.source === "stored-file") {
        await this.saveStoredFile({
          accessToken: pair.accessToken,
          refreshToken: pair.refreshToken,
          apiKey: this.cached.apiKey,
        });
      }
      return this.cached.accessToken;
    }

    const refreshToken = this.cached.refreshToken || this.cached.accessToken;
    const refreshed = await refreshCursorSession(refreshToken);
    if (refreshed.ok) {
      this.cached = this.decorate({
        ...this.cached,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.accessToken,
      });
      if (this.cached.source === "stored-file") {
        await this.saveStoredFile({
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.accessToken,
        });
      }
      return this.cached.accessToken;
    }

    // If token hasn't strictly expired yet, allow using it on transient refresh errors
    const exp = decodeJwtExpiryMs(this.cached.accessToken);
    if (exp && exp > Date.now() + 5_000) {
      return this.cached.accessToken;
    }

    throw new Error(`Cursor token refresh failed (${refreshed.kind}): ${refreshed.message}`);
  }

  async interactiveBrowserLogin(onUrl: (url: string) => void, signal?: AbortSignal): Promise<ResolvedCredentials> {
    const pkce = generatePkceParams();
    pkce.challenge = await generatePkceChallenge(pkce.verifier);
    const url = buildLoginUrl(pkce.challenge, pkce.uuid);
    onUrl(url);
    const pair = await pollForTokens(pkce.uuid, pkce.verifier, undefined, signal);
    await this.saveStoredFile({
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
    });
    this.cached = await this.resolveInitial();
    return this.cached;
  }
}

import type { JsonValue, ProviderContext } from "cursor-byok:provider";
import type {
  ResourceDraft,
  ResourceImportSupport,
  ResourceMetric,
  ResourcePatch,
  ResourceSnapshot,
  ResourceState,
  ResourceView,
} from "cursor-byok:resource";

export const RESOURCE_TYPE = "opencode-account";

export const API_BASE = "https://opencode.ai/zen/go/v1";
export const USAGE_URL = `${API_BASE}/usage`;
export const MODELS_URL = `${API_BASE}/models`;
export const OPENCODE_UA = "opencode/1.18.31";
export const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

const RATE_LIMIT_FALLBACK_MS = 60 * 1000;
const ROLLING_FALLBACK_MS = 5 * 60 * 60 * 1000;
const USAGE_CACHE_TTL_MS = 5 * 60 * 1000;
const USAGE_429_COOLDOWN_MS = 3 * 60 * 1000;

export type QuotaWindow = {
  remainingPercent: number;
  resetAtMs: number | null;
};

export type AccountQuota = {
  planLabel: string | null;
  rolling: QuotaWindow | null;
  weekly: QuotaWindow | null;
  monthly: QuotaWindow | null;
  limitReached: boolean;
  coolingUntilMs: number | null;
  updatedAtMs: number;
};

export type AccountData = {
  apiKey: string;
  displayName: string;
  planLabel?: string | null;
  quota?: AccountQuota | null;
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function timestampMs(value: unknown): number | null {
  const numeric = number(value);
  if (numeric !== null && numeric > 0) {
    return numeric > 10_000_000_000 ? Math.round(numeric) : Math.round(numeric * 1000);
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function accountData(resource: ResourceSnapshot): AccountData {
  const data = object(resource.privateData) as unknown as AccountData | null;
  if (!data || typeof data.apiKey !== "string" || !data.apiKey) {
    throw new Error("Import an OpenCode Go API key before calling this model");
  }
  return data;
}

export function keyTail(key: string): string {
  return `...${key.slice(-4)}`;
}

export function authHeaders(apiKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    accept: "application/json",
    "x-opencode-client": "desktop",
    "user-agent": OPENCODE_UA,
  };
}

function quotaWindow(value: unknown): QuotaWindow | null {
  const window = object(value);
  if (!window) return null;
  const percent = number(window.percent);
  if (percent === null) return null;
  return {
    // OpenCode Go reports percent USED, not remaining.
    remainingPercent: clampPercent(100 - percent),
    resetAtMs: timestampMs(window.resetsAt ?? window.resets_at),
  };
}

export function parseOpenCodeUsage(body: unknown, nowMs = Date.now()): AccountQuota | null {
  const usage = object(object(body)?.usage);
  if (!usage) return null;
  const rolling = quotaWindow(usage.rolling);
  const weekly = quotaWindow(usage.weekly);
  const monthly = quotaWindow(usage.monthly);
  if (!rolling && !weekly && !monthly) return null;
  const exhausted = [rolling, weekly, monthly].some(
    (window) => window !== null && window.remainingPercent <= 0 &&
      (window.resetAtMs === null || window.resetAtMs > nowMs),
  );
  const quota: AccountQuota = {
    planLabel: "OpenCode Go",
    rolling,
    weekly,
    monthly,
    limitReached: exhausted,
    coolingUntilMs: null,
    updatedAtMs: nowMs,
  };
  quota.coolingUntilMs = quotaCoolingUntil(quota, nowMs);
  return quota;
}

function windowCoolingUntil(window: QuotaWindow | null, nowMs: number): number | null {
  if (!window || window.remainingPercent > 0) return null;
  if (window.resetAtMs !== null && window.resetAtMs <= nowMs) return null;
  return window.resetAtMs ?? nowMs + ROLLING_FALLBACK_MS;
}

export function quotaCoolingUntil(quota: AccountQuota | null, nowMs = Date.now()): number | null {
  if (!quota) return null;
  const resets = [
    windowCoolingUntil(quota.rolling, nowMs),
    windowCoolingUntil(quota.weekly, nowMs),
    windowCoolingUntil(quota.monthly, nowMs),
    quota.coolingUntilMs !== null && quota.coolingUntilMs > nowMs
      ? quota.coolingUntilMs
      : null,
  ].filter((value): value is number => value !== null);
  if (resets.length > 0) return Math.max(...resets);
  return quota.limitReached ? nowMs + ROLLING_FALLBACK_MS : null;
}

export function quotaState(quota: AccountQuota | null | undefined, nowMs = Date.now()): ResourceState {
  if (!quota) return { status: "ready" };
  const coolingUntil = quotaCoolingUntil(quota, nowMs);
  return coolingUntil === null
    ? { status: "ready" }
    : {
      status: "cooling",
      retryAtMs: coolingUntil,
      message: "OpenCode Go rate limit or subscription quota reached",
    };
}

const usageCache = new Map<
  string,
  { promise?: Promise<AccountQuota | null>; quota?: AccountQuota | null; expiresAtMs?: number }
>();
const usageCooldown = new Map<string, number>();

async function fetchUsageRaw(
  apiKey: string,
  context: ProviderContext,
): Promise<AccountQuota | null> {
  const cooldownUntil = usageCooldown.get(apiKey);
  if (cooldownUntil !== undefined && Date.now() < cooldownUntil) return null;
  const response = await context.network.fetch(USAGE_URL, {
    method: "GET",
    headers: authHeaders(apiKey),
  });
  if (response.status === 429) {
    usageCooldown.set(apiKey, Date.now() + USAGE_429_COOLDOWN_MS);
    return null;
  }
  if (response.status !== 200) return null;
  return parseOpenCodeUsage(JSON.parse(response.body));
}

export async function fetchUsage(
  apiKey: string,
  context: ProviderContext,
  force = false,
): Promise<AccountQuota | null> {
  const cached = usageCache.get(apiKey);
  if (!force) {
    if (cached?.promise) return cached.promise;
    if (cached?.expiresAtMs !== undefined && cached.expiresAtMs > Date.now()) {
      return cached.quota ?? null;
    }
  }
  const stale = cached?.quota ?? null;
  const promise = (async () => {
    const quota = await fetchUsageRaw(apiKey, context);
    if (quota) {
      usageCache.set(apiKey, { quota, expiresAtMs: Date.now() + USAGE_CACHE_TTL_MS });
      return quota;
    }
    if (stale) {
      usageCache.set(apiKey, { quota: stale, expiresAtMs: Date.now() + USAGE_CACHE_TTL_MS });
    }
    return stale;
  })();
  usageCache.set(apiKey, { promise });
  try {
    return await promise;
  } finally {
    const entry = usageCache.get(apiKey);
    if (entry?.promise === promise) {
      usageCache.set(apiKey, {
        quota: entry.quota ?? stale,
        expiresAtMs: entry.expiresAtMs,
      });
    }
  }
}

export function parseResetHintMs(message: string, nowMs = Date.now()): number | null {
  const resetsAt = /["']?resets?_?at["']?\s*[:=]\s*["']([^"']+)["']/i.exec(message);
  if (resetsAt) {
    const parsed = timestampMs(resetsAt[1]);
    if (parsed !== null) return parsed;
  }
  const retryAfter = /retry[-\s]?after["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)/i.exec(message);
  if (retryAfter) {
    const seconds = Number(retryAfter[1]);
    if (Number.isFinite(seconds)) return nowMs + Math.max(1, seconds) * 1000;
  }
  return null;
}

export function isOpenCodeQuotaError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("rate_limit") ||
    lower.includes("rate limit") ||
    lower.includes("quota") ||
    lower.includes("usage limit") ||
    lower.includes("too many requests") ||
    lower.includes("limitexceeded") ||
    lower.includes("limit_exceeded");
}

export async function quotaExhaustedPatch(
  data: AccountData,
  errorMessage: string,
  context?: ProviderContext,
  nowMs = Date.now(),
): Promise<ResourcePatch> {
  const usage = context ? await fetchUsage(data.apiKey, context, true) : null;
  const baseQuota = usage ?? data.quota ?? null;
  const windowResetMs = quotaCoolingUntil(baseQuota, nowMs);
  const hintResetMs = parseResetHintMs(errorMessage, nowMs);
  const coolingUntilMs = hintResetMs ?? windowResetMs ?? (nowMs + RATE_LIMIT_FALLBACK_MS);
  const quota: AccountQuota = {
    planLabel: baseQuota?.planLabel ?? data.planLabel ?? "OpenCode Go",
    rolling: baseQuota?.rolling ?? null,
    weekly: baseQuota?.weekly ?? null,
    monthly: baseQuota?.monthly ?? null,
    limitReached: true,
    coolingUntilMs,
    updatedAtMs: nowMs,
  };
  return {
    privateData: { ...data, quota } as unknown as JsonValue,
    state: quotaState(quota, nowMs),
  };
}

/**
 * Accepts a JSON or plaintext key:
 * - {"key"|"apiKey"|"api_key"|"token": "..."} flat objects or arrays
 * - opencode CLI account.json: {accounts:{<id>:{credential:{type:"api",key}}}},
 *   only opencode/zen/go related serviceIDs are kept
 * - .txt whose raw content is the key
 */
export function parseCredentials(
  fileName: string,
  content: string,
): string[] {
  const trimmed = content.trim();
  if (!trimmed) return [];
  if (fileName.toLowerCase().endsWith(".txt") || !trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    if (trimmed.length < 8 || /\s/.test(trimmed)) {
      throw new Error("The file does not look like an OpenCode API key");
    }
    return [trimmed];
  }
  const decoded = JSON.parse(trimmed);
  const keys: string[] = [];
  const pushKey = (value: unknown) => {
    const key = text(value);
    if (key) keys.push(key);
  };
  const visit = (value: unknown) => {
    const item = object(value);
    if (!item) return;
    pushKey(item.key ?? item.apiKey ?? item.api_key ?? item.access_token ?? item.token);
  };
  if (Array.isArray(decoded)) {
    for (const item of decoded) visit(item);
  } else if (object(decoded)?.accounts) {
    const accounts = object(object(decoded)?.accounts) ?? {};
    for (const account of Object.values(accounts)) {
      const entry = object(account);
      const serviceId = text(entry?.serviceID ?? entry?.service_id)?.toLowerCase() ?? "";
      const credential = object(entry?.credential);
      if (
        credential && text(credential.key) &&
        /opencode|zen|go/.test(serviceId)
      ) {
        pushKey(credential.key);
      }
    }
  } else {
    const root = object(decoded);
    // Both nested containers (opencode:{...}) and flat objects are supported.
    if (root && Object.values(root).every((value) => object(value) !== null)) {
      for (const value of Object.values(root)) visit(value);
    } else {
      visit(root);
    }
  }
  return [...new Set(keys)];
}

export const credentialImport: ResourceImportSupport = {
  displayName: {
    "en-US": "Import OpenCode Go API key",
    "zh-CN": "导入 OpenCode Go API 密钥",
  },
  description: {
    "en-US":
      "Paste your OpenCode Go API key (mint one at https://opencode.ai/auth) or import a JSON/TXT file - opencode CLI account.json also works.",
    "zh-CN": "粘贴 OpenCode Go API 密钥(在 https://opencode.ai/auth 生成)或导入 JSON/TXT 文件,支持 opencode CLI 的 account.json。",
  },
  accept: [".json", ".txt"],
  multiple: true,
  helpUrl: "https://opencode.ai/auth",
  async parse(files, context) {
    const resources: ResourceDraft[] = [];
    for (const file of files) {
      const keys = parseCredentials(file.name, file.content);
      if (keys.length === 0) {
        throw new Error(`No OpenCode API key found in ${file.name}`);
      }
      for (const key of keys) {
        resources.push(await buildAccountDraft(key, context));
      }
    }
    return { resources };
  },
};

export async function buildAccountDraft(
  apiKey: string,
  context: ProviderContext,
): Promise<ResourceDraft> {
  // Validates the key first: a 401 from the usage endpoint means invalid.
  const probe = await context.network.fetch(USAGE_URL, {
    method: "GET",
    headers: authHeaders(apiKey),
  });
  if (probe.status === 401 || probe.status === 403) {
    let detail = `HTTP ${probe.status}`;
    try {
      const error = object(object(JSON.parse(probe.body))?.error);
      if (text(error?.message)) detail = text(error?.message)!;
    } catch { /* keep status */ }
    throw new Error(
      probe.status === 403
        ? `OpenCode Go subscription required or key rejected: ${detail}`
        : `Invalid OpenCode API key: ${detail}`,
    );
  }
  const quota = probe.status === 200 ? parseOpenCodeUsage(JSON.parse(probe.body)) : null;
  const data: AccountData = {
    apiKey,
    displayName: `OpenCode Go (${keyTail(apiKey)})`,
    planLabel: "OpenCode Go",
    quota,
  };
  return {
    key: `opencode-go:${keyTail(apiKey)}`,
    privateData: data as unknown as JsonValue,
    state: quotaState(quota),
  };
}

export function presentAccount(resource: ResourceSnapshot): ResourceView {
  const data = accountData(resource);
  const metrics: ResourceMetric[] = [];
  const windows: [string, QuotaWindow | null, string, string][] = [
    ["rolling", data.quota?.rolling ?? null, "Rolling quota", "Rolling quota"],
    ["weekly", data.quota?.weekly ?? null, "Weekly quota", "Weekly quota"],
    ["monthly", data.quota?.monthly ?? null, "Monthly quota", "Monthly quota"],
  ];
  for (const [id, window, en, zh] of windows) {
    if (!window) continue;
    metrics.push({
      id,
      label: { "en-US": en, "zh-CN": zh },
      unit: "percent",
      value: window.remainingPercent,
      ...(window.resetAtMs !== null ? { resetAtMs: window.resetAtMs } : {}),
    });
  }
  return {
    displayName: data.displayName,
    description: data.planLabel ?? "OpenCode Go",
    ...(metrics.length > 0 ? { metrics } : {}),
  };
}

export async function refreshAccount(
  resource: ResourceSnapshot,
  context: ProviderContext,
): Promise<ResourcePatch> {
  const data = accountData(resource);
  const response = await context.network.fetch(USAGE_URL, {
    method: "GET",
    headers: authHeaders(data.apiKey),
  });
  if (response.status === 401 || response.status === 403) {
    return {
      state: {
        status: "invalid",
        message: "OpenCode API key rejected; import a fresh key",
      },
    };
  }
  const quota = response.status === 200
    ? parseOpenCodeUsage(JSON.parse(response.body))
    : null;
  if (!quota) return {};
  const nextData: AccountData = { ...data, quota };
  return {
    privateData: nextData as unknown as JsonValue,
    state: quotaState(quota),
  };
}

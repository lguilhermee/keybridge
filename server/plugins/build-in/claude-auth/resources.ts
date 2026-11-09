import type { JsonValue, PluginContext } from "cursor-byok:plugin";
import type {
  OAuth2AuthorizationCodeAddMethod,
  OAuth2AuthorizationCodeBegin,
  ResourceDraft,
  ResourceImportSupport,
  ResourceMetric,
  ResourcePatch,
  ResourceSnapshot,
  ResourceState,
  ResourceView,
} from "cursor-byok:resource";

export const RESOURCE_TYPE = "claude-account";

export const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
export const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
export const OAUTH_SCOPES = "org:create_api_key user:profile user:inference";
export const CLAUDE_CLI_VERSION = "2.1.280";
export const ANTHROPIC_VERSION = "2023-06-01";
export const OAUTH_BETA = "oauth-2025-04-20";

const AUTHORIZATION_LIFETIME_MS = 10 * 60 * 1000;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const RATE_LIMIT_FALLBACK_MS = 60 * 1000;
const TOKEN_REFRESH_LEAD_MS = 4 * 60 * 60 * 1000;
const TOKEN_EXPIRING_SOON_MS = 60 * 1000;
const USAGE_CACHE_TTL_MS = 5 * 60 * 1000;
const USAGE_429_COOLDOWN_MS = 3 * 60 * 1000;

export type QuotaWindow = {
  remainingPercent: number;
  resetAtMs: number | null;
};

/** Per-model weekly limit (e.g. seven_day_sonnet or limits[].weekly_scoped). */
export type ScopedWindow = QuotaWindow & { label: string };

export type AccountQuota = {
  planLabel: string | null;
  fiveHour: QuotaWindow | null;
  weekly: QuotaWindow | null;
  scoped: ScopedWindow[];
  resetGrantsAvailable: number | null;
  limitReached: boolean;
  coolingUntilMs: number | null;
  updatedAtMs: number;
};

export type AccountData = {
  accessToken: string;
  refreshToken: string | null;
  expiresAtMs: number | null;
  scope: string | null;
  displayName: string;
  planLabel?: string | null;
  email?: string | null;
  accountUuid?: string | null;
  orgUuid?: string | null;
  orgName?: string | null;
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

async function sha256Hex(input: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function accountData(resource: ResourceSnapshot): AccountData {
  const data = object(resource.privateData) as unknown as AccountData | null;
  if (!data || typeof data.accessToken !== "string" || !data.accessToken) {
    throw new Error("Add a Claude account before calling this model");
  }
  return data;
}

export function isOAuthToken(token: string): boolean {
  return token.includes("sk-ant-oat");
}

/** Common request headers for OAuth API calls; the usage endpoint mimics Claude Code's cli UA. */
export function oauthHeaders(token: string, cli = false): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "anthropic-beta": OAUTH_BETA,
    "anthropic-version": ANTHROPIC_VERSION,
    "user-agent": `claude-cli/${CLAUDE_CLI_VERSION} (external, ${cli ? "cli" : "sdk-cli"})`,
  };
}

/** Anthropic's OAuth client allows loopback redirects per RFC 8252; uses the localhost hostname, same as 9router. */
export function externalRedirectUri(redirectUri: string): string {
  return redirectUri.replace(/^http:\/\/127\.0\.0\.1:/, "http://localhost:");
}

/** The authorization code may be copied back manually as `code#state`; when split, the embedded state wins. */
export function splitAuthorizationCode(
  code: string,
): { code: string; state: string | null } {
  const index = code.indexOf("#");
  if (index < 0) return { code: code.trim(), state: null };
  return {
    code: code.slice(0, index).trim(),
    state: text(code.slice(index + 1)),
  };
}

export async function exchangeAuthorizationCode(
  code: string,
  state: string,
  redirectUri: string,
  codeVerifier: string,
  context: PluginContext,
): Promise<AccountData> {
  const parsed = splitAuthorizationCode(code);
  const response = await context.network.fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      code: parsed.code,
      state: parsed.state ?? state,
      grant_type: "authorization_code",
      client_id: CLAUDE_CLIENT_ID,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });
  const body = object(JSON.parse(response.body));
  const accessToken = text(body?.access_token);
  if (!accessToken) {
    const detail = text(body?.error_description ?? body?.error ?? body?.message);
    throw new Error(
      detail
        ? `Claude token exchange failed: ${detail}`
        : `Claude token exchange failed (HTTP ${response.status})`,
    );
  }
  const expiresIn = number(body?.expires_in);
  return {
    accessToken,
    refreshToken: text(body?.refresh_token),
    expiresAtMs: expiresIn === null ? null : Date.now() + expiresIn * 1000,
    scope: text(body?.scope),
    displayName: "Claude account",
  };
}

export async function refreshAccessToken(
  refreshToken: string,
  context: PluginContext,
): Promise<{ accessToken: string; refreshToken: string; expiresAtMs: number | null }> {
  const response = await context.network.fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLAUDE_CLIENT_ID,
    }),
  });
  const body = object(JSON.parse(response.body));
  const accessToken = text(body?.access_token);
  if (!accessToken) {
    const detail = text(body?.error_description ?? body?.error ?? body?.message);
    throw new Error(
      detail
        ? `Claude token refresh failed: ${detail}`
        : `Claude token refresh failed (HTTP ${response.status})`,
    );
  }
  const expiresIn = number(body?.expires_in);
  return {
    accessToken,
    refreshToken: text(body?.refresh_token) ?? refreshToken,
    expiresAtMs: expiresIn === null ? null : Date.now() + expiresIn * 1000,
  };
}

export function tokenNeedsRefresh(data: AccountData, leadMs: number, nowMs = Date.now()): boolean {
  return data.refreshToken !== null && data.refreshToken !== undefined &&
    data.expiresAtMs !== null && data.expiresAtMs !== undefined &&
    data.expiresAtMs - nowMs <= leadMs;
}

export async function fetchProfile(
  token: string,
  context: PluginContext,
): Promise<{
  email: string | null;
  accountUuid: string | null;
  orgUuid: string | null;
  orgName: string | null;
  planLabel: string | null;
} | null> {
  try {
    const response = await context.network.fetch(PROFILE_URL, {
      method: "GET",
      headers: oauthHeaders(token, true),
    });
    if (response.status !== 200) return null;
    const root = object(JSON.parse(response.body));
    const account = object(root?.account);
    const organization = object(root?.organization);
    const subscription = text(
      organization?.rate_limit_tier ?? organization?.rateLimitTier ??
        organization?.subscription_type ?? organization?.subscriptionType ??
        account?.rate_limit_tier ?? account?.subscription_type,
    );
    return {
      email: text(account?.email ?? root?.email),
      accountUuid: text(account?.uuid ?? root?.account_uuid),
      orgUuid: text(organization?.uuid ?? root?.organization_uuid),
      orgName: text(organization?.name),
      planLabel: planLabel(subscription),
    };
  } catch {
    return null;
  }
}

function planLabel(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.toLowerCase();
  const labels: Record<string, string> = {
    default_claude_max_20x: "Claude Max 20x",
    default_claude_max_5x: "Claude Max 5x",
    default_claude_pro: "Claude Pro",
    max: "Claude Max",
    pro: "Claude Pro",
    team: "Claude Team",
    enterprise: "Claude Enterprise",
    free: "Claude Free",
  };
  if (labels[normalized]) return labels[normalized];
  if (normalized.includes("max")) return "Claude Max";
  if (normalized.includes("pro")) return "Claude Pro";
  return value;
}

function quotaWindow(value: unknown): QuotaWindow | null {
  const window = object(value);
  if (!window) return null;
  const utilization = number(window.utilization);
  if (utilization === null) return null;
  return {
    remainingPercent: clampPercent(100 - utilization),
    resetAtMs: timestampMs(window.resets_at ?? window.resetsAt),
  };
}

/** cedar_ember free-quota reset grant; read-only display, no consume entry (irreversible). */
function resetGrantsAvailable(block: unknown): number | null {
  const grants = object(block);
  if (!grants || grants.eligible !== true || !Array.isArray(grants.grants)) return null;
  const total = grants.grants.reduce((sum: number, grant) => {
    const entry = object(grant);
    if (!entry || entry.paused === true) return sum;
    const left = number(entry.resets_left);
    return sum + (left !== null && left > 0 ? Math.floor(left) : 0);
  }, 0);
  return total;
}

export function parseClaudeUsage(body: unknown, nowMs = Date.now()): AccountQuota {
  const root = object(body) ?? {};
  const fiveHour = quotaWindow(root.five_hour);
  const weekly = quotaWindow(root.seven_day);
  const scoped: ScopedWindow[] = [];
  const scopedKeys = new Set<string>();

  for (const [key, value] of Object.entries(root)) {
    if (!key.startsWith("seven_day_") || key === "seven_day") continue;
    const window = quotaWindow(value);
    if (!window) continue;
    const model = key.slice("seven_day_".length);
    scopedKeys.add(model);
    scoped.push({ ...window, label: `weekly ${model} (7d)` });
  }
  // Newer accounts get per-model weekly limits via limits[]:{kind:"weekly_scoped", percent, resets_at, scope.model.display_name}
  if (Array.isArray(root.limits)) {
    for (const item of root.limits) {
      const limit = object(item);
      if (limit?.kind !== "weekly_scoped") continue;
      const percent = number(limit.percent);
      const model = text(object(limit.scope)?.model &&
        object(object(limit.scope)?.model)?.display_name)
        ?.toLowerCase();
      if (percent === null || !model || scopedKeys.has(model)) continue;
      scopedKeys.add(model);
      scoped.push({
        remainingPercent: clampPercent(100 - percent),
        resetAtMs: timestampMs(limit.resets_at),
        label: `weekly ${model} (7d)`,
      });
    }
  }

  const exhausted = [fiveHour, weekly].some(
    (window) => window !== null && window.remainingPercent <= 0 &&
      (window.resetAtMs === null || window.resetAtMs > nowMs),
  );
  const quota: AccountQuota = {
    planLabel: null,
    fiveHour,
    weekly,
    scoped,
    resetGrantsAvailable: resetGrantsAvailable(root.cedar_ember),
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
  return window.resetAtMs ?? nowMs + FIVE_HOURS_MS;
}

export function quotaCoolingUntil(quota: AccountQuota | null, nowMs = Date.now()): number | null {
  if (!quota) return null;
  const resets = [
    windowCoolingUntil(quota.fiveHour, nowMs),
    windowCoolingUntil(quota.weekly, nowMs),
    quota.coolingUntilMs !== null && quota.coolingUntilMs > nowMs
      ? quota.coolingUntilMs
      : null,
  ].filter((value): value is number => value !== null);
  if (resets.length > 0) return Math.max(...resets);
  return quota.limitReached ? nowMs + FIVE_HOURS_MS : null;
}

export function quotaState(quota: AccountQuota | null | undefined, nowMs = Date.now()): ResourceState {
  if (!quota) return { status: "ready" };
  const coolingUntil = quotaCoolingUntil(quota, nowMs);
  return coolingUntil === null
    ? { status: "ready" }
    : {
      status: "cooling",
      retryAtMs: coolingUntil,
      message: "Claude rate limit or subscription quota reached",
    };
}

// The usage endpoint has its own rate limit (429); after a hit it is not called for a while and the last good data is reused.
const usageCache = new Map<string, { promise?: Promise<AccountQuota | null>; quota?: AccountQuota | null; expiresAtMs?: number }>();
const usageCooldown = new Map<string, number>();

async function fetchUsageRaw(
  token: string,
  context: PluginContext,
): Promise<AccountQuota | null> {
  const cooldownUntil = usageCooldown.get(token);
  if (cooldownUntil !== undefined && Date.now() < cooldownUntil) return null;
  const response = await context.network.fetch(`${USAGE_URL}?cedar_ember=1`, {
    method: "GET",
    headers: oauthHeaders(token, true),
  });
  if (response.status === 429) {
    usageCooldown.set(token, Date.now() + USAGE_429_COOLDOWN_MS);
    return null;
  }
  if (response.status !== 200) return null;
  return parseClaudeUsage(JSON.parse(response.body));
}

/** Five-minute dedupe cache; on 429/transient failure returns the last good data instead of killing the resource. */
export async function fetchUsage(
  token: string,
  context: PluginContext,
  force = false,
): Promise<AccountQuota | null> {
  const cached = usageCache.get(token);
  if (!force) {
    if (cached?.promise) return cached.promise;
    if (cached?.expiresAtMs !== undefined && cached.expiresAtMs > Date.now()) {
      return cached.quota ?? null;
    }
  }
  const stale = cached?.quota ?? null;
  const promise = (async () => {
    const quota = await fetchUsageRaw(token, context);
    if (quota) {
      usageCache.set(token, { quota, expiresAtMs: Date.now() + USAGE_CACHE_TTL_MS });
      return quota;
    }
    if (stale) usageCache.set(token, { quota: stale, expiresAtMs: Date.now() + USAGE_CACHE_TTL_MS });
    return stale;
  })();
  usageCache.set(token, { promise });
  try {
    return await promise;
  } finally {
    const entry = usageCache.get(token);
    if (entry?.promise === promise) {
      usageCache.set(token, {
        quota: entry.quota ?? stale,
        expiresAtMs: entry.expiresAtMs,
      });
    }
  }
}

/** Resource patch on 429/quota errors: prefers the reset time from latest usage, then the error text, then a short cooldown. */
export async function quotaExhaustedPatch(
  data: AccountData,
  errorMessage: string,
  context?: PluginContext,
  nowMs = Date.now(),
): Promise<ResourcePatch> {
  const usage = context ? await fetchUsage(data.accessToken, context, true) : null;
  const baseQuota = usage ?? data.quota ?? null;
  const windowResetMs = quotaCoolingUntil(baseQuota, nowMs);
  const hintResetMs = parseResetHintMs(errorMessage, nowMs);
  const coolingUntilMs = hintResetMs ?? windowResetMs ?? (nowMs + RATE_LIMIT_FALLBACK_MS);
  const quota: AccountQuota = {
    planLabel: baseQuota?.planLabel ?? data.planLabel ?? null,
    fiveHour: baseQuota?.fiveHour ?? null,
    weekly: baseQuota?.weekly ?? null,
    scoped: baseQuota?.scoped ?? [],
    resetGrantsAvailable: baseQuota?.resetGrantsAvailable ?? null,
    limitReached: true,
    coolingUntilMs,
    updatedAtMs: nowMs,
  };
  return {
    privateData: { ...data, quota } as unknown as JsonValue,
    state: quotaState(quota, nowMs),
  };
}

/** Extracts the recovery time from an Anthropic error body / retry-after. */
export function parseResetHintMs(message: string, nowMs = Date.now()): number | null {
  const resetsAt = /["']?resets?_at["']?\s*[:=]\s*["']([^"']+)["']/i.exec(message);
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

export function isClaudeQuotaError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("rate_limit") ||
    lower.includes("rate limit") ||
    lower.includes("usage limit") ||
    lower.includes("quota") ||
    lower.includes("overloaded");
}

export const claudeBrowserOAuth: OAuth2AuthorizationCodeAddMethod = {
  type: "oauth2.authorization-code",
  id: "claude-browser",
  displayName: {
    "en-US": "Sign in with Claude",
    "zh-CN": "使用 Claude 登录",
  },
  description: {
    "en-US":
      "Authorize in your browser to add a Claude subscription account. Repeat to add multiple accounts.",
    "zh-CN": "在浏览器中完成授权以添加 Claude 订阅账号,可重复登录添加多个账号。",
  },
  callback: { path: "/callback" },
  async begin(
    input: { redirectUri: string; state: string; codeChallenge: string },
    _context: PluginContext,
  ): Promise<OAuth2AuthorizationCodeBegin> {
    const redirectUri = externalRedirectUri(input.redirectUri);
    const params = new URLSearchParams({
      code: "true",
      client_id: CLAUDE_CLIENT_ID,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: OAUTH_SCOPES,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
      state: input.state,
    });
    return {
      session: {
        createdAtMs: Date.now(),
        state: input.state,
        redirectUri,
      },
      authorizationUrl: `${AUTHORIZE_URL}?${params.toString()}`,
      expiresAtMs: Date.now() + AUTHORIZATION_LIFETIME_MS,
    };
  },
  async complete(
    sessionValue: JsonValue,
    input: { code: string; redirectUri: string; codeVerifier: string },
    context: PluginContext,
  ): Promise<ResourceDraft[]> {
    const session = object(sessionValue);
    if (
      typeof session?.createdAtMs === "number" &&
      Date.now() - session.createdAtMs > AUTHORIZATION_LIFETIME_MS
    ) {
      throw new Error("Claude authorization expired. Please try again.");
    }
    const state = text(session?.state) ?? "";
    const redirectUri = text(session?.redirectUri) ?? externalRedirectUri(input.redirectUri);
    const account = await exchangeAuthorizationCode(
      input.code,
      state,
      redirectUri,
      input.codeVerifier,
      context,
    );
    return [await buildAccountDraft(account, context)];
  },
};

/**
 * Accepts Claude Code .credentials.json, {"claudeAiOauth":{...}}, flat token JSON,
 * or a pasted setup-token (sk-ant-oat..., generated by `claude setup-token`).
 */
export function parseCredentials(content: string): AccountData[] {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    if (!/^sk-ant-\S+$/.test(trimmed)) {
      throw new Error("Paste a Claude setup-token (sk-ant-oat...) or a credentials JSON");
    }
    return [{
      accessToken: trimmed,
      refreshToken: null,
      expiresAtMs: null,
      scope: null,
      displayName: "Claude account",
      email: null,
      planLabel: null,
      quota: null,
    }];
  }

  const decoded = JSON.parse(trimmed);
  const records = Array.isArray(decoded)
    ? decoded
    : object(decoded?.claudeAiOauth)
    ? [object(decoded.claudeAiOauth)]
    : decoded.accounts ?? [decoded];
  return records.map((value: Record<string, unknown>) => {
    const item = object(value) ?? {};
    const accessToken = text(item.accessToken ?? item.access_token) ?? "";
    const refreshToken = text(item.refreshToken ?? item.refresh_token);
    if (!accessToken) throw new Error("Each Claude account needs an access token");
    const expiresAt = timestampMs(item.expiresAt ?? item.expires_at);
    const expiresIn = number(item.expires_in);
    return {
      accessToken,
      refreshToken,
      expiresAtMs: expiresAt ?? (expiresIn === null ? null : Date.now() + expiresIn * 1000),
      scope: text(item.scope) ?? (Array.isArray(item.scopes) ? item.scopes.join(" ") : null),
      displayName: text(item.displayName ?? item.display_name ?? item.email) ?? "Claude account",
      email: text(item.email),
      planLabel: planLabel(text(item.subscriptionType ?? item.subscription_type)),
      quota: null,
    };
  });
}

export const credentialImport: ResourceImportSupport = {
  displayName: {
    "en-US": "Import Claude credentials",
    "zh-CN": "导入 Claude 凭证",
  },
  description: {
    "en-US":
      "Paste a Claude setup-token (run `claude setup-token` and copy the sk-ant-oat... value) or a credentials JSON (access_token + refresh_token).",
    "zh-CN": "粘贴 Claude setup-token(终端运行 `claude setup-token` 复制 sk-ant-oat... value)或包含 token 的凭证 JSON。",
  },
  accept: [".json", ".txt"],
  multiple: true,
  helpUrl: "https://code.claude.com/docs/en/setup",
  async parse(files, context) {
    const resources: ResourceDraft[] = [];
    for (const file of files) {
      for (const account of parseCredentials(file.content)) {
        resources.push(await buildAccountDraft(account, context));
      }
    }
    return { resources };
  },
};

export async function buildAccountDraft(
  account: AccountData,
  context: PluginContext,
): Promise<ResourceDraft> {
  const data: AccountData = { ...account };
  if (tokenNeedsRefresh(data, TOKEN_EXPIRING_SOON_MS)) {
    try {
      const tokens = await refreshAccessToken(data.refreshToken!, context);
      data.accessToken = tokens.accessToken;
      data.refreshToken = tokens.refreshToken;
      data.expiresAtMs = tokens.expiresAtMs;
    } catch {
      // Even if the refresh fails the resource keeps the original token; the call path retries once more.
    }
  }
  const profile = await fetchProfile(data.accessToken, context);
  if (profile) {
    data.email = profile.email ?? data.email ?? null;
    data.accountUuid = profile.accountUuid ?? null;
    data.orgUuid = profile.orgUuid ?? null;
    data.orgName = profile.orgName ?? null;
  }
  const plan = profile?.planLabel ?? data.planLabel ?? null;
  data.planLabel = plan;
  data.quota = await fetchUsage(data.accessToken, context);
  if (data.quota && plan) data.quota.planLabel = plan;
  const isGenericName = !data.displayName || data.displayName === "Claude account";
  if (isGenericName) {
    data.displayName = data.email
      ? `${data.email}${data.orgName ? ` (${data.orgName})` : ""}`
      : (data.orgName ?? data.displayName);
  }
  const identity = data.email?.toLowerCase() ?? data.accountUuid ?? data.orgUuid ??
    `token:${(await sha256Hex(data.accessToken)).slice(0, 16)}`;
  return {
    key: `claude:${identity}`,
    privateData: data as unknown as JsonValue,
    state: quotaState(data.quota),
  };
}

export function presentAccount(resource: ResourceSnapshot): ResourceView {
  const data = accountData(resource);
  const metrics: ResourceMetric[] = [];
  const fiveHour = data.quota?.fiveHour;
  if (fiveHour) {
    metrics.push({
      id: "five-hour",
      label: { "en-US": "5-hour window", "zh-CN": "5 小时窗口" },
      unit: "percent",
      value: fiveHour.remainingPercent,
      ...(fiveHour.resetAtMs !== null ? { resetAtMs: fiveHour.resetAtMs } : {}),
    });
  }
  const weekly = data.quota?.weekly;
  if (weekly) {
    metrics.push({
      id: "weekly",
      label: { "en-US": "Weekly quota", "zh-CN": "周额度" },
      unit: "percent",
      value: weekly.remainingPercent,
      ...(weekly.resetAtMs !== null ? { resetAtMs: weekly.resetAtMs } : {}),
    });
  }
  for (const [index, window] of (data.quota?.scoped ?? []).entries()) {
    metrics.push({
      id: `scoped-${index}`,
      label: {
        "en-US": `${window.label} remaining`,
        "zh-CN": `${window.label} 剩余`,
      },
      unit: "percent",
      value: window.remainingPercent,
      ...(window.resetAtMs !== null ? { resetAtMs: window.resetAtMs } : {}),
    });
  }
  const grants = data.quota?.resetGrantsAvailable;
  if (grants !== null && grants !== undefined) {
    metrics.push({
      id: "reset-grants",
      label: { "en-US": "Reset grants", "zh-CN": "重置授权" },
      unit: "count",
      value: grants,
    });
  }
  const plan = data.quota?.planLabel ?? data.planLabel ?? null;
  return {
    displayName: data.displayName,
    ...(plan ? { description: plan } : {}),
    ...(metrics.length > 0 ? { metrics } : {}),
  };
}

export async function refreshAccount(
  resource: ResourceSnapshot,
  context: PluginContext,
): Promise<ResourcePatch> {
  const data = accountData(resource);
  if (tokenNeedsRefresh(data, TOKEN_REFRESH_LEAD_MS)) {
    try {
      const tokens = await refreshAccessToken(data.refreshToken!, context);
      data.accessToken = tokens.accessToken;
      data.refreshToken = tokens.refreshToken;
      data.expiresAtMs = tokens.expiresAtMs;
    } catch {
      return {
        state: {
          status: "invalid",
          message: "Claude authorization expired; sign in again",
        },
      };
    }
  }
  const profile = await fetchProfile(data.accessToken, context);
  const quota = await fetchUsage(data.accessToken, context, true);
  const nextData: AccountData = {
    ...data,
    ...(profile?.planLabel ? { planLabel: profile.planLabel } : {}),
    ...(profile?.email ? { email: profile.email } : {}),
    ...(profile?.accountUuid ? { accountUuid: profile.accountUuid } : {}),
    ...(profile?.orgUuid ? { orgUuid: profile.orgUuid } : {}),
    ...(profile?.orgName ? { orgName: profile.orgName } : {}),
  };
  if (quota) {
    nextData.quota = quota;
    const plan = profile?.planLabel ?? data.quota?.planLabel ?? null;
    if (plan) nextData.quota.planLabel = plan;
  }
  if (!profile && !quota) {
    // Both endpoints failed: credential status cannot be confirmed, so it stays as-is rather than being marked dead.
    return { privateData: nextData as unknown as JsonValue };
  }
  return {
    privateData: nextData as unknown as JsonValue,
    state: quotaState(nextData.quota),
  };
}

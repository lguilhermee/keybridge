import type { JsonValue, ProviderContext } from "cursor-byok:provider";
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
import { ConnectError, connectError, metadata, SERVER, unary } from "./connect.ts";

export const RESOURCE_TYPE = "devin-account";

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const MAX_RESET_WAIT_MS = 6 * 60 * 60 * 1000;
const AUTHORIZATION_LIFETIME_MS = 5 * 60 * 1000;
const DEVIN_AUTH_CONTINUE_URL = "https://app.devin.ai/auth/cli/continue";

export type QuotaWindow = {
  remainingPercent: number;
  resetAtMs: number | null;
};

export type AccountQuota = {
  planLabel: string | null;
  daily: QuotaWindow | null;
  weekly: QuotaWindow | null;
  acuConsumed: number | null;
  acuLimit: number | null;
  limitReached: boolean;
  coolingUntilMs: number | null;
  updatedAtMs: number;
};

export type AccountData = {
  token: string;
  apiKey: string | null;
  displayName: string;
  email?: string | null;
  userId?: string | null;
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

function unixTimestampMs(value: unknown): number | null {
  const numeric = number(value);
  if (numeric === null || numeric <= 0) return null;
  return numeric > 10_000_000_000 ? Math.round(numeric) : Math.round(numeric * 1000);
}

export function accountData(resource: ResourceSnapshot): AccountData {
  const data = resource.privateData as unknown as AccountData;
  if (!data || typeof data.token !== "string" || !data.token) {
    throw new Error("Import Devin credentials before syncing models");
  }
  return data;
}

export async function mintSession(
  apiKey: string,
  context: ProviderContext,
): Promise<string> {
  const response = await context.network.fetch(
    `${SERVER}/exa.seat_management_pb.SeatManagementService/GetSelfDevinSessionToken`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "connect-protocol-version": "1",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        metadata: {
          ...metadata(apiKey),
          extensionName: "windsurf",
          ideName: "windsurf",
          extensionVersion: "1.48.2",
          ideVersion: "1.48.2",
          os: "windows",
        },
      }),
    },
  );
  if (response.status !== 200) {
    throw connectError(response.body, response.status, [apiKey]);
  }
  const value = JSON.parse(response.body);
  if (typeof value.sessionToken !== "string" || !value.sessionToken.trim()) {
    throw new Error("Devin did not issue a session token");
  }
  return value.sessionToken.trim();
}

export async function exchangePkceCode(
  code: string,
  codeVerifier: string,
  context: ProviderContext,
): Promise<string> {
  const response = await context.network.fetch(
    `${SERVER}/exa.seat_management_pb.SeatManagementService/ExchangeDevinCLIPKCECode`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "connect-protocol-version": "1",
      },
      body: JSON.stringify({
        code,
        codeVerifier,
      }),
    },
  );
  if (response.status !== 200) {
    throw connectError(response.body, response.status, [code, codeVerifier]);
  }
  const value = JSON.parse(response.body);
  const token = String(
    value.sessionToken ?? value.session_token ?? value.token ?? "",
  ).trim();
  if (!token.startsWith("devin-session-token$")) {
    throw new Error("Devin did not issue a session token");
  }
  return token;
}

function formatPlanLabel(
  planName: string | null,
  teamsTier: string | null,
): string | null {
  if (planName) {
    return planName.toLowerCase().startsWith("devin")
      ? planName
      : `Devin ${planName}`;
  }
  if (!teamsTier) return null;
  const tier = teamsTier.replace(/^TEAMS_TIER_/, "").toLowerCase();
  const labels: Record<string, string> = {
    devin_max: "Devin Max",
    devin_pro: "Devin Pro",
    devin_teams: "Devin Teams",
    devin_teams_v2: "Devin Teams",
    devin_enterprise: "Devin Enterprise",
    devin_free: "Devin Free",
    devin_trial: "Devin Trial",
    pro: "Devin Pro",
    teams: "Devin Teams",
  };
  return labels[tier] ?? null;
}

export function parseDevinUserStatus(
  body: unknown,
  nowMs = Date.now(),
): {
  name: string | null;
  email: string | null;
  userId: string | null;
  quota: AccountQuota | null;
} {
  const root = object(body);
  const userStatus = object(root?.userStatus ?? root?.user_status);
  if (!userStatus) {
    return { name: null, email: null, userId: null, quota: null };
  }
  const name = text(userStatus.name);
  const email = text(userStatus.email);
  const userId = text(userStatus.userId ?? userStatus.user_id);
  const teamsTier = text(userStatus.teamsTier ?? userStatus.teams_tier);
  const planStatus = object(userStatus.planStatus ?? userStatus.plan_status);
  const planInfo = object(
    planStatus?.planInfo ?? planStatus?.plan_info ?? root?.planInfo ?? root?.plan_info,
  );
  const planLabel = formatPlanLabel(
    text(planInfo?.planName ?? planInfo?.plan_name),
    teamsTier ?? text(planInfo?.teamsTier ?? planInfo?.teams_tier),
  );
  if (!planStatus) {
    return {
      name,
      email,
      userId,
      quota: planLabel
        ? {
          planLabel,
          daily: null,
          weekly: null,
          acuConsumed: null,
          acuLimit: null,
          limitReached: false,
          coolingUntilMs: null,
          updatedAtMs: nowMs,
        }
        : null,
    };
  }

  const dailyRemaining = number(
    planStatus.dailyQuotaRemainingPercent ??
      planStatus.daily_quota_remaining_percent ??
      planStatus.daily_quota_remaining,
  );
  const weeklyRemaining = number(
    planStatus.weeklyQuotaRemainingPercent ??
      planStatus.weekly_quota_remaining_percent ??
      planStatus.weekly_quota_remaining,
  );
  const dailyResetAtMs = unixTimestampMs(
    planStatus.dailyQuotaResetAtUnix ??
      planStatus.daily_quota_reset_at_unix ??
      planStatus.daily_quota_reset,
  );
  const weeklyResetAtMs = unixTimestampMs(
    planStatus.weeklyQuotaResetAtUnix ??
      planStatus.weekly_quota_reset_at_unix ??
      planStatus.weekly_quota_reset,
  );
  const acuConsumed = number(planStatus.acuConsumed ?? planStatus.acu_consumed);
  const acuLimit = number(planStatus.acuLimit ?? planStatus.acu_limit);

  const daily: QuotaWindow | null = dailyRemaining === null
    ? null
    : { remainingPercent: clampPercent(dailyRemaining), resetAtMs: dailyResetAtMs };
  const weekly: QuotaWindow | null = weeklyRemaining === null
    ? null
    : { remainingPercent: clampPercent(weeklyRemaining), resetAtMs: weeklyResetAtMs };

  const acuExhausted = acuLimit !== null && acuLimit > 0 &&
    acuConsumed !== null && acuConsumed >= acuLimit;
  const limitReached = (weekly !== null && weekly.remainingPercent <= 0) ||
    (daily !== null && daily.remainingPercent <= 0) ||
    acuExhausted;

  const quota: AccountQuota = {
    planLabel,
    daily,
    weekly,
    acuConsumed,
    acuLimit,
    limitReached,
    coolingUntilMs: null,
    updatedAtMs: nowMs,
  };
  quota.coolingUntilMs = quotaCoolingUntil(quota, nowMs);
  return { name, email, userId, quota };
}

function windowCoolingUntil(
  window: QuotaWindow | null,
  nowMs: number,
): number | null {
  if (!window || window.remainingPercent > 0) return null;
  if (window.resetAtMs !== null && window.resetAtMs <= nowMs) return null;
  return window.resetAtMs ?? nowMs + FIVE_HOURS_MS;
}

export function quotaCoolingUntil(
  quota: AccountQuota | null,
  nowMs = Date.now(),
): number | null {
  if (!quota) return null;
  const resets = [
    windowCoolingUntil(quota.weekly, nowMs),
    windowCoolingUntil(quota.daily, nowMs),
    quota.coolingUntilMs !== null && quota.coolingUntilMs > nowMs
      ? quota.coolingUntilMs
      : null,
  ].filter((value): value is number => value !== null);
  if (resets.length > 0) return Math.max(...resets);
  return quota.limitReached ? nowMs + FIVE_HOURS_MS : null;
}

export function quotaState(
  quota: AccountQuota | null | undefined,
  nowMs = Date.now(),
): ResourceState {
  if (!quota) return { status: "ready" };
  const coolingUntil = quotaCoolingUntil(quota, nowMs);
  return coolingUntil === null
    ? { status: "ready" }
    : {
      status: "cooling",
      retryAtMs: coolingUntil,
      message: "Devin rate limit or account quota reached",
    };
}

/**
 * Parses Devin's rate-limit reset hint from error messages, matching devin2api's
 * RateLimitReset ("reset in N seconds/minutes" and "Resets in: 3h0m0s").
 */
export function parseRateLimitResetMs(
  message: string,
  nowMs = Date.now(),
): number | null {
  const wordMatch = /\breset in:?\s*(\d+)\s*(seconds?|minutes?)/i.exec(message);
  if (wordMatch) {
    const amount = Number(wordMatch[1]);
    if (Number.isFinite(amount) && amount >= 0) {
      const isMinute = wordMatch[2].toLowerCase().startsWith("minute");
      const rawSeconds = Math.min(
        MAX_RESET_WAIT_MS / 1000,
        isMinute ? amount * 60 : amount,
      );
      if (isMinute) {
        const targetMs = nowMs + rawSeconds * 1000;
        const minuteFloorMs = Math.floor(targetMs / 60_000) * 60_000;
        let resetMs = minuteFloorMs + 59_000;
        if (resetMs <= targetMs) resetMs += 60_000;
        return Math.min(nowMs + MAX_RESET_WAIT_MS, resetMs);
      }
      return nowMs + Math.max(1_000, rawSeconds * 1000);
    }
  }
  const durationMatch = /\bresets?\s+in\s*:?\s*((?:\d+(?:\.\d+)?(?:ms|s|m|h))+)/i
    .exec(message);
  if (durationMatch) {
    let totalMs = 0;
    const partPattern = /(\d+(?:\.\d+)?)(ms|s|m|h)/gi;
    let part: RegExpExecArray | null;
    while ((part = partPattern.exec(durationMatch[1])) !== null) {
      const val = Number(part[1]);
      const unit = part[2].toLowerCase();
      if (unit === "h") totalMs += val * 3_600_000;
      else if (unit === "m") totalMs += val * 60_000;
      else if (unit === "s") totalMs += val * 1_000;
      else if (unit === "ms") totalMs += val;
    }
    if (totalMs > 0) {
      return nowMs + Math.min(MAX_RESET_WAIT_MS, Math.round(totalMs));
    }
  }
  return null;
}

export function isDevinQuotaError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error))
    .toLowerCase();
  if (
    message.includes("stream error: stream id ") ||
    message.includes("http2: server sent goaway")
  ) {
    return false;
  }
  if (error instanceof ConnectError && error.code === "resource_exhausted") {
    return true;
  }
  return message.includes("usage quota has been exhausted") ||
    message.includes("monthly acu limit reached") ||
    message.includes("organization usage limit reached") ||
    message.includes("reached your monthly usage limit") ||
    message.includes("reached its monthly usage limit") ||
    message.includes("usage frozen by an administrator") ||
    message.includes("admin paused usage") ||
    message.includes("reached overall message rate limit");
}

export async function fetchUserStatus(
  token: string,
  context: ProviderContext,
): Promise<{
  name: string | null;
  email: string | null;
  userId: string | null;
  quota: AccountQuota | null;
} | null> {
  try {
    const response = await context.network.fetch(
      `${SERVER}/exa.seat_management_pb.SeatManagementService/GetUserStatus`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "connect-protocol-version": "1",
        },
        body: JSON.stringify({
          metadata: {
            ...metadata(token),
            extensionName: "windsurf",
            ideName: "windsurf",
            extensionVersion: "1.48.2",
            ideVersion: "1.48.2",
            os: "windows",
          },
        }),
      },
    );
    if (response.status !== 200) return null;
    return parseDevinUserStatus(JSON.parse(response.body));
  } catch {
    return null;
  }
}

export async function quotaExhaustedPatch(
  data: AccountData,
  errorMessage: string,
  context?: ProviderContext,
  nowMs = Date.now(),
): Promise<ResourcePatch> {
  const status = context ? await fetchUserStatus(data.token, context) : null;
  const baseQuota = status?.quota ?? data.quota ?? null;
  const hintResetMs = parseRateLimitResetMs(errorMessage, nowMs);
  const windowResetMs = quotaCoolingUntil(baseQuota, nowMs);
  const lower = errorMessage.toLowerCase();
  const isHardQuotaExhaustion = lower.includes("usage quota has been exhausted") ||
    lower.includes("acu limit reached") ||
    lower.includes("monthly usage limit") ||
    lower.includes("usage frozen") ||
    lower.includes("admin paused usage");
  const fallbackCooldownMs = isHardQuotaExhaustion ? FIVE_HOURS_MS : 60_000;
  const coolingUntilMs = hintResetMs ?? windowResetMs ?? (nowMs + fallbackCooldownMs);
  const quota: AccountQuota = {
    planLabel: baseQuota?.planLabel ?? null,
    daily: baseQuota?.daily ?? null,
    weekly: baseQuota?.weekly ?? null,
    acuConsumed: baseQuota?.acuConsumed ?? null,
    acuLimit: baseQuota?.acuLimit ?? null,
    limitReached: true,
    coolingUntilMs,
    updatedAtMs: nowMs,
  };
  const updated: AccountData = {
    ...data,
    ...(status?.email ? { email: status.email } : {}),
    ...(status?.userId ? { userId: status.userId } : {}),
    quota,
  };
  return {
    privateData: updated as unknown as JsonValue,
    state: quotaState(quota, nowMs),
  };
}

/**
 * Accept the existing CLI TOML file, a portable JSON credential export,
 * or a pasted raw session token / API key.
 */
export function parseCredentials(
  content: string,
  filename: string,
): AccountData[] {
  const trimmed = content.trim();
  if (filename.endsWith(".toml") || !trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    const match =
      /^\s*windsurf_api_key\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/m
        .exec(trimmed);
    if (match) {
      const token = match[1][0] === '"'
        ? JSON.parse(match[1])
        : match[1].slice(1, -1);
      if (!token.startsWith("devin-session-token$")) {
        throw new Error("The CLI file does not contain a Devin session token");
      }
      return [{ token, apiKey: null, displayName: "Devin CLI" }];
    }
    if (filename.endsWith(".toml")) {
      throw new Error("The Devin CLI file has no windsurf_api_key");
    }
    if (trimmed.startsWith("devin-session-token$")) {
      return [{ token: trimmed, apiKey: null, displayName: "Devin account" }];
    }
    if (/\s/.test(trimmed) || trimmed.length < 8) {
      throw new Error("The file does not look like a Devin credential");
    }
    return [{ token: "", apiKey: trimmed, displayName: "Devin account" }];
  }
  const decoded = JSON.parse(trimmed);
  const records = Array.isArray(decoded)
    ? decoded
    : decoded.accounts ?? [decoded];
  return records.map((value: Record<string, unknown>) => {
    const token = String(
      value.token ?? value.windsurf_api_key ?? value.accessToken ?? "",
    ).trim();
    const apiKey = String(value.api_key ?? value.apiKey ?? "").trim() || null;
    if (!token && !apiKey) {
      throw new Error("Each Devin account needs a token or API key");
    }
    if (token && !token.startsWith("devin-session-token$")) {
      throw new Error("Expected a Devin session token");
    }
    return {
      token,
      apiKey,
      displayName: String(value.name ?? value.displayName ?? "Devin account"),
    };
  });
}

async function sha256Hex(input: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function buildAccountDraft(
  account: AccountData,
  context: ProviderContext,
): Promise<ResourceDraft> {
  const data: AccountData = { ...account };
  if (!data.token) {
    data.token = await mintSession(data.apiKey!, context);
  }
  await unary("GetCliModelConfigs", data.token, context);
  const status = await fetchUserStatus(data.token, context);
  if (status) {
    data.email = status.email ?? data.email ?? null;
    data.userId = status.userId ?? data.userId ?? null;
    data.quota = status.quota ?? data.quota ?? null;
    const isGenericName = !data.displayName ||
      data.displayName === "Devin CLI" ||
      data.displayName === "Devin account";
    if (isGenericName) {
      if (status.name && status.email) {
        data.displayName = `${status.name} (${status.email})`;
      } else {
        data.displayName = status.email ?? status.name ?? data.displayName;
      }
    }
  }
  const identityKey = data.email?.toLowerCase() ?? data.userId ?? null;
  const key = identityKey
    ? `devin:${identityKey}`
    : await sha256Hex(data.apiKey ?? data.token);
  return {
    key,
    privateData: data as unknown as JsonValue,
    state: quotaState(data.quota),
  };
}

export const devinBrowserOAuth: OAuth2AuthorizationCodeAddMethod = {
  type: "oauth2.authorization-code",
  id: "devin-browser",
  displayName: {
    "en-US": "Sign in with Devin",
    "zh-CN": "使用 Devin 登录",
  },
  description: {
    "en-US":
      "Authorize in your browser to add a Devin account. Repeat to add multiple accounts.",
    "zh-CN": "在浏览器中完成授权以添加 Devin 账号，可重复登录添加多个账号。",
  },
  callback: { path: "/callback" },
  async begin(
    input: { redirectUri: string; state: string; codeChallenge: string },
    _context: ProviderContext,
  ): Promise<OAuth2AuthorizationCodeBegin> {
    const params = new URLSearchParams({
      redirect_uri: input.redirectUri,
      state: input.state,
      prompt: "select_account",
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
    });
    return {
      session: { createdAtMs: Date.now() },
      authorizationUrl: `${DEVIN_AUTH_CONTINUE_URL}?${params.toString()}`,
      expiresAtMs: Date.now() + AUTHORIZATION_LIFETIME_MS,
    };
  },
  async complete(
    sessionValue: JsonValue,
    input: { code: string; redirectUri: string; codeVerifier: string },
    context: ProviderContext,
  ): Promise<ResourceDraft[]> {
    const session = object(sessionValue);
    if (
      typeof session?.createdAtMs === "number" &&
      Date.now() - session.createdAtMs > AUTHORIZATION_LIFETIME_MS
    ) {
      throw new Error("Devin authorization expired. Please try again.");
    }
    const token = await exchangePkceCode(
      input.code,
      input.codeVerifier,
      context,
    );
    return [
      await buildAccountDraft(
        { token, apiKey: null, displayName: "Devin account" },
        context,
      ),
    ];
  },
};

export const credentialImport: ResourceImportSupport = {
  displayName: {
    "en-US": "Import Devin credentials",
    "zh-CN": "导入 Devin 凭证",
  },
  description: {
    "en-US":
      "Paste a Devin session token (devin-session-token$...) or API key, or import credentials.toml / JSON with token/api_key. Session-only accounts need reimport after expiry; API keys can renew sessions.",
    "zh-CN":
      "粘贴 Devin session token(devin-session-token$...)或 API key,或导入 credentials.toml / 含 token/api_key JSON.",
  },
  accept: [".toml", ".json", ".txt"],
  multiple: true,
  helpUrl: "https://app.devin.ai/settings",
  async parse(files, context) {
    const resources: ResourceDraft[] = [];
    for (const file of files) {
      for (const account of parseCredentials(file.content, file.name)) {
        resources.push(await buildAccountDraft(account, context));
      }
    }
    return { resources };
  },
};

export function presentAccount(resource: ResourceSnapshot): ResourceView {
  const data = accountData(resource);
  const metrics: ResourceMetric[] = [];
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
  const daily = data.quota?.daily;
  if (daily) {
    metrics.push({
      id: "daily",
      label: { "en-US": "Daily quota", "zh-CN": "日额度" },
      unit: "percent",
      value: daily.remainingPercent,
      ...(daily.resetAtMs !== null ? { resetAtMs: daily.resetAtMs } : {}),
    });
  }
  if (
    data.quota?.acuLimit !== null &&
    data.quota?.acuLimit !== undefined &&
    data.quota.acuLimit > 0 &&
    data.quota.acuConsumed !== null &&
    data.quota.acuConsumed !== undefined
  ) {
    const remainingPercent = clampPercent(
      Math.round(
        ((data.quota.acuLimit - data.quota.acuConsumed) / data.quota.acuLimit) *
          100,
      ),
    );
    metrics.push({
      id: "acu",
      label: { "en-US": "ACU", "zh-CN": "ACU" },
      unit: "percent",
      value: remainingPercent,
    });
  }
  const fallbackDescription = data.apiKey
    ? "Direct Devin API; renewable session"
    : "Direct Devin API; session token";
  return {
    displayName: data.displayName,
    description: data.quota?.planLabel ?? fallbackDescription,
    ...(metrics.length > 0 ? { metrics } : {}),
  };
}

export async function refreshAccount(
  resource: ResourceSnapshot,
  context: ProviderContext,
): Promise<ResourcePatch> {
  const data = accountData(resource);
  const token = data.apiKey
    ? await mintSession(data.apiKey, context)
    : data.token;
  await unary("GetCliModelConfigs", token, context);
  const status = await fetchUserStatus(token, context);
  const nextData: AccountData = {
    ...data,
    token,
    ...(status?.email ? { email: status.email } : {}),
    ...(status?.userId ? { userId: status.userId } : {}),
    ...(status?.quota ? { quota: status.quota } : {}),
  };
  if (
    status &&
    (!nextData.displayName ||
      nextData.displayName === "Devin CLI" ||
      nextData.displayName === "Devin account")
  ) {
    nextData.displayName = status.name && status.email
      ? `${status.name} (${status.email})`
      : (status.email ?? status.name ?? nextData.displayName);
  }
  return {
    privateData: nextData as unknown as JsonValue,
    state: quotaState(nextData.quota),
  };
}

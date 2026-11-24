import type { JsonValue } from "cursor-byok:provider";
import type { ModelDefinition, ModelSnapshot, ModelSupport } from "cursor-byok:model";
import {
  type AccountData,
  accountData,
  isModelDisabledForAccount,
} from "./resources.ts";

export const ANTIGRAVITY_PROD_ENDPOINT = "https://cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_SANDBOX_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";

export const ANTIGRAVITY_ENDPOINTS = [
  ANTIGRAVITY_DAILY_ENDPOINT,
  ANTIGRAVITY_PROD_ENDPOINT,
  ANTIGRAVITY_SANDBOX_ENDPOINT,
];

const FETCH_AVAILABLE_MODELS_PATH = "/v1internal:fetchAvailableModels";
// Google gates newer models by this client version: Antigravity 2.34.0 exposes
// Gemini 4 Neon/Hydrogen/Carbon/Argon (with xhigh), Claude 5.5 (1M), and groupedModels.
export const ANTIGRAVITY_USER_AGENT =
  "antigravity/hub/2.34.0 (aidev_client; os_type=darwin; arch=arm64; cl=1012564305)";

export const ANTIGRAVITY_CLIENT_HEADERS: Record<string, string> = {};

const ANTIGRAVITY_DENYLIST = new Set([
  "chat_20706",
  "chat_23310",
  "tab_flash_lite_preview",
  "tab_jump_flash_lite_preview",
]);

function isInternalHelperModel(id: string): boolean {
  const lower = id.trim().toLowerCase();
  return ANTIGRAVITY_DENYLIST.has(lower) ||
    lower.startsWith("tab_") ||
    lower.endsWith("-tiered") ||
    lower.includes("-tiered-") ||
    lower.endsWith("-sonar");
}

/** Gemini 4 families serve priority inference; matches both base and tiered IDs. */
const GEMINI_4 = /^(gemini-4-(?:neon|hydrogen|carbon|argon))(?:-(?:low|medium|high|xhigh))?$/;

/** Returns the Gemini 4 family (`gemini-4-neon` / `hydrogen` / `carbon` / `argon`) of an ID. */
export function gemini4Family(id: string): string | null {
  return GEMINI_4.exec(id.trim().toLowerCase())?.[1] ?? null;
}

/**
 * Antigravity lists thinking tiers as separate wire IDs (`<base>-low`, `-medium`, `-high`,
 * `-xhigh`, `-max`). Keybridge publishes one model per base and Effort picks the tier.
 */
const TIER_SUFFIX = /^(.+)-(low|medium|high|xhigh|max)$/;
const TIERS = ["low", "medium", "high", "xhigh", "max"] as const;
type Tier = typeof TIERS[number];

function isTier(value: string): value is Tier {
  return (TIERS as readonly string[]).includes(value);
}

/** Maps Effort onto the wire tiers; no effort means medium. */
function effortTier(effort: string | null): Tier {
  switch (effort?.toLowerCase()) {
    case "none":
    case "minimal":
    case "low":
      return "low";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    case "max":
    case "ultra":
      return "max";
    default:
      return "medium";
  }
}

type GroupMetadata = {
  displayName?: string;
  tiers?: Tier[];
  defaultEffort?: Tier;
};

/** Collapses tier siblings into one model; a standalone `<base>` model is replaced by its tiers. */
export function groupTiers(
  models: ModelDefinition[],
  groups?: Map<string, GroupMetadata>,
): ModelDefinition[] {
  const tiers = new Map<string, Tier[]>();
  for (const model of models) {
    const match = TIER_SUFFIX.exec(model.id);
    if (match) {
      const existing = tiers.get(match[1]) ?? [];
      const tier = match[2] as Tier;
      if (!existing.includes(tier)) tiers.set(match[1], [...existing, tier]);
    }
  }
  const familyOf = (id: string): string | null => {
    const base = TIER_SUFFIX.exec(id)?.[1];
    if (base && (tiers.get(base)?.length ?? 0) > 1) return base;
    return (tiers.get(id)?.length ?? 0) > 1 ? id : null;
  };
  const grouped: ModelDefinition[] = [];
  const emitted = new Set<string>();
  for (const model of models) {
    const family = familyOf(model.id);
    if (family === null) {
      grouped.push(model);
      continue;
    }
    if (emitted.has(family)) continue;
    emitted.add(family);
    const meta = groups?.get(family);
    const detected = tiers.get(family)!;
    const levels = meta?.tiers?.length
      ? meta.tiers.filter((tier) => detected.includes(tier))
      : TIERS.filter((tier) => detected.includes(tier));
    const orderedLevels = levels.length > 0
      ? levels
      : TIERS.filter((tier) => detected.includes(tier));
    const first = models.find((candidate) => candidate.id === `${family}-${orderedLevels[0]}`) ??
      model;
    const displayName = meta?.displayName ??
      first.displayName.replace(/\s*\((?:low|medium|high|xhigh|extra high|max)\)\s*$/i, "");
    const defaultEffort = meta?.defaultEffort && orderedLevels.includes(meta.defaultEffort)
      ? meta.defaultEffort
      : undefined;
    grouped.push({
      ...first,
      id: family,
      displayName,
      options: {
        efforts: [...orderedLevels],
        ...(defaultEffort ? { defaultEffort } : {}),
        ...(gemini4Family(family) !== null ? { fast: true } : {}),
      },
      privateData: { tiers: [...orderedLevels] },
    });
  }
  return grouped;
}

/** Wire model ID for a call: the tier matching Effort (or the nearest offered), else the ID. */
export function tierModelId(model: ModelSnapshot, effort: string | null): string {
  const tiers = object(model.privateData)?.tiers;
  if (!Array.isArray(tiers) || tiers.length === 0) return model.id;
  const wanted = TIERS.indexOf(effortTier(effort));
  const tier = (tiers as Tier[]).reduce((best, candidate) =>
    Math.abs(TIERS.indexOf(candidate) - wanted) < Math.abs(TIERS.indexOf(best) - wanted)
      ? candidate
      : best
  );
  return `${model.id}-${tier}`;
}

/**
 * Context windows by model family as documented by each upstream vendor
 * (Gemini 1M, Claude 5.x 1M, Claude 3/4 200K, GPT-4o 128K, gpt-oss-120b 128K).
 * Unknown families report no window rather than a guess.
 */
function contextWindowFor(id: string): number | undefined {
  if (id.startsWith("gemini")) return 1_048_576;
  if (id.startsWith("claude-opus-5") || id.startsWith("claude-sonnet-5")) return 1_000_000;
  if (id.startsWith("claude")) return 200_000;
  if (id.startsWith("gpt-4o")) return 128_000;
  if (id.startsWith("gpt-oss")) return 131_072;
  return undefined;
}

const STATIC_ANTIGRAVITY_CATALOG: ModelDefinition[] = [
  // Gemini 4 Neon Series
  {
    id: "gemini-4-neon-low",
    displayName: "Gemini 4 Neon (Low)",
    description: "For most deep reasoning and complex problems",
    capabilities: { images: true },
    maxOutputTokens: 262144,
  },
  {
    id: "gemini-4-neon-medium",
    displayName: "Gemini 4 Neon (Medium)",
    description: "For most deep reasoning and complex problems",
    capabilities: { images: true },
    maxOutputTokens: 262144,
  },
  {
    id: "gemini-4-neon-high",
    displayName: "Gemini 4 Neon (High)",
    description: "For most deep reasoning and complex problems",
    capabilities: { images: true },
    maxOutputTokens: 262144,
  },
  {
    id: "gemini-4-neon-xhigh",
    displayName: "Gemini 4 Neon (XHigh)",
    description: "For most deep reasoning and complex problems",
    capabilities: { images: true },
    maxOutputTokens: 262144,
  },

  // Gemini 4 Carbon Series
  {
    id: "gemini-4-carbon-low",
    displayName: "Gemini 4 Carbon (Low)",
    description: "For your hardest, long-horizon tasks",
    capabilities: { images: true },
    maxOutputTokens: 262144,
  },
  {
    id: "gemini-4-carbon-medium",
    displayName: "Gemini 4 Carbon (Medium)",
    description: "For your hardest, long-horizon tasks",
    capabilities: { images: true },
    maxOutputTokens: 262144,
  },
  {
    id: "gemini-4-carbon-high",
    displayName: "Gemini 4 Carbon (High)",
    description: "For your hardest, long-horizon tasks",
    capabilities: { images: true },
    maxOutputTokens: 262144,
  },

  // Gemini 4 Hydrogen Series
  {
    id: "gemini-4-hydrogen-low",
    displayName: "Gemini 4 Hydrogen (Low)",
    description: "For speed and efficiency in execution tasks",
    capabilities: { images: true },
    maxOutputTokens: 262144,
  },
  {
    id: "gemini-4-hydrogen-medium",
    displayName: "Gemini 4 Hydrogen (Medium)",
    description: "For speed and efficiency in execution tasks",
    capabilities: { images: true },
    maxOutputTokens: 262144,
  },
  {
    id: "gemini-4-hydrogen-high",
    displayName: "Gemini 4 Hydrogen (High)",
    description: "For speed and efficiency in execution tasks",
    capabilities: { images: true },
    maxOutputTokens: 262144,
  },
  {
    id: "gemini-4-hydrogen-xhigh",
    displayName: "Gemini 4 Hydrogen (XHigh)",
    description: "For speed and efficiency in execution tasks",
    capabilities: { images: true },
    maxOutputTokens: 262144,
  },

  // Gemini 4 Argon Series
  {
    id: "gemini-4-argon-low",
    displayName: "Gemini 4 Argon (Low)",
    capabilities: { images: true },
    maxOutputTokens: 65536,
  },
  {
    id: "gemini-4-argon-medium",
    displayName: "Gemini 4 Argon (Medium)",
    capabilities: { images: true },
    maxOutputTokens: 65536,
  },
  {
    id: "gemini-4-argon-high",
    displayName: "Gemini 4 Argon (High)",
    capabilities: { images: true },
    maxOutputTokens: 65536,
  },

  // Gemini 3.8 Series
  {
    id: "gemini-3.8-flash-high",
    displayName: "Gemini 3.8 Flash (High)",
    capabilities: { images: true },
    maxOutputTokens: 65536,
  },
  {
    id: "gemini-3.8-flash-medium",
    displayName: "Gemini 3.8 Flash (Medium)",
    capabilities: { images: true },
    maxOutputTokens: 65536,
  },
  {
    id: "gemini-3.8-flash-low",
    displayName: "Gemini 3.8 Flash (Low)",
    capabilities: { images: true },
    maxOutputTokens: 65536,
  },

  // Gemini 3.7 Series
  {
    id: "gemini-3.7-flash",
    displayName: "Gemini 3.7 Flash",
    capabilities: { images: true },
    maxOutputTokens: 65536,
  },
  {
    id: "gemini-3.7-flash-high",
    displayName: "Gemini 3.7 Flash (High)",
    capabilities: { images: true },
    maxOutputTokens: 65536,
  },
  {
    id: "gemini-3.7-flash-medium",
    displayName: "Gemini 3.7 Flash (Medium)",
    capabilities: { images: true },
    maxOutputTokens: 65536,
  },
  {
    id: "gemini-3.7-flash-low",
    displayName: "Gemini 3.7 Flash (Low)",
    capabilities: { images: true },
    maxOutputTokens: 65536,
  },
  {
    id: "gemini-3.7-flash-thinking",
    displayName: "Gemini 3.7 Flash (Thinking)",
    capabilities: { images: true },
    maxOutputTokens: 65536,
  },

  // Gemini 3.6 Series
  {
    id: "gemini-3.6-flash-high",
    displayName: "Gemini 3.6 Flash (High)",
    capabilities: { images: true },
    maxOutputTokens: 65536,
  },
  {
    id: "gemini-3.6-flash-medium",
    displayName: "Gemini 3.6 Flash (Medium)",
    capabilities: { images: true },
    maxOutputTokens: 65536,
  },
  {
    id: "gemini-3.6-flash-low",
    displayName: "Gemini 3.6 Flash (Low)",
    capabilities: { images: true },
    maxOutputTokens: 65536,
  },

  // Gemini 3.1 Pro Series
  {
    id: "gemini-3.1-pro-preview",
    displayName: "Gemini 3.1 Pro Preview",
    capabilities: { images: true },
    maxOutputTokens: 65536,
  },
  {
    id: "gemini-3.1-pro-high",
    displayName: "Gemini 3.1 Pro (High)",
    capabilities: { images: true },
    maxOutputTokens: 65536,
  },
  {
    id: "gemini-3.1-pro-medium",
    displayName: "Gemini 3.1 Pro (Medium)",
    capabilities: { images: true },
    maxOutputTokens: 65536,
  },
  {
    id: "gemini-3.1-pro-low",
    displayName: "Gemini 3.1 Pro (Low)",
    capabilities: { images: true },
    maxOutputTokens: 65536,
  },

  // Gemini 2.5 / 2.0 Series
  {
    id: "gemini-2.5-pro",
    displayName: "Gemini 2.5 Pro",
    capabilities: { images: true },
    maxOutputTokens: 65536,
  },
  {
    id: "gemini-2.5-flash",
    displayName: "Gemini 2.5 Flash",
    capabilities: { images: true },
    maxOutputTokens: 65536,
  },
  {
    id: "gemini-2.5-flash-thinking",
    displayName: "Gemini 2.5 Flash Thinking",
    capabilities: { images: true },
    maxOutputTokens: 65536,
  },
  {
    id: "gemini-2.5-flash-lite",
    displayName: "Gemini 2.5 Flash Lite",
    capabilities: { images: true },
    maxOutputTokens: 65536,
  },
  {
    id: "gemini-2.0-flash",
    displayName: "Gemini 2.0 Flash",
    capabilities: { images: true },
    maxOutputTokens: 65536,
  },
  {
    id: "gemini-2.0-flash-lite",
    displayName: "Gemini 2.0 Flash Lite",
    capabilities: { images: true },
    maxOutputTokens: 65536,
  },

  // Claude 5.5 Series (1M context, 128K output via Antigravity)
  {
    id: "claude-opus-5-5-low",
    displayName: "Claude Opus 5.5 (Low)",
    capabilities: { images: true },
    maxOutputTokens: 128000,
  },
  {
    id: "claude-opus-5-5-medium",
    displayName: "Claude Opus 5.5 (Medium)",
    capabilities: { images: true },
    maxOutputTokens: 128000,
  },
  {
    id: "claude-opus-5-5-high",
    displayName: "Claude Opus 5.5 (High)",
    capabilities: { images: true },
    maxOutputTokens: 128000,
  },
  {
    id: "claude-sonnet-5-5-low",
    displayName: "Claude Sonnet 5.5 (Low)",
    capabilities: { images: true },
    maxOutputTokens: 128000,
  },
  {
    id: "claude-sonnet-5-5-medium",
    displayName: "Claude Sonnet 5.5 (Medium)",
    capabilities: { images: true },
    maxOutputTokens: 128000,
  },
  {
    id: "claude-sonnet-5-5-high",
    displayName: "Claude Sonnet 5.5 (High)",
    capabilities: { images: true },
    maxOutputTokens: 128000,
  },

  // Claude 4.6 / 3.x Series (via Antigravity)
  {
    id: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6 (Antigravity)",
    capabilities: { images: true },
    maxOutputTokens: 64000,
  },
  {
    id: "claude-sonnet-4-6-thinking",
    displayName: "Claude Sonnet 4.6 Thinking (Antigravity)",
    capabilities: { images: true },
    maxOutputTokens: 64000,
  },
  {
    id: "claude-opus-4-6-thinking",
    displayName: "Claude 3.7 Opus Thinking (Antigravity)",
    capabilities: { images: true },
    maxOutputTokens: 64000,
  },
  {
    id: "claude-3-7-sonnet",
    displayName: "Claude 3.7 Sonnet (Antigravity)",
    capabilities: { images: true },
    maxOutputTokens: 64000,
  },
  {
    id: "claude-3-5-sonnet",
    displayName: "Claude 3.5 Sonnet (Antigravity)",
    capabilities: { images: true },
    maxOutputTokens: 64000,
  },
  {
    id: "claude-3-5-haiku",
    displayName: "Claude 3.5 Haiku (Antigravity)",
    capabilities: { images: true },
    maxOutputTokens: 64000,
  },

  // Other Models
  {
    id: "gpt-4o",
    displayName: "GPT-4o (Antigravity / Gemini)",
    capabilities: { images: true },
    maxOutputTokens: 65536,
  },
  {
    id: "gpt-4o-mini",
    displayName: "GPT-4o Mini (Antigravity / Gemini)",
    capabilities: { images: true },
    maxOutputTokens: 65536,
  },
  {
    id: "gpt-oss-120b-medium",
    displayName: "GPT OSS 120B Medium",
    capabilities: { images: false },
    maxOutputTokens: 32768,
  },
  {
    id: "gemini-3.1-flash-image",
    displayName: "Gemini 3.1 Flash Image",
    capabilities: { images: true },
    maxOutputTokens: 65536,
  },
];

export const STATIC_ANTIGRAVITY_MODELS: ModelDefinition[] = groupTiers(
  STATIC_ANTIGRAVITY_CATALOG.map((model) => ({
    ...model,
    contextWindow: contextWindowFor(model.id),
  })),
);

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string"
    ? Number(value)
    : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function parseGroupMetadata(root: Record<string, unknown>): Map<string, GroupMetadata> {
  const groups = new Map<string, GroupMetadata>();
  const rawGrouped = object(root.groupedModels);
  if (rawGrouped) {
    for (const [familyId, rawGroup] of Object.entries(rawGrouped)) {
      const group = object(rawGroup);
      if (!group) continue;
      const displayName = text(group.displayName) ?? undefined;
      const rawLevels = Array.isArray(group.supportedThinkingLevels)
        ? group.supportedThinkingLevels
        : [];
      const tiers = rawLevels
        .map((entry) => text(object(entry)?.thinkingSuffix)?.toLowerCase())
        .filter((suffix): suffix is Tier => typeof suffix === "string" && isTier(suffix));
      groups.set(familyId.trim(), {
        ...(displayName ? { displayName } : {}),
        ...(tiers.length > 0 ? { tiers } : {}),
      });
    }
  }
  const defaultModelId = text(root.defaultAgentModelId);
  if (defaultModelId) {
    const match = TIER_SUFFIX.exec(defaultModelId);
    if (match && isTier(match[2])) {
      const existing = groups.get(match[1]) ?? {};
      groups.set(match[1], { ...existing, defaultEffort: match[2] });
    }
  }
  return groups;
}

function parseSortRank(root: Record<string, unknown>): Map<string, number> {
  const rank = new Map<string, number>();
  const sorts = Array.isArray(root.agentModelSorts) ? root.agentModelSorts : [];
  let cursor = 0;
  for (const sort of sorts) {
    const groups = Array.isArray(object(sort)?.groups) ? object(sort)!.groups as unknown[] : [];
    for (const group of groups) {
      const ids = Array.isArray(object(group)?.modelIds) ? object(group)!.modelIds as unknown[] : [];
      for (const rawId of ids) {
        const id = text(rawId);
        if (!id) continue;
        const family = TIER_SUFFIX.exec(id)?.[1] ?? id;
        if (!rank.has(family)) rank.set(family, cursor++);
        if (!rank.has(id)) rank.set(id, cursor++);
      }
    }
  }
  return rank;
}

export function parseAntigravityModels(payload: unknown): ModelDefinition[] {
  const root = object(payload);
  const rawModels = object(root?.models);
  if (!root || !rawModels) return [];

  const models: ModelDefinition[] = [];
  const seen = new Set<string>();
  const disabledPrefixes: string[] = [];

  for (const [modelId, raw] of Object.entries(rawModels)) {
    const normalizedId = modelId.trim().toLowerCase();
    if (normalizedId.endsWith("-disabled")) {
      const prefix = normalizedId.slice(0, -"-disabled".length);
      if (prefix) disabledPrefixes.push(prefix);
      continue;
    }
    if (isInternalHelperModel(modelId)) continue;
    const model = object(raw);
    if (!model || model.disabled === true || model.isInternal === true) continue;

    const id = modelId.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const displayName = text(model.displayName) ?? id;
    const description = text(model.tagDescription) ?? text(model.description) ?? undefined;
    const maxOutputTokens = typeof model.maxOutputTokens === "number" && model.maxOutputTokens > 0
      ? model.maxOutputTokens
      : 65_536;
    const contextWindow = positiveInteger(
      model.contextWindow ?? model.context_window ?? model.maxContextTokens ?? model.maxTokens,
    ) ?? contextWindowFor(id);

    models.push({
      id,
      displayName,
      ...(description ? { description } : {}),
      capabilities: {
        images: model.supportsImages === true || id.includes("gemini") || id.includes("claude"),
      },
      maxOutputTokens,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
    });
  }

  // Static wire IDs fill in what discovery did not return, then tiers collapse per model.
  for (const staticModel of STATIC_ANTIGRAVITY_CATALOG) {
    if (!seen.has(staticModel.id) && !isModelDisabledForAccount(staticModel.id, disabledPrefixes)) {
      seen.add(staticModel.id);
      models.push({ ...staticModel, contextWindow: contextWindowFor(staticModel.id) });
    }
  }
  const grouped = groupTiers(models, parseGroupMetadata(root));
  const sortRank = parseSortRank(root);
  if (sortRank.size > 0) {
    grouped.sort((left, right) => {
      const leftRank = sortRank.get(left.id) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = sortRank.get(right.id) ?? Number.MAX_SAFE_INTEGER;
      return leftRank - rightRank;
    });
  }
  return grouped;
}

async function fetchModelsForAccount(
  data: AccountData,
  context: Parameters<ModelSupport["list"]>[1],
): Promise<ModelDefinition[] | null> {
  const payloads = [
    JSON.stringify({ project: data.projectId || "bamboo-precept-lgxtn" }),
    JSON.stringify({}),
  ];

  const requestModels = (endpoint: string, accessToken: string, bodyPayload: string) =>
    context.network.fetch(`${endpoint}${FETCH_AVAILABLE_MODELS_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "user-agent": ANTIGRAVITY_USER_AGENT,
        ...ANTIGRAVITY_CLIENT_HEADERS,
      },
      body: bodyPayload,
    });

  for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
    for (const bodyPayload of payloads) {
      try {
        const response = await requestModels(endpoint, data.accessToken, bodyPayload);
        if (response.status >= 200 && response.status < 300) {
          const body = JSON.parse(response.body);
          const models = parseAntigravityModels(body);
          if (models.length > 0) return models;
        }
      } catch {
        // Continue
      }
    }
  }

  return null;
}

export const antigravityModels: ModelSupport = {
  list: async ({ resource }, context): Promise<ModelDefinition[]> => {
    if (!resource) return STATIC_ANTIGRAVITY_MODELS;
    let data: AccountData;
    try {
      data = accountData(resource);
    } catch {
      return STATIC_ANTIGRAVITY_MODELS;
    }

    // The host refreshes and persists the account before discovery. Never
    // discard a credential patch inside this read-only catalog operation.
    const models = (await fetchModelsForAccount(data, context)) ?? STATIC_ANTIGRAVITY_MODELS;
    return models.filter((model) => !isModelDisabledForAccount(model.id, data.disabledModels));
  },
};

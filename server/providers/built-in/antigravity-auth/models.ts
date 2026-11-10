import type { JsonValue } from "cursor-byok:provider";
import type { ModelDefinition, ModelSnapshot, ModelSupport } from "cursor-byok:model";
import { accountData } from "./resources.ts";

export const ANTIGRAVITY_PROD_ENDPOINT = "https://cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_SANDBOX_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";

export const ANTIGRAVITY_ENDPOINTS = [
  ANTIGRAVITY_DAILY_ENDPOINT,
  ANTIGRAVITY_PROD_ENDPOINT,
  ANTIGRAVITY_SANDBOX_ENDPOINT,
];

const FETCH_AVAILABLE_MODELS_PATH = "/v1internal:fetchAvailableModels";
// Google gates newer models by this client version: Gemini 4 Carbon/Argon are
// only listed and served for antigravity/hub >= 2.15.5.
export const ANTIGRAVITY_USER_AGENT =
  "antigravity/hub/2.31.0 (aidev_client; os_type=darwin; arch=arm64; cl=975423596)";

export const ANTIGRAVITY_CLIENT_HEADERS: Record<string, string> = {};

const ANTIGRAVITY_DENYLIST = new Set(["chat_20706", "chat_23310"]);

/** Gemini 4 families serve priority inference; matches both base and tiered IDs. */
const GEMINI_4 = /^(gemini-4-(?:carbon|argon))(?:-(?:low|medium|high))?$/;

/** Returns the Gemini 4 family (`gemini-4-carbon` / `gemini-4-argon`) of a base or tiered ID. */
export function gemini4Family(id: string): string | null {
  return GEMINI_4.exec(id.trim().toLowerCase())?.[1] ?? null;
}

/**
 * Antigravity lists thinking tiers as separate wire IDs (`<base>-low`, `-medium`, `-high`).
 * Keybridge publishes one model per base and Cursor's Effort picks the tier.
 */
const TIER_SUFFIX = /^(.+)-(low|medium|high)$/;
const TIERS = ["low", "medium", "high"] as const;
type Tier = typeof TIERS[number];

/** Maps Cursor's Effort onto the three wire tiers; no effort means medium. */
function effortTier(effort: string | null): Tier {
  switch (effort?.toLowerCase()) {
    case "none":
    case "minimal":
    case "low":
      return "low";
    case "high":
    case "xhigh":
    case "max":
    case "ultra":
      return "high";
    default:
      return "medium";
  }
}

/** Collapses tier siblings into one model; a standalone `<base>` model is replaced by its tiers. */
export function groupTiers(models: ModelDefinition[]): ModelDefinition[] {
  const tiers = new Map<string, Tier[]>();
  for (const model of models) {
    const match = TIER_SUFFIX.exec(model.id);
    if (match) tiers.set(match[1], [...(tiers.get(match[1]) ?? []), match[2] as Tier]);
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
    const levels = TIERS.filter((tier) => tiers.get(family)!.includes(tier));
    const first = models.find((candidate) => candidate.id === `${family}-${levels[0]}`) ?? model;
    grouped.push({
      ...first,
      id: family,
      displayName: first.displayName.replace(/\s*\((?:low|medium|high)\)\s*$/i, ""),
      options: { efforts: [...levels], ...(gemini4Family(family) !== null ? { fast: true } : {}) },
      privateData: { tiers: [...levels] },
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
 * (Gemini 1M, Claude 200K, GPT-4o 128K, gpt-oss-120b 128K). Unknown families
 * report no window rather than a guess.
 */
function contextWindowFor(id: string): number | undefined {
  if (id.startsWith("gemini")) return 1_048_576;
  if (id.startsWith("claude")) return 200_000;
  if (id.startsWith("gpt-4o")) return 128_000;
  if (id.startsWith("gpt-oss")) return 131_072;
  return undefined;
}

const STATIC_ANTIGRAVITY_CATALOG: ModelDefinition[] = [
  // Gemini 4 Series
  {
    id: "gemini-4-carbon-low",
    displayName: "Gemini 4 Carbon (Low)",
    capabilities: { images: true },
    maxOutputTokens: 65536,
  },

  {
    id: "gemini-4-carbon-medium",
    displayName: "Gemini 4 Carbon (Medium)",
    capabilities: { images: true },
    maxOutputTokens: 65536,
  },

  {
    id: "gemini-4-carbon-high",
    displayName: "Gemini 4 Carbon (High)",
    capabilities: { images: true },
    maxOutputTokens: 65536,
  },

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
  {
    id: "gemini-3.8-flash-tiered",
    displayName: "Gemini 3.8 Flash (Tiered)",
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
    id: "gemini-3.7-flash-tiered",
    displayName: "Gemini 3.7 Flash (Tiered)",
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

  // Claude Series (via Antigravity)
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

export function parseAntigravityModels(payload: unknown): ModelDefinition[] {
  const root = object(payload);
  const rawModels = object(root?.models);
  if (!rawModels) return [];

  const models: ModelDefinition[] = [];
  const seen = new Set<string>();

  for (const [modelId, raw] of Object.entries(rawModels)) {
    if (ANTIGRAVITY_DENYLIST.has(modelId)) continue;
    const model = object(raw);
    if (!model) continue;

    const id = modelId.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const displayName = text(model.displayName) ?? id;
    const maxOutputTokens = typeof model.maxOutputTokens === "number" && model.maxOutputTokens > 0
      ? model.maxOutputTokens
      : 65_536;
    const contextWindow = positiveInteger(
      model.contextWindow ?? model.context_window ?? model.maxContextTokens ?? model.maxTokens,
    ) ?? contextWindowFor(id);

    models.push({
      id,
      displayName,
      capabilities: {
        images: model.supportsImages === true || id.includes("gemini") || id.includes("claude"),
      },
      maxOutputTokens,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
    });
  }

  // Static wire IDs fill in what discovery did not return, then tiers collapse per model.
  for (const staticModel of STATIC_ANTIGRAVITY_CATALOG) {
    if (!seen.has(staticModel.id)) {
      seen.add(staticModel.id);
      models.push({ ...staticModel, contextWindow: contextWindowFor(staticModel.id) });
    }
  }
  return groupTiers(models);
}

export const antigravityModels: ModelSupport = {
  list: async ({ resource }, context): Promise<ModelDefinition[]> => {
    if (!resource) return STATIC_ANTIGRAVITY_MODELS;
    let data;
    try {
      data = accountData(resource);
    } catch {
      return STATIC_ANTIGRAVITY_MODELS;
    }

    const payloads = [
      JSON.stringify({ project: data.projectId || "bamboo-precept-lgxtn" }),
      JSON.stringify({}),
    ];

    for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
      for (const bodyPayload of payloads) {
        try {
          const response = await context.network.fetch(
            `${endpoint}${FETCH_AVAILABLE_MODELS_PATH}`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${data.accessToken}`,
                "content-type": "application/json",
                "user-agent": ANTIGRAVITY_USER_AGENT,
                ...ANTIGRAVITY_CLIENT_HEADERS,
              },
              body: bodyPayload,
            },
          );
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

    return STATIC_ANTIGRAVITY_MODELS;
  },
};

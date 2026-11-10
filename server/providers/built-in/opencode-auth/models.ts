import type { ProviderContext } from "cursor-byok:provider";
import type { ModelDefinition, ModelSupport } from "cursor-byok:model";
import type { ResourceSnapshot } from "cursor-byok:resource";
import { accountData, authHeaders, MODELS_URL } from "./resources.ts";

export type Lane = "chat" | "responses";

type CatalogEntry = { id: string; name: string; lane: Lane; images?: boolean };

/**
 * OpenCode Go models route through different upstream lanes by family: Kimi/GLM/Qwen/MiMo/MiniMax/
 * DeepSeek/LongCat etc. use /chat/completions; Grok/GPT/Muse Spark only accept
 * /responses. See 9router opencodeFamilyFormats.
 */
const FAMILIES: { match: RegExp; lane: Lane }[] = [
  { match: /^(grok|gpt|muse[-_]?spark)/i, lane: "responses" },
];

// Fallback catalog when /models lacks lane info (from the 9router opencode-go registry).
const CURATED: CatalogEntry[] = [
  { id: "kimi-k3", name: "Kimi K3", lane: "chat" },
  { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", lane: "chat" },
  { id: "kimi-k2.6", name: "Kimi K2.6", lane: "chat" },
  { id: "kimi-k2.5", name: "Kimi K2.5", lane: "chat" },
  { id: "glm-5.3", name: "GLM 5.3", lane: "chat" },
  { id: "glm-5.3-flash", name: "GLM 5.3 Flash (Vision)", lane: "chat", images: true },
  { id: "glm-5.2", name: "GLM 5.2", lane: "chat" },
  { id: "glm-5.1", name: "GLM 5.1", lane: "chat" },
  { id: "glm-5", name: "GLM 5", lane: "chat" },
  { id: "qwen3.8-max", name: "Qwen 3.8 Max", lane: "chat" },
  { id: "qwen3.7-max", name: "Qwen 3.7 Max", lane: "chat" },
  { id: "qwen3.6-plus", name: "Qwen 3.6 Plus", lane: "chat" },
  { id: "minimax-m3", name: "MiniMax M3", lane: "chat" },
  { id: "minimax-m2.7", name: "MiniMax M2.7", lane: "chat" },
  { id: "mimo-v2.6-pro", name: "MiMo V2.6 Pro", lane: "chat" },
  { id: "mimo-v2.6-flash", name: "MiMo V2.6 Flash", lane: "chat" },
  { id: "mimo-v2.5-pro", name: "MiMo V2.5 Pro", lane: "chat" },
  { id: "mimo-v2-omni", name: "MiMo V2 Omni", lane: "chat", images: true },
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", lane: "chat" },
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", lane: "chat" },
  {
    id: "deepseek-v4-flash-vision-exp",
    name: "DeepSeek V4 Flash Vision (Exp)",
    lane: "chat",
    images: true,
  },
  { id: "longcat-2.0", name: "LongCat 2.0", lane: "chat" },
  { id: "hy4-preview", name: "Hy4 Preview", lane: "chat" },
  { id: "grok-4.7", name: "Grok 4.7", lane: "responses" },
  { id: "grok-4.6", name: "Grok 4.6", lane: "responses" },
  { id: "grok-4.5", name: "Grok 4.5", lane: "responses" },
  { id: "gpt-6-luna", name: "GPT 6 Luna", lane: "responses" },
  { id: "gpt-5.6-luna", name: "GPT 5.6 Luna", lane: "responses" },
  { id: "muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor", lane: "responses" },
];

/** Effort levels each OpenCode Go lane accepts (the chat lane clamps onto low/high/max). */
export const LANE_EFFORTS: Record<Lane, string[]> = {
  chat: ["low", "high", "max"],
  responses: ["low", "medium", "high", "xhigh"],
};

export function laneForModel(modelId: string): Lane {
  const base = modelId.replace(/\([^()]+\)\s*$/, "").trim();
  for (const family of FAMILIES) {
    if (family.match.test(base)) return family.lane;
  }
  const curated = CURATED.find((entry) => entry.id === base);
  return curated?.lane ?? "chat";
}

function displayName(id: string): string {
  const curated = CURATED.find((entry) => entry.id === id);
  if (curated) return curated.name;
  return id
    .split(/[-_]/)
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ");
}

function definition(entry: CatalogEntry): ModelDefinition {
  return {
    id: entry.id,
    displayName: entry.name,
    options: { efforts: LANE_EFFORTS[entry.lane] },
    privateData: { lane: entry.lane },
    ...(entry.images ? { capabilities: { images: true } } : {}),
  };
}

async function fetchCatalog(
  resource: ResourceSnapshot,
  context: ProviderContext,
): Promise<string[]> {
  const data = accountData(resource);
  const response = await context.network.fetch(MODELS_URL, {
    method: "GET",
    headers: authHeaders(data.apiKey),
  });
  if (response.status !== 200) return [];
  const parsed = JSON.parse(response.body) as Record<string, unknown>;
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.data)
    ? parsed.data
    : Array.isArray(parsed.models)
    ? parsed.models
    : [];
  return list
    .map((item) => (typeof item === "string" ? item : (item as { id?: string }).id))
    .filter((id): id is string => typeof id === "string" && id.trim() !== "");
}

export const opencodeModels: ModelSupport = {
  async list(input, context) {
    if (input.resource) {
      try {
        const ids = await fetchCatalog(input.resource, context);
        if (ids.length) {
          return ids.map((id) => definition({ id, name: displayName(id), lane: laneForModel(id) }));
        }
      } catch {
        // Falls back to the fallback list when the catalog endpoint fails.
      }
    }
    return CURATED.map(definition);
  },
};

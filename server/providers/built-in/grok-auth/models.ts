import type { ModelDefinition, ModelSupport } from "cursor-byok:model";
import { accountData } from "./resources.ts";

const LANGUAGE_MODELS_URL = "https://api.x.ai/v1/language-models";
const MODELS_URL = "https://api.x.ai/v1/models";

/** Grok 4-family models expose a 256K-token context window per xAI's model docs. */
const GROK_4_CONTEXT_WINDOW = 256_000;

/** Free accounts cannot call the model list endpoint (403 spending-limit); falls back to known models. */
export const FALLBACK_MODELS: ModelDefinition[] = [
  {
    id: "grok-4.6",
    displayName: "Grok 4.6",
    contextWindow: GROK_4_CONTEXT_WINDOW,
    capabilities: { images: true },
  },
  {
    id: "grok-4.5",
    displayName: "Grok 4.5",
    contextWindow: GROK_4_CONTEXT_WINDOW,
    capabilities: { images: true },
  },
];

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function modalities(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => (typeof item === "string" ? [item.toLowerCase()] : []))
    : [];
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string"
    ? Number(value)
    : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

/** xAI /v1/language-models reports prompt limits under a few names across versions. */
function contextWindow(model: Record<string, unknown>): number | undefined {
  return positiveInteger(
    model.prompt_text_token_limit ?? model.promptTextTokenLimit ?? model.context_length ??
      model.contextLength ?? model.max_context_length ?? model.maxContextLength ??
      model.context_window ?? model.contextWindow,
  ) ?? undefined;
}

/** Turns a model ID into a readable name, e.g. grok-4-fast -> Grok 4 Fast. */
function displayName(id: string): string {
  return id
    .split("-")
    .map((part) => (/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ");
}

/** Accepts both the /v1/language-models models array and the /v1/models data array. */
export function parseGrokModels(body: unknown): ModelDefinition[] {
  const root = object(body);
  const source = root?.models ?? root?.data ?? body;
  if (!Array.isArray(source)) {
    throw new Error("Grok model discovery response does not contain a model list");
  }
  const seen = new Set<string>();
  const models: ModelDefinition[] = [];
  for (const raw of source) {
    const model = object(raw);
    const id = model ? text(model.id ?? model.name) : null;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const inputs = modalities(model?.input_modalities ?? model?.inputModalities);
    const window = contextWindow(model ?? {});
    models.push({
      id,
      displayName: displayName(id),
      ...(window !== undefined ? { contextWindow: window } : {}),
      capabilities: {
        images: inputs.length === 0 || inputs.includes("image"),
      },
    });
  }
  return models;
}

export const grokModels: ModelSupport = {
  list: async ({ resource }, context): Promise<ModelDefinition[]> => {
    if (!resource) throw new Error("add a Grok account before syncing models");
    const data = accountData(resource);
    const headers = {
      accept: "application/json",
      authorization: `Bearer ${data.accessToken}`,
    };
    // language-models carries modality and context metadata; falls back to the standard list when unavailable.
    let response = await context.network.fetch(LANGUAGE_MODELS_URL, { method: "GET", headers });
    if (response.status < 200 || response.status >= 300) {
      response = await context.network.fetch(MODELS_URL, { method: "GET", headers });
    }
    if (response.status < 200 || response.status >= 300) {
      return FALLBACK_MODELS;
    }
    let body: unknown;
    try {
      body = JSON.parse(response.body);
    } catch {
      throw new Error("Grok model discovery returned invalid JSON");
    }
    const models = parseGrokModels(body);
    return models.length > 0 ? models : FALLBACK_MODELS;
  },
};

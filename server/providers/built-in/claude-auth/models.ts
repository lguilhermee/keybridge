import type { ModelDefinition, ModelSupport } from "cursor-byok:model";

const MAX_OUTPUT_TOKENS = 64_000;
/** Claude 5-family models have a native 1M-token window on the first-party API. */
const CONTEXT_1M = 1_000_000;
/** Haiku 4.5 is limited to 200K tokens. */
const CONTEXT_200K = 200_000;

/** Models that accept `speed: "fast"`; other models reject it, so they run at standard speed. */
export const FAST_MODE_MODELS: ReadonlySet<string> = new Set([
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-fable-5-2",
]);

/** Model IDs accepted by the subscription endpoint; kept in sync with Claude Code's model catalog. */
const CATALOG: ModelDefinition[] = [
  {
    id: "claude-opus-5-5",
    displayName: "Claude Opus 5.5",
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    contextWindow: CONTEXT_1M,
    capabilities: { images: true },
  },
  {
    id: "claude-opus-5",
    displayName: "Claude Opus 5",
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    contextWindow: CONTEXT_1M,
    capabilities: { images: true },
  },
  {
    id: "claude-fable-5-2",
    displayName: "Claude Fable 5.2",
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    contextWindow: CONTEXT_1M,
    capabilities: { images: true },
  },
  {
    id: "claude-fable-5-1",
    displayName: "Claude Fable 5.1",
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    contextWindow: CONTEXT_1M,
    capabilities: { images: true },
  },
  {
    id: "claude-fable-5",
    displayName: "Claude Fable 5",
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    contextWindow: CONTEXT_1M,
    capabilities: { images: true },
  },
  {
    id: "claude-sonnet-5-5",
    displayName: "Claude Sonnet 5.5",
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    contextWindow: CONTEXT_1M,
    capabilities: { images: true },
  },
  {
    id: "claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    contextWindow: CONTEXT_1M,
    capabilities: { images: true },
  },
  {
    id: "claude-haiku-4-5-20251001",
    displayName: "Claude Haiku 4.5",
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    contextWindow: CONTEXT_200K,
    capabilities: { images: true },
  },
];

/** Effort levels the subscription endpoint accepts as `output_config.effort`. */
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export const claudeModels: ModelSupport = {
  async list() {
    return CATALOG.map((model) => ({
      ...model,
      options: { efforts: EFFORTS, ...(FAST_MODE_MODELS.has(model.id) ? { fast: true } : {}) },
    }));
  },
};

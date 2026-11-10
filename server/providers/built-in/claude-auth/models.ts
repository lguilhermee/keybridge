import type { ModelDefinition, ModelSupport } from "cursor-byok:model";

const MAX_OUTPUT_TOKENS = 64_000;

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
    capabilities: { images: true },
  },
  {
    id: "claude-opus-5",
    displayName: "Claude Opus 5",
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    capabilities: { images: true },
  },
  {
    id: "claude-fable-5-2",
    displayName: "Claude Fable 5.2",
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    capabilities: { images: true },
  },
  {
    id: "claude-fable-5-1",
    displayName: "Claude Fable 5.1",
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    capabilities: { images: true },
  },
  {
    id: "claude-fable-5",
    displayName: "Claude Fable 5",
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    capabilities: { images: true },
  },
  {
    id: "claude-sonnet-5-5",
    displayName: "Claude Sonnet 5.5",
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    capabilities: { images: true },
  },
  {
    id: "claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    capabilities: { images: true },
  },
  {
    id: "claude-haiku-4-5-20251001",
    displayName: "Claude Haiku 4.5",
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    capabilities: { images: true },
  },
];

export const claudeModels: ModelSupport = {
  async list() {
    return CATALOG;
  },
};

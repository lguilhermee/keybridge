import type { JsonValue, LocalizedText, PluginContext } from "./plugin.ts";
import type { ModelSnapshot, ModelSupport } from "./model.ts";
import type { ResourcePatch, ResourceSnapshot } from "./resource.ts";

/**
 * LLM request contract. The host projects its canonical conversation (ProjectedMessage) into this shape;
 * the plugin adapts it to the upstream Provider's protocol.
 */
export type LlmContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; dataBase64: string };

/** Opaque Provider replay state (e.g. encrypted reasoning items); filtered by providerKind during replay. */
export type LlmReplayState = {
  providerKind: string;
  value: JsonValue;
};

export type LlmToolCall = {
  /** Stable ordinal within the same turn. */
  index: number;
  callId: string;
  name: string;
  /** Parsed JSON arguments. */
  arguments: JsonValue;
};

export type LlmMessage =
  | { role: "system" | "user"; content: LlmContentPart[] }
  | {
    role: "assistant";
    text: string;
    thinking: string;
    replayState: LlmReplayState | null;
    toolCalls: LlmToolCall[];
  }
  | {
    role: "tool";
    callId: string;
    name: string;
    content: string;
    isError: boolean;
    /** Takes precedence over content when non-empty, carrying rich tool results like images. */
    parts: LlmContentPart[];
  };

export type LlmTool = {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  parameters: JsonValue;
};

export type LlmRequest = {
  /** System instruction; empty string means none. */
  instructions: string;
  messages: LlmMessage[];
  tools: LlmTool[];
  reasoning: { enabled: boolean; effort: string | null };
  latency: "fast" | "standard";
  maxOutputTokens: number | null;
  /** Session-level stable cache key for upstream prefix-cache routing affinity (e.g. prompt_cache_key). */
  cacheKey: string | null;
};

/**
 * Token counts for one model call. `inputTokens` is the input that was neither read from nor
 * written to the prompt cache; the host adds `cacheReadTokens` and `cacheWriteTokens` to it to
 * get the full prompt size. Upstreams that report a prompt total including cached tokens must
 * subtract them before emitting.
 */
export type ModelUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
};

/**
 * Normalized output contract matching the host's unified stream events one to one. The plugin emits events as upstream data arrives;
 * text, thinking, and each tool call have explicit start/end boundaries, and tool arguments arrive as deltas.
 * Replay state is emitted once before the stream ends; the host stores it on the assistant message for the next turn's replay.
 */
export type ModelEvent =
  | { type: "text-start" }
  | { type: "text-delta"; text: string }
  | { type: "text-end" }
  | { type: "thinking-start" }
  | { type: "thinking-delta"; text: string }
  | { type: "thinking-end" }
  | { type: "tool-call-start"; index: number; callId: string; name: string }
  | { type: "tool-call-arguments-delta"; index: number; delta: string }
  | { type: "tool-call-end"; index: number }
  | { type: "replay-state"; providerKind: string; value: JsonValue }
  | { type: "usage"; usage: ModelUsage }
  | { type: "done"; reason: "stop" | "length" | "tool-use" };

export type ProviderOutput = {
  emit(event: ModelEvent): void;
};

export type ProviderInvokeInput = {
  model: ModelSnapshot;
  /** The resource the host selected for this call; null for resource-less Providers. */
  resource: ResourceSnapshot | null;
  request: LlmRequest;
};

/**
 * `resource-error` attributes the failure to the selected resource so the host updates its state,
 * and may (in future) retry with a different resource when no events were emitted yet. `patch` also persists
 * side effects of a successful call, like a refreshed access token.
 */
export type ProviderResult =
  | { status: "completed"; patch?: ResourcePatch }
  | { status: "resource-error"; message: string; patch: ResourcePatch }
  | { status: "request-error"; message: string; patch?: ResourcePatch };

export type ProviderSupport = {
  id: string;
  displayName: LocalizedText;
  description?: LocalizedText;
  /** Product identity used for grouping and icons, e.g. "openai". */
  providerType: string;
  /** Resource type consumed per call; omittable for resource-less Providers. */
  resourceType?: string;
  models?: ModelSupport;
  invoke(
    input: ProviderInvokeInput,
    output: ProviderOutput,
    context: PluginContext,
  ): Promise<ProviderResult>;
};

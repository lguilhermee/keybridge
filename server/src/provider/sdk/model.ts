import type { JsonValue, ProviderContext } from "./provider.ts";
import type { ResourceSnapshot } from "./resource.ts";

export type ModelCapabilities = {
  images?: boolean;
};

/**
 * Settings Cursor's model picker offers for one model. Publish one model per upstream family and
 * declare its tiers here instead of listing every tier as its own model; `invoke` then maps the
 * chosen values (`request.reasoning`, `request.latency`, `request.contextWindow`) onto the upstream.
 */
export type ModelOptions = {
  /**
   * Effort levels in ascending order, from: none, minimal, low, medium, high, xhigh, max, ultra.
   * "none" means reasoning off. Omit when the model has no Effort setting.
   */
  efforts?: string[];
  /** Effort preselected in the picker; defaults to "high" when offered, else the highest level. */
  defaultEffort?: string;
  /** Offers the Fast toggle (a faster, usually pricier upstream tier). */
  fast?: boolean;
};

export type ModelDefinition = {
  id: string;
  displayName: string;
  description?: string;
  maxOutputTokens?: number;
  /** Total prompt window in tokens; powers UI context-window meter when present. */
  contextWindow?: number;
  capabilities?: ModelCapabilities;
  options?: ModelOptions;
  /** Passed back verbatim on later calls; never shown to user. */
  privateData?: JsonValue;
};

/** One model persisted in host catalog. */
export type ModelSnapshot = ModelDefinition;

export type ModelListInput = {
  /** The first usable resource when discovery needs auth, otherwise null. */
  resource: ResourceSnapshot | null;
};

export type ModelSupport = {
  /** After a successful list, the host replaces this channel's whole model catalog with the return value. */
  list(input: ModelListInput, context: ProviderContext): Promise<ModelDefinition[]>;
};

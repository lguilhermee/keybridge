import type { JsonValue, ProviderContext } from "./provider.ts";
import type { ResourceSnapshot } from "./resource.ts";

export type ModelCapabilities = {
  images?: boolean;
};

export type ModelDefinition = {
  id: string;
  displayName: string;
  description?: string;
  maxOutputTokens?: number;
  capabilities?: ModelCapabilities;
  /** Passed back verbatim on later calls; never shown to the user. */
  privateData?: JsonValue;
};

/** One model persisted in the host catalog. */
export type ModelSnapshot = ModelDefinition;

export type ModelListInput = {
  /** The first usable resource when discovery needs auth, otherwise null. */
  resource: ResourceSnapshot | null;
};

export type ModelSupport = {
  /** After a successful list, the host replaces this channel's whole model catalog with the return value. */
  list(input: ModelListInput, context: ProviderContext): Promise<ModelDefinition[]>;
};

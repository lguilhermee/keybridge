import type { ChannelSupport } from "./channel.ts";
import type { ResourceSupport } from "./resource.ts";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/**
 * Localizable text: a plain string or a locale -> text map.
 * (如 { "zh-CN": "账号", "en-US": "Accounts" })。
 * The host passes it through and the UI resolves it for the current language; upstream-sourced data like model names stays a plain string.
 */
export type LocalizedText = string | { [locale: string]: string };

export type NetworkRequestInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Binary request body, encoded for transport through the sandbox boundary. */
  bodyBase64?: string;
};

export type NetworkResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

/** Streaming response body delivered line by line as it arrives (for SSE). */
export type NetworkEventStream = {
  status: number;
  headers: Record<string, string>;
  lines: AsyncIterable<string>;
};

/** Raw response chunks for framed protocols such as Connect RPC. */
export type NetworkBinaryStream = {
  status: number;
  headers: Record<string, string>;
  chunks: AsyncIterable<Uint8Array>;
};

/**
 * Host services handed to each capability call. Network requests are limited to the HTTPS hosts declared in provider.json;
 * the host aborts via `signal` when it cancels the call.
 */
export type ProviderContext = {
  network: {
    fetch(url: string, init?: NetworkRequestInit): Promise<NetworkResponse>;
    stream(url: string, init?: NetworkRequestInit): Promise<NetworkEventStream>;
    streamBytes(url: string, init?: NetworkRequestInit): Promise<NetworkBinaryStream>;
  };
  signal: AbortSignal;
};

/**
 * Provider definition: a set of capability implementations. Providers hold no persistent state -
 * resources and the model catalog are stored by the host, and everything a call needs arrives via parameters.
 */
export type ProviderDefinition = {
  channels: ChannelSupport[];
  resources?: ResourceSupport[];
};

let registered: ProviderDefinition | undefined;

/** Registers a provider; each provider entry may call it once. */
export function defineProvider(definition: ProviderDefinition): ProviderDefinition {
  if (registered) throw new Error("defineProvider can only be called once");
  registered = definition;
  return definition;
}

export function __getRegisteredProvider(): ProviderDefinition {
  if (!registered) throw new Error("provider entry must call defineProvider");
  return registered;
}

/** Serializable capability summary; the host collects it without invoking any capability method. */
export function __descriptor(definition: ProviderDefinition) {
  return {
    channels: definition.channels.map((channel) => ({
      id: channel.id,
      displayName: channel.displayName,
      description: channel.description ?? null,
      brand: channel.brand,
      resourceType: channel.resourceType ?? null,
      hasModels: channel.models !== undefined,
    })),
    resources: (definition.resources ?? []).map((resource) => ({
      type: resource.type,
      displayName: resource.displayName,
      add: (resource.add ?? []).map((method) => ({
        type: method.type,
        id: method.id,
        displayName: method.displayName,
        description: method.description ?? null,
        callback: method.type === "oauth2.authorization-code"
          ? {
            port: method.callback?.port ?? null,
            path: method.callback?.path ?? "/oauth-callback",
          }
          : null,
      })),
      import: resource.import
        ? {
          displayName: resource.import.displayName,
          description: resource.import.description ?? null,
          accept: resource.import.accept,
          multiple: resource.import.multiple ?? false,
          helpUrl: resource.import.helpUrl ?? null,
        }
        : null,
      actions: (resource.actions ?? []).map((action) => ({
        id: action.id,
        displayName: action.displayName,
        description: action.description ?? null,
        target: action.target ?? "resource",
        destructive: action.destructive ?? false,
      })),
      canRefresh: resource.refresh !== undefined,
      canRemove: resource.remove !== undefined,
    })),
  };
}

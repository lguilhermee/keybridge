import type { JsonValue, LocalizedText, PluginContext } from "./plugin.ts";

/**
 * A resource is a plugin-defined private record (usually an upstream account) consumed by the Provider.
 * The host owns persistence, listing, and per-call resource selection; the plugin only creates, projects, and interprets resources.
 */
export type ResourceState =
  | { status: "ready" }
  | { status: "cooling"; retryAtMs?: number; message?: string }
  | { status: "invalid"; message?: string };

/** A new resource produced by an add flow or an import. */
export type ResourceDraft = {
  /** Dedupe key: the host upserts by (resource type, key). */
  key: string;
  /** Credentials and plugin-private fields; never shown to the user. */
  privateData: JsonValue;
  /** Defaults to ready. */
  state?: ResourceState;
};

/** One resource persisted by the host. */
export type ResourceSnapshot = {
  /** Host-assigned identifier, distinct from the plugin's dedupe key. */
  id: string;
  type: string;
  key: string;
  privateData: JsonValue;
  state: ResourceState;
};

/** A partial update the host applies atomically to one resource. */
export type ResourcePatch = {
  privateData?: JsonValue;
  state?: ResourceState;
};

export type ResourceMetric = {
  id: string;
  label: LocalizedText;
  unit: "percent" | "count";
  /** A percent metric expresses the remaining fraction, 0..100. */
  value: number;
  resetAtMs?: number;
};

export type ResourceActionTarget = "resource" | "card";

export type ResourceAction = {
  id: string;
  displayName: LocalizedText;
  description?: LocalizedText;
  target?: ResourceActionTarget;
  destructive?: boolean;
  run(
    resource: ResourceSnapshot,
    input: JsonValue,
    context: PluginContext,
  ): Promise<ResourceActionResult>;
};

export type ResourceActionField = {
  id: string;
  label: LocalizedText;
  value: string;
};

/** Generic detail card returned by a resource operation; must not contain credentials. */
export type ResourceActionCard = {
  id: string;
  title: LocalizedText;
  status?: LocalizedText;
  grantedAtMs?: number;
  expiresAtMs?: number;
  fields?: ResourceActionField[];
};

export type ResourceActionResult = {
  title: LocalizedText;
  description?: LocalizedText;
  cards?: ResourceActionCard[];
  /** Consume-type operations may use it to update the resource state the host keeps. */
  patch?: ResourcePatch;
};

/** User-visible projection of one resource; must not leak credentials. displayName is data (like an email) and stays a plain string. */
export type ResourceView = {
  displayName: string;
  description?: LocalizedText;
  metrics?: ResourceMetric[];
};

/**
 * OAuth 2.0 device-code add flow. The host renders the UI, drives the polling loop
 * (interval, slow-down backoff, timeout), and keeps `session` in memory for the
 * flow's lifetime; the plugin only implements the two HTTP state transitions.
 */
export type OAuth2AddMethod = {
  type: "oauth2.0";
  id: string;
  displayName: LocalizedText;
  description?: LocalizedText;
  begin(context: PluginContext): Promise<OAuth2Begin>;
  poll(session: JsonValue, context: PluginContext): Promise<OAuth2Poll>;
};

export type OAuth2Begin = {
  /** Opaque flow state (e.g. the device code); never persisted. */
  session: JsonValue;
  userCode: string;
  verificationUrl: string;
  verificationUrlComplete?: string;
  expiresAtMs: number;
  pollIntervalMs: number;
};

export type OAuth2Poll =
  | { status: "pending"; session?: JsonValue }
  | { status: "slow-down"; session?: JsonValue }
  | { status: "completed"; resources: ResourceDraft[] }
  | { status: "denied"; message?: string }
  | { status: "failed"; message: string };

/** OAuth 2.0 authorization-code flow where Core hosts the browser callback, state, and PKCE. */
export type OAuth2AuthorizationCodeAddMethod = {
  type: "oauth2.authorization-code";
  id: string;
  displayName: LocalizedText;
  description?: LocalizedText;
  /** Set only when the upstream OAuth client requires a fixed loopback address. */
  callback?: { port?: number; path?: string };
  begin(
    input: {
      redirectUri: string;
      state: string;
      codeChallenge: string;
    },
    context: PluginContext,
  ): Promise<OAuth2AuthorizationCodeBegin>;
  complete(
    session: JsonValue,
    input: {
      code: string;
      redirectUri: string;
      codeVerifier: string;
    },
    context: PluginContext,
  ): Promise<ResourceDraft[]>;
};

export type OAuth2AuthorizationCodeBegin = {
  session: JsonValue;
  authorizationUrl: string;
  expiresAtMs: number;
  pollIntervalMs?: number;
};

export type ResourceAddMethod = OAuth2AddMethod | OAuth2AuthorizationCodeAddMethod;

export type ResourceImportFile = {
  name: string;
  /** Raw file content; parsing and validation are the plugin's job. */
  content: string;
};

export type ResourceImportSupport = {
  displayName: LocalizedText;
  description?: LocalizedText;
  /** Extensions the host's file picker accepts, e.g. [".json"]. */
  accept: string[];
  multiple?: boolean;
  /** Optional web URL; the host shows a "Get key" button that opens it in a browser. */
  helpUrl?: string;
  parse(files: ResourceImportFile[], context: PluginContext): Promise<ResourceImportResult>;
};

export type ResourceImportResult = {
  resources: ResourceDraft[];
  /** A per-file problem worth surfacing without failing the whole import. */
  warnings?: string[];
};

export type ResourceSupport = {
  type: string;
  displayName: LocalizedText;
  add?: ResourceAddMethod[];
  import?: ResourceImportSupport;
  present(resource: ResourceSnapshot): ResourceView;
  actions?: ResourceAction[];
  /** Re-reads upstream state (quota, credential validity) when the user explicitly triggers it. */
  refresh?(resource: ResourceSnapshot, context: PluginContext): Promise<ResourcePatch>;
  /** Optional upstream revoke; the host deletes the local record afterwards. */
  remove?(resource: ResourceSnapshot, context: PluginContext): Promise<void>;
};

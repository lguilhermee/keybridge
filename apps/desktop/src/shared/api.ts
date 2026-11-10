import type { CommitPromptLocale, Locale } from "../i18n/runtime";

export type ModelType = "openai" | "anthropic";

export interface Model {
  model_hash: string;
  sort_order: number;
  display_name: string;
  group_name: string | null;
  type: ModelType;
  base_url: string;
  use_full_url: boolean;
  api_key: string;
  tooltip_data: string;
  model_id: string;
  reasoning_effort: string | null;
  openai_endpoint: string;
  openai_extra_params_enabled: boolean;
  openai_extra_params: Record<string, unknown>;
  custom_headers_enabled: boolean;
  custom_headers: Record<string, string>;
  anthropic_extra_params_enabled: boolean;
  anthropic_extra_params: Record<string, unknown>;
  context_window_tokens: number | null;
  max_completion_tokens: number | null;
  anthropic_max_tokens: number | null;
  anthropic_thinking_effort: string | null;
  thinking_budget_tokens: number | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface ModelInput {
  sort_order: number;
  display_name: string;
  group_name: string | null;
  type: ModelType;
  base_url: string;
  use_full_url: boolean;
  api_key: string;
  tooltip_data: string;
  model_id: string;
  reasoning_effort: string | null;
  openai_endpoint: string;
  openai_extra_params_enabled: boolean;
  openai_extra_params: Record<string, unknown>;
  custom_headers_enabled: boolean;
  custom_headers: Record<string, string>;
  anthropic_extra_params_enabled: boolean;
  anthropic_extra_params: Record<string, unknown>;
  context_window_tokens: number | null;
  max_completion_tokens: number | null;
  anthropic_max_tokens: number | null;
  anthropic_thinking_effort: string | null;
  thinking_budget_tokens: number | null;
}

/** How a combo picks the member that answers first; later members are fallbacks. */
export type ComboStrategy = "ordered" | "loop" | "random";

/** One Cursor model name backed by several configured models (API-key model hashes or provider model ids). */
export interface Combo {
  combo_id: string;
  sort_order: number;
  display_name: string;
  strategy: ComboStrategy;
  members: string[];
  created_at_ms: number;
  updated_at_ms: number;
}

/** When `model_id` refuses, that request and the rest of its run go to `fallback_model_id`. */
export interface RefusalFallback {
  model_id: string;
  fallback_model_id: string;
}

export interface RefusalFallbackInput {
  model_id: string;
  /** `null` turns the fallback off. */
  fallback_model_id: string | null;
}

export interface ComboInput {
  display_name: string;
  strategy: ComboStrategy;
  members: string[];
}

export interface ModelDiscoveryInput {
  type: ModelType;
  base_url: string;
  api_key: string;
  custom_headers_enabled: boolean;
  custom_headers: Record<string, string>;
}

export interface LegacyModelImportPreviewItem {
  model_hash: string;
  display_name: string;
  model_id: string;
  type: ModelType;
  existing: boolean;
}

export interface LegacyModelImportPreview {
  source: string;
  total: number;
  new_models: number;
  existing_models: number;
  models: LegacyModelImportPreviewItem[];
}

export interface LegacyModelImportResult {
  imported: number;
  skipped: number;
  total: number;
}

export interface ModelConnectivityResult {
  duration_ms: number;
  first_valid_response_ms: number | null;
  output_tokens: number;
  tokens_per_second: number;
  tokens_estimated: boolean;
  output: string;
}

export type CaState = "missing" | "untrusted" | "ready" | "invalid";
export type IntegrationState = "disabled" | "enabled" | "degraded";
export interface CursorHarnessStatus {
  platform: string;
  ca: CaState;
  configured_models: number;
  enabled_models: number;
  integration: IntegrationState;
  settings_applied: boolean;
  proxy_url: string | null;
  ca_install_command: string | null;
}

export interface CodexHarnessStatus {
  integration: IntegrationState;
  installed: boolean;
  config_path: string;
  configured_models: number;
  model: string | null;
}

export interface PortSettings {
  proxy_port: number;
  service_port: number;
}

export interface ExternalApiSettings {
  enabled: boolean;
  api_key: string;
}

export interface HeadroomSettings {
  enabled: boolean;
  port: number;
}

export interface HeadroomStatus {
  enabled: boolean;
  port: number;
  state: "disabled" | "not_installed" | "running" | "starting" | "failed";
  detail: string | null;
  installing: boolean;
}

export interface StatisticsStorage {
  call_count: number;
  trace_count: number;
}

export type StatisticsStorageScope = "details" | "all";

export type ProxyMode = "default" | "custom";

export interface ProxySettings {
  mode: ProxyMode;
  address: string;
  auth_enabled: boolean;
  username: string;
  has_password: boolean;
}

export interface ProxySettingsInput {
  mode: ProxyMode;
  address: string;
  auth_enabled: boolean;
  username: string;
  password?: string;
}

export type TabMode = "public" | "direct" | "custom";

export interface TabSettings {
  mode: TabMode;
  address: string;
}

export interface DesktopSettings {
  silent_start: boolean;
  show_dock_icon: boolean;
}

export interface CommitSettings {
  model_id: string;
  prompt: string;
  prompt_locale: CommitPromptLocale;
}

export interface CommitSettingsView extends CommitSettings {
  default_prompt: string;
}

/** Optional per-model price overrides; each field falls back to the global price when absent. */
export interface ModelTokenPricing {
  input_per_million?: number;
  output_per_million?: number;
  cache_read_per_million?: number;
  cache_write_per_million?: number;
}

export interface TokenPricingSettings {
  input_per_million: number;
  output_per_million: number;
  cache_read_per_million: number;
  cache_write_per_million: number;
  /** Per-model overrides keyed by the upstream `model_id`. */
  model_prices: Record<string, ModelTokenPricing>;
}

/** The prices that apply to one model: its overrides where set, global values otherwise. */
export function pricingForModel(pricing: TokenPricingSettings, modelId: string) {
  const custom = pricing.model_prices[modelId];
  return {
    input: custom?.input_per_million ?? pricing.input_per_million,
    output: custom?.output_per_million ?? pricing.output_per_million,
    cacheRead: custom?.cache_read_per_million ?? pricing.cache_read_per_million,
    cacheWrite: custom?.cache_write_per_million ?? pricing.cache_write_per_million,
  };
}

export type ProviderRuntimeState = "uninitialized" | "initializing" | "ready" | "failed" | "unsupported";
export type ProviderRuntimePhase = "checking" | "downloading" | "verifying" | "installing" | "validating";

export interface ProviderRuntimeStatus {
  state: ProviderRuntimeState;
  version: string;
  target: string | null;
  phase: ProviderRuntimePhase | null;
  downloaded_bytes: number;
  total_bytes: number | null;
  error: string | null;
}

/** Display text provided by a provider: a plain string or a locale -> text map. */
export type ProviderLocalizedText = string | Record<string, string>;

export function providerText(value: ProviderLocalizedText | null | undefined, locale: string): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (value[locale]) return value[locale];
  const language = locale.split("-")[0].toLowerCase();
  for (const [key, text] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if (normalized === language || normalized.startsWith(`${language}-`)) return text;
  }
  return value["en-US"] ?? value["en"] ?? Object.values(value)[0] ?? "";
}

export interface ProviderResourceState {
  status: "ready" | "cooling" | "invalid";
  retryAtMs?: number | null;
  message?: string | null;
}

export interface ProviderResourceMetric {
  id: string;
  label: ProviderLocalizedText;
  unit: "percent" | "count";
  value: number;
  resetAtMs?: number | null;
}

export interface ProviderResourceView {
  id: string;
  state: ProviderResourceState;
  displayName: string;
  description: ProviderLocalizedText | null;
  metrics: ProviderResourceMetric[];
  createdAtMs: number;
}

export interface ProviderAddMethod {
  type: "oauth2.0" | "oauth2.authorization-code";
  id: string;
  displayName: ProviderLocalizedText;
  description: ProviderLocalizedText | null;
  callback?: { port: number | null; path: string | null };
}

export interface ProviderImportDescriptor {
  displayName: ProviderLocalizedText;
  description: ProviderLocalizedText | null;
  accept: string[];
  multiple: boolean;
  helpUrl: string | null;
}

export interface ProviderResourceAction {
  id: string;
  displayName: ProviderLocalizedText;
  description: ProviderLocalizedText | null;
  target: "resource" | "card";
  destructive: boolean;
}

export interface ProviderResourceActionField {
  id: string;
  label: ProviderLocalizedText;
  value: string;
}

export interface ProviderResourceActionCard {
  id: string;
  title: ProviderLocalizedText;
  status: ProviderLocalizedText | null;
  grantedAtMs: number | null;
  expiresAtMs: number | null;
  fields: ProviderResourceActionField[];
}

export interface ProviderResourceActionResult {
  title: ProviderLocalizedText;
  description: ProviderLocalizedText | null;
  cards: ProviderResourceActionCard[];
}

export interface ProviderResourceDescriptor {
  type: string;
  displayName: ProviderLocalizedText;
  add: ProviderAddMethod[];
  import: ProviderImportDescriptor | null;
  canRefresh: boolean;
  canRemove: boolean;
  actions: ProviderResourceAction[];
  resources: ProviderResourceView[];
}

export interface ProviderModelDescriptor {
  id: string;
  providerId: string;
  providerName: string;
  channelId: string;
  modelId: string;
  displayName: string;
  description: string | null;
  icon: string;
  brand: string;
  maxOutputTokens: number | null;
  /** Total prompt window in tokens; null when unknown — the UI hides the context meter. */
  contextWindow: number | null;
  images: boolean;
  enabled: boolean;
}

export interface ChannelDescriptor {
  id: string;
  providerId: string;
  displayName: ProviderLocalizedText;
  description: ProviderLocalizedText | null;
  brand: string;
  resourceType: string | null;
  hasModels: boolean;
  configured: boolean;
  models: ProviderModelDescriptor[];
}

export interface ProviderDescriptor {
  id: string;
  name: string;
  version: string;
  author: string | null;
  icon: string;
  channels: ChannelDescriptor[];
  resources: ProviderResourceDescriptor[];
}

export interface ProviderOAuthBegin {
  sessionId: string;
  userCode: string | null;
  verificationUrl: string;
  verificationUrlComplete: string | null;
  expiresAtMs: number;
  pollIntervalMs: number;
}

export type ProviderOAuthPoll =
  | { status: "pending"; pollIntervalMs: number }
  | { status: "completed"; added: number; updated: number; modelSyncError: string | null }
  | { status: "denied"; message: string | null }
  | { status: "failed"; message: string };

export interface ProviderImportFile {
  name: string;
  content: string;
}

export interface ProviderImportResult {
  added: number;
  updated: number;
  warnings: string[];
  modelSyncError: string | null;
}

export function configuredProviderModels(providers: ProviderDescriptor[]): ProviderModelDescriptor[] {
  return providers.flatMap((provider) =>
    provider.channels.flatMap((channel) => channel.configured ? channel.models.filter((model) => model.enabled) : []));
}

export interface OverviewMetrics {
  llm_calls: number;
  successful_calls: number;
  failed_calls: number;
  token_usage: number;
  prompt_tokens: number;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  /** Estimated cost in USD over the filtered range using configured token pricing. */
  cost: number;
}

export type TokenUsageGranularity = "minute" | "hour" | "day";

export interface OverviewTokenUsageBucket {
  bucket_start_ms: number;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
}

/** Token, call, and cost aggregates for one upstream model ID over the filtered range. */
export interface OverviewModelUsage {
  model_id: string;
  display_name: string;
  calls: number;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  cost: number;
}

export interface Overview {
  metrics: OverviewMetrics;
  token_usage_granularity: TokenUsageGranularity;
  token_usage_series: OverviewTokenUsageBucket[];
  /** Per-model breakdown over the same filters as the headline metrics. */
  by_model: OverviewModelUsage[];
}

/** Token usage reported by the provider, nested under `usage` on a call summary. */
export interface LlmCallUsage {
  input_tokens: number | null;
  /** Full prompt size: input tokens plus cache read plus cache write. */
  context_input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
}

export interface LlmCall {
  call_kind: "provider_llm" | "cursor_official";
  route: "local_byok" | "cursor_official";
  call_id: string;
  run_id: string;
  conversation_id: string;
  provider_call_index: number;
  model_hash: string | null;
  protocol_type: string;
  endpoint_url: string;
  model_id: string;
  display_name: string;
  reasoning_effort: string | null;
  fast: boolean | null;
  status: string;
  finish_reason: string | null;
  created_at_ms: number;
  ttfb_ms: number | null;
  ttft_ms: number | null;
  ttfr_ms: number | null;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
  /** Live estimate of generated output tokens while the call runs; superseded by `output_tokens`. */
  estimated_output_tokens: number | null;
  /** True when the shown output count is an estimate (still running, or usage never reported). */
  output_estimated: boolean;
  usage: LlmCallUsage | null;
  message_count: number;
  tool_count: number;
  http_status: number | null;
  error_kind: string | null;
  error_message: string | null;
  detailed: boolean;
}

/** Server-side filtering and paging for `/llm-calls`. */
export interface CallQuery {
  /** `running`, `completed` (alias `success`), `error` (alias `failed`), `cancelled`. */
  status?: string;
  /** Stored `model_hash` or upstream `model_id`. */
  model?: string;
  /** Case-insensitive substring over model/display/conversation/call/endpoint/error fields. */
  q?: string;
  offset?: number;
  limit?: number;
}

export interface CallPage {
  calls: LlmCall[];
  /** Total rows matching the filters (provider calls plus official Cursor traces). */
  total: number;
}

export interface CallDetail {
  call: LlmCall;
  request: { headers: unknown; body: unknown; byte_count: number } | null;
  response_chunks: Array<{ seq: number; received_offset_ms: number; data: string; byte_count: number }>;
  cursor_trace: {
    trace: {
      request_id: string;
      conversation_id: string | null;
      route: "local_byok" | "cursor_official";
      model_id: string | null;
      status: string;
      request_bytes: number;
      response_bytes: number;
      response_event_count: number;
      http_status: number | null;
      received_at_ms: number;
      first_response_at_ms: number | null;
      finished_at_ms: number | null;
      error_message: string | null;
    };
    artifacts: Array<{
      seq: number;
      artifact_type: string;
      source: string;
      metadata: unknown;
      created_at_ms: number;
      byte_count: number;
      encoding: "utf8" | "base64";
      data: string;
    }>;
  } | null;
}

const packagedDesktop = "__TAURI_INTERNALS__" in window
  || window.location.protocol === "tauri:"
  || window.location.hostname === "tauri.localhost";
const API_ROOT = "/__byok-api__/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_ROOT}${path}`, {
      ...init,
      headers: init?.body ? { "content-type": "application/json", ...init.headers } : init?.headers,
    });
  } catch (cause) {
    throw new Error(t("Unable to connect to the local management service"), { cause });
  }
  if (!response.ok) {
    const body = await response.text();
    let message = body;
    try {
      const parsed = JSON.parse(body) as { message?: unknown };
      if (typeof parsed.message === "string") message = parsed.message;
    } catch {
      // Plain-text errors are already suitable for display.
    }
    throw new Error(message || `${response.status} ${response.statusText}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  models: () => request<Model[]>("/models"),
  createModels: (models: ModelInput[]) => request<Model[]>("/models", { method: "POST", body: JSON.stringify({ models }) }),
  reorderModels: (modelHashes: string[]) => request<Model[]>("/models/order", { method: "PUT", body: JSON.stringify({ model_hashes: modelHashes }) }),
  discoverModels: (input: ModelDiscoveryInput) => request<{ models: string[] }>("/models/discover", { method: "POST", body: JSON.stringify(input) }),
  previewV0049Models: () => request<LegacyModelImportPreview>("/models/import-v0049"),
  importV0049Models: () => request<LegacyModelImportResult>("/models/import-v0049", { method: "POST" }),
  updateModel: (hash: string, model: ModelInput) => request<Model>(`/models/${hash}`, { method: "PUT", body: JSON.stringify(model) }),
  deleteModels: (modelHashes: string[]) => request<void>("/models", { method: "DELETE", body: JSON.stringify({ model_hashes: modelHashes }) }),
  combos: () => request<Combo[]>("/combos"),
  refusalFallbacks: () => request<RefusalFallback[]>("/refusal-fallbacks"),
  setRefusalFallback: (input: RefusalFallbackInput) => request<void>("/refusal-fallbacks", { method: "PUT", body: JSON.stringify(input) }),
  createCombo: (combo: ComboInput) => request<Combo>("/combos", { method: "POST", body: JSON.stringify(combo) }),
  updateCombo: (comboId: string, combo: ComboInput) => request<Combo>(`/combos/${encodeURIComponent(comboId)}`, { method: "PUT", body: JSON.stringify(combo) }),
  deleteCombo: (comboId: string) => request<void>(`/combos/${encodeURIComponent(comboId)}`, { method: "DELETE" }),
  testModel: (hash: string, testId: string, signal?: AbortSignal) => request<ModelConnectivityResult>(`/models/${encodeURIComponent(hash)}/test/${encodeURIComponent(testId)}`, { method: "POST", signal }),
  cancelModelTest: (hash: string, testId: string) => request<void>(`/models/${encodeURIComponent(hash)}/test/${encodeURIComponent(testId)}`, { method: "DELETE" }),
  overview: (filter?: { startMs: number; endMs: number; modelHashes?: string[]; bucketMs?: number }) => {
    const params = new URLSearchParams({ utc_offset_minutes: String(-new Date().getTimezoneOffset()) });
    if (filter) {
      params.set("start_ms", String(filter.startMs));
      params.set("end_ms", String(filter.endMs));
      if (filter.modelHashes?.length) params.set("model_hashes", JSON.stringify(filter.modelHashes));
      if (filter.bucketMs) params.set("bucket_ms", String(filter.bucketMs));
    }
    return request<Overview>(`/overview?${params.toString()}`);
  },
  cursorHarness: () => request<CursorHarnessStatus>("/harness/cursor/status"),
  initializeCursorCa: () => request<CursorHarnessStatus>("/harness/cursor/ca/initialize", { method: "POST" }),
  providers: () => request<ProviderDescriptor[]>("/providers"),
  providerOAuthBegin: (providerId: string, resourceType: string, methodId: string) => request<ProviderOAuthBegin>(`/providers/${encodeURIComponent(providerId)}/resources/${encodeURIComponent(resourceType)}/add/${encodeURIComponent(methodId)}/begin`, { method: "POST" }),
  providerOAuthPoll: (sessionId: string, signal?: AbortSignal) => request<ProviderOAuthPoll>(`/providers/oauth/${encodeURIComponent(sessionId)}/poll`, { method: "POST", signal }),
  importProviderResources: (providerId: string, resourceType: string, files: ProviderImportFile[]) => request<ProviderImportResult>(`/providers/${encodeURIComponent(providerId)}/resources/${encodeURIComponent(resourceType)}/import`, { method: "POST", body: JSON.stringify(files) }),
  refreshProviderResource: (providerId: string, resourceType: string, resourceId: string) => request<void>(`/providers/${encodeURIComponent(providerId)}/resources/${encodeURIComponent(resourceType)}/${encodeURIComponent(resourceId)}/refresh`, { method: "POST" }),
  providerResourceAction: (providerId: string, resourceType: string, resourceId: string, actionId: string, input: unknown = {}) => request<ProviderResourceActionResult>(`/providers/${encodeURIComponent(providerId)}/resources/${encodeURIComponent(resourceType)}/${encodeURIComponent(resourceId)}/actions/${encodeURIComponent(actionId)}`, { method: "POST", body: JSON.stringify(input) }),
  deleteProviderResource: (providerId: string, resourceType: string, resourceId: string) => request<void>(`/providers/${encodeURIComponent(providerId)}/resources/${encodeURIComponent(resourceType)}/${encodeURIComponent(resourceId)}`, { method: "DELETE" }),
  syncChannelModels: (providerId: string, channelId: string) => request<{ models: number }>(`/providers/${encodeURIComponent(providerId)}/channels/${encodeURIComponent(channelId)}/models/sync`, { method: "POST" }),
  setChannelModelEnabled: (providerId: string, channelId: string, modelId: string, enabled: boolean) => request<void>(`/providers/${encodeURIComponent(providerId)}/channels/${encodeURIComponent(channelId)}/models/enabled`, { method: "PUT", body: JSON.stringify({ modelId, enabled }) }),
  providerResourceExportUrl: (servicePort: number, providerId: string, resourceType: string) => `http://127.0.0.1:${servicePort}${API_ROOT}/providers/${encodeURIComponent(providerId)}/resources/${encodeURIComponent(resourceType)}/export`,
  removeProviderConfiguration: (providerId: string) => request<void>(`/providers/${encodeURIComponent(providerId)}`, { method: "DELETE" }),
  providerRuntime: () => request<ProviderRuntimeStatus>("/providers/runtime"),
  initializeProviderRuntime: () => request<ProviderRuntimeStatus>("/providers/runtime", { method: "POST" }),
  cancelProviderRuntimeInitialization: () => request<ProviderRuntimeStatus>("/providers/runtime", { method: "DELETE" }),
  openCursorCaInstallTerminal: async (command: string) => {
    if (!packagedDesktop) throw new Error(t("Open a terminal from the desktop app to install the CA"));
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_terminal_with_command", { command });
  },
  copyCursorText: async (text: string) => {
    if (!packagedDesktop) throw new Error(t("Use the desktop app to copy to the system clipboard"));
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(text);
  },
  setCursorEnabled: (enabled: boolean) => request<CursorHarnessStatus>("/harness/cursor/enabled", { method: "PUT", body: JSON.stringify({ enabled }) }),
  codexHarness: () => request<CodexHarnessStatus>("/harness/codex/status"),
  setCodexEnabled: (enabled: boolean) => request<CodexHarnessStatus>("/harness/codex/enabled", { method: "PUT", body: JSON.stringify({ enabled }) }),
  calls: (query: CallQuery = {}) => {
    const params = new URLSearchParams();
    if (query.status) params.set("status", query.status);
    if (query.model) params.set("model", query.model);
    if (query.q) params.set("q", query.q);
    if (query.offset) params.set("offset", String(query.offset));
    if (query.limit) params.set("limit", String(query.limit));
    const suffix = params.toString();
    return request<CallPage>(`/llm-calls${suffix ? `?${suffix}` : ""}`);
  },
  call: (id: string) => request<CallDetail>(`/llm-calls/${encodeURIComponent(id)}`),
  openCallDetails: async (id: string) => {
    const url = new URL(window.location.href);
    url.hash = `/calls/${encodeURIComponent(id)}`;
    await request<void>("/desktop/open-external-url", { method: "POST", body: JSON.stringify({ url: url.toString() }) });
  },
  openExternalUrl: (url: string) => request<void>("/desktop/open-external-url", { method: "POST", body: JSON.stringify({ url }) }),
  observability: () => request<{ detailed: boolean }>("/settings/observability"),
  setObservability: (detailed: boolean) => request<{ detailed: boolean }>("/settings/observability", { method: "PUT", body: JSON.stringify({ detailed }) }),
  ports: () => request<PortSettings>("/settings/ports"),
  setPorts: (settings: PortSettings) => request<PortSettings>("/settings/ports", { method: "PUT", body: JSON.stringify(settings) }),
  externalApiSettings: () => request<ExternalApiSettings>("/settings/external-api"),
  setExternalApiSettings: (settings: ExternalApiSettings) => request<ExternalApiSettings>("/settings/external-api", { method: "PUT", body: JSON.stringify(settings) }),
  headroomSettings: () => request<HeadroomStatus>("/settings/headroom"),
  setHeadroomSettings: (settings: HeadroomSettings) => request<HeadroomStatus>("/settings/headroom", { method: "PUT", body: JSON.stringify(settings) }),
  installHeadroom: () => request<HeadroomStatus>("/settings/headroom/install", { method: "POST" }),
  statisticsStorage: () => request<StatisticsStorage>("/settings/storage/statistics"),
  clearStatisticsStorage: (scope: StatisticsStorageScope) => request<StatisticsStorage>("/settings/storage/statistics", { method: "DELETE", body: JSON.stringify({ scope }) }),
  proxySettings: () => request<ProxySettings>("/settings/proxy"),
  setProxySettings: (settings: ProxySettingsInput) => request<ProxySettings>("/settings/proxy", { method: "PUT", body: JSON.stringify(settings) }),
  tabSettings: () => request<TabSettings>("/settings/tab"),
  setTabSettings: (settings: TabSettings) => request<TabSettings>("/settings/tab", { method: "PUT", body: JSON.stringify(settings) }),
  desktopSettings: () => request<DesktopSettings>("/settings/desktop"),
  setDesktopSettings: (settings: DesktopSettings) => request<DesktopSettings>("/settings/desktop", { method: "PUT", body: JSON.stringify(settings) }),
  commitSettings: (locale: Locale) => request<CommitSettingsView>("/settings/commit", { headers: { "accept-language": locale } }),
  setCommitSettings: (settings: CommitSettings) => request<CommitSettingsView>("/settings/commit", { method: "PUT", body: JSON.stringify(settings) }),
  pricingSettings: () => request<TokenPricingSettings>("/settings/pricing"),
  setPricingSettings: (settings: TokenPricingSettings) => request<TokenPricingSettings>("/settings/pricing", { method: "PUT", body: JSON.stringify(settings) }),
};

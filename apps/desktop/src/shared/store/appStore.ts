import { useSyncExternalStore } from "react";
import { api, type CodexHarnessStatus, type Combo, type ComboInput, type CursorHarnessStatus, type Model, type ModelInput, type Overview, type ProviderDescriptor, type ProviderRuntimeStatus, type PortSettings, type RefusalFallback, type TokenPricingSettings } from "../api";
import { applyTheme, isThemeId, type ThemeId } from "../theme/theme";

export const DEFAULT_TOKEN_PRICING: TokenPricingSettings = {
  input_per_million: 5.0,
  output_per_million: 25.0,
  cache_read_per_million: 0.5,
  cache_write_per_million: 6.25,
  model_prices: {},
};

export type AppSnapshot = {
  models: Model[];
  combos: Combo[];
  refusalFallbacks: RefusalFallback[];
  overview: Overview;
  detailed: boolean;
  ports: PortSettings;
  pricing: TokenPricingSettings;
  busy: boolean;
  error: string | null;
  theme: ThemeId;
  cursorHarness: CursorHarnessStatus | null;
  cursorBusy: boolean;
  codexHarness: CodexHarnessStatus | null;
  codexBusy: boolean;
  providerRuntime: ProviderRuntimeStatus | null;
  providers: ProviderDescriptor[];
};

const savedTheme = (): ThemeId => {
  const saved = localStorage.getItem("cursor-byok.theme");
  return isThemeId(saved) ? saved : "default-dark";
};

let snapshot: AppSnapshot = {
  models: [],
  combos: [],
  refusalFallbacks: [],
  overview: {
    metrics: {
      llm_calls: 0,
      successful_calls: 0,
      failed_calls: 0,
      token_usage: 0,
      prompt_tokens: 0,
      input_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      output_tokens: 0,
      cost: 0,
    },
    token_usage_granularity: "day",
    token_usage_series: [],
    by_model: [],
  },
  detailed: false,
  ports: { proxy_port: 0, service_port: 0 },
  pricing: DEFAULT_TOKEN_PRICING,
  busy: false,
  error: null,
  theme: savedTheme(),
  cursorHarness: null,
  cursorBusy: false,
  codexHarness: null,
  codexBusy: false,
  providerRuntime: null,
  providers: [],
};

const listeners = new Set<() => void>();

function update(patch: Partial<AppSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((listener) => listener());
}

async function perform(task: () => Promise<void>) {
  update({ error: null });
  try {
    await task();
  } catch (cause) {
    update({ error: cause instanceof Error ? cause.message : String(cause) });
  }
}

export const appStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot: () => snapshot,

  async refresh() {
    update({ busy: true, error: null });
    try {
      const [models, combos, refusalFallbacks, overview, settings, ports, pricing, cursorHarness, codexHarness, providerRuntime, providers] = await Promise.all([
        api.models(),
        api.combos(),
        api.refusalFallbacks(),
        api.overview(),
        api.observability(),
        api.ports(),
        api.pricingSettings(),
        api.cursorHarness(),
        api.codexHarness(),
        api.providerRuntime(),
        api.providers(),
      ]);
      update({ models, combos, refusalFallbacks, overview, detailed: settings.detailed, ports, pricing, cursorHarness, codexHarness, providerRuntime, providers });
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      update({ busy: false });
    }
  },

  async deleteModels(modelHashes: string[]) {
    update({ cursorBusy: true, error: null });
    try {
      await api.deleteModels(modelHashes);
      await appStore.refresh();
      return true;
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
      return false;
    } finally { update({ cursorBusy: false }); }
  },
  async saveCombo(comboId: string | null, combo: ComboInput) {
    update({ cursorBusy: true, error: null });
    try {
      const saved = comboId ? await api.updateCombo(comboId, combo) : await api.createCombo(combo);
      await appStore.refresh();
      return saved;
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
      return null;
    } finally { update({ cursorBusy: false }); }
  },
  async deleteCombo(comboId: string) {
    update({ cursorBusy: true, error: null });
    try {
      await api.deleteCombo(comboId);
      await appStore.refresh();
      return true;
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
      return false;
    } finally { update({ cursorBusy: false }); }
  },
  async saveRefusalFallbacks(fallbacks: RefusalFallback[]) {
    const saved = await api.setRefusalFallbacks(fallbacks);
    update({ refusalFallbacks: saved });
    return saved;
  },

  async initializeCursorCa() {
    update({ cursorBusy: true, error: null });
    try {
      const status = await api.initializeCursorCa();
      update({ cursorHarness: status });
      return status;
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
      return null;
    } finally { update({ cursorBusy: false }); }
  },
  async initializeProviderRuntime() {
    update({ error: null });
    try {
      const providerRuntime = await api.initializeProviderRuntime();
      update({ providerRuntime });
      return providerRuntime;
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
      return null;
    }
  },
  async refreshProviderRuntime() {
    try {
      const wasReady = snapshot.providerRuntime?.state === "ready";
      const providerRuntime = await api.providerRuntime();
      update({ providerRuntime });
      if (!wasReady && providerRuntime.state === "ready") {
        const providers = await api.providers();
        update({ providers });
      }
      return providerRuntime;
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
      return null;
    }
  },
  async cancelProviderRuntimeInitialization() {
    try {
      const providerRuntime = await api.cancelProviderRuntimeInitialization();
      update({ providerRuntime });
      return providerRuntime;
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
      return null;
    }
  },
  async refreshProviders() {
    try {
      update({ providers: await api.providers() });
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
    }
  },
  async removeProviderConfiguration(providerId: string) {
    await perform(async () => {
      await api.removeProviderConfiguration(providerId);
      update({ providers: await api.providers() });
    });
  },
  async setCursorEnabled(enabled: boolean) {
    update({ cursorBusy: true, error: null });
    try { update({ cursorHarness: await api.setCursorEnabled(enabled) }); }
    catch (cause) { update({ error: cause instanceof Error ? cause.message : String(cause) }); }
    finally { update({ cursorBusy: false }); }
  },
  async setCodexEnabled(enabled: boolean) {
    update({ codexBusy: true, error: null });
    try { update({ codexHarness: await api.setCodexEnabled(enabled) }); }
    catch (cause) { update({ error: cause instanceof Error ? cause.message : String(cause) }); }
    finally { update({ codexBusy: false }); }
  },
  async createModels(models: ModelInput[]) {
    update({ cursorBusy: true, error: null });
    try {
      const created = await api.createModels(models);
      await appStore.refresh();
      return created;
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
      return null;
    } finally { update({ cursorBusy: false }); }
  },
  async importV0049Models() {
    update({ cursorBusy: true, error: null });
    try {
      const result = await api.importV0049Models();
      await appStore.refresh();
      return result;
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
      return null;
    } finally { update({ cursorBusy: false }); }
  },
  async updateCursorModel(hash: string, model: ModelInput) {
    update({ cursorBusy: true, error: null });
    try {
      const updated = await api.updateModel(hash, model);
      await appStore.refresh();
      return updated;
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
      return null;
    } finally { update({ cursorBusy: false }); }
  },
  async reorderCursorModels(modelHashes: string[]) {
    const previous = snapshot.models;
    const byHash = new Map(previous.map((model) => [model.model_hash, model]));
    if (modelHashes.length !== previous.length || new Set(modelHashes).size !== previous.length) {
      update({ error: t("The model configuration changed. Refresh and try again.") });
      return false;
    }
    const reordered: Model[] = [];
    for (const [index, hash] of modelHashes.entries()) {
      const model = byHash.get(hash);
      if (!model) {
        update({ error: t("The model configuration changed. Refresh and try again.") });
        return false;
      }
      reordered.push({ ...model, sort_order: index + 1 });
    }
    update({ models: reordered, cursorBusy: true, error: null });
    try {
      update({ models: await api.reorderModels(modelHashes) });
      return true;
    } catch (cause) {
      update({
        models: previous,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      return false;
    } finally {
      update({ cursorBusy: false });
    }
  },

  async openCallDetails(callId: string) {
    await perform(() => api.openCallDetails(callId));
  },
  async updateDetailed(detailed: boolean) {
    await perform(async () => update(await api.setObservability(detailed)));
  },
  async updatePorts(ports: PortSettings) {
    try {
      update({ error: null });
      update({ ports: await api.setPorts(ports) });
      return true;
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
      return false;
    }
  },
  async updatePricingSettings(pricing: TokenPricingSettings) {
    try {
      update({ error: null });
      update({ pricing: await api.setPricingSettings(pricing) });
      return true;
    } catch (cause) {
      update({ error: cause instanceof Error ? cause.message : String(cause) });
      return false;
    }
  },
  selectTheme(theme: ThemeId) {
    localStorage.setItem("cursor-byok.theme", theme);
    applyTheme(theme);
    update({ theme });
  },
};

export function useAppStore() {
  return useSyncExternalStore(appStore.subscribe, appStore.getSnapshot);
}

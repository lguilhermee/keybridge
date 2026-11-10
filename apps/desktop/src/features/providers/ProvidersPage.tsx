import type { IconifyIcon } from "@iconify/react/offline";
import { useEffect, useMemo, useRef, useState } from "react";
import { configuredProviderModels, type Combo, type Model, type ProviderDescriptor } from "../../shared/api";
import { appStore, useAppStore } from "../../shared/store/appStore";
import { Button } from "../../shared/ui/Button";
import controls from "../../shared/ui/Controls.module.scss";
import { Icon } from "../../shared/ui/Icon";
import { Modal } from "../../shared/ui/Modal";
import { claudeIcon, flatColorComboChartIcon, flatColorOrganizationIcon, openAiIcon, providerIcon } from "../../shared/ui/icons";
import { VirtualList } from "../../shared/virtual/VirtualList";
import { PageActions } from "../../shell/PageActions";
import { PageContent } from "../../shell/layout/PageContent";
import { modelProviderName } from "../../shared/utils/modelProvider";
import { AccountProviderDetail } from "./AccountProviderDetail";
import { ApiKeyProviderDetail } from "./ApiKeyProviderDetail";
import { ComboDetail } from "./ComboDetail";
import { ProviderAddPanel } from "./ProviderAddPanel";
import { ProviderRuntimeBanner } from "./ProviderRuntimeBanner";
import { ModelEditorModal } from "./ModelEditorModal";
import type { ModelDraftSeed } from "./ModelEditor";
import { sharedValue } from "./modelEditing";
import { useModelTests } from "./useModelTests";
import styles from "./ProvidersPage.module.scss";

type ApiGrouping = "provider" | "type" | "flat";

type ApiGroup = {
  key: string;
  label: string;
  icon: IconifyIcon;
  models: Model[];
};

type Selection =
  | { kind: "account"; providerId: string }
  | { kind: "apikey"; groupKey: string }
  | { kind: "combo"; comboId: string | null };

type ListItem =
  | { kind: "header"; id: string; label: string }
  | { kind: "account"; id: string; provider: ProviderDescriptor }
  | { kind: "apikey"; id: string; group: ApiGroup }
  | { kind: "combo"; id: string; combo: Combo };

type AddFlow =
  | { step: "kind" }
  | { step: "account" }
  | { step: "provider"; provider: ProviderDescriptor };

/** API-key endpoint groups keyed like the old "by provider" grouping: configured group name, otherwise the server host. */
function apiKeyGroups(models: Model[], grouping: ApiGrouping): ApiGroup[] {
  const groups = new Map<string, ApiGroup>();
  for (const model of models) {
    const descriptor = grouping === "type"
      ? typeGroup(model)
      : grouping === "flat"
        ? { key: model.model_hash, label: model.display_name, icon: model.type === "anthropic" ? claudeIcon : openAiIcon }
        : { key: modelProviderName(model), label: modelProviderName(model), icon: flatColorOrganizationIcon };
    const group = groups.get(descriptor.key);
    if (group) group.models.push(model);
    else groups.set(descriptor.key, { ...descriptor, models: [model] });
  }
  return [...groups.values()];
}

function typeGroup(model: Model) {
  if (model.type === "anthropic") return { key: "anthropic", label: "Anthropic", icon: claudeIcon };
  if (model.openai_endpoint === "/v1/chat/completions") return { key: "openai-chat", label: "OpenAI Chat", icon: openAiIcon };
  return { key: "openai-responses", label: "OpenAI Responses", icon: openAiIcon };
}

export function ProvidersPage() {
  const { models, combos, providers, providerRuntime, cursorBusy } = useAppStore();
  const tests = useModelTests();
  const [starting, setStarting] = useState(false);
  const cancelRequested = useRef(false);
  const [apiGrouping, setApiGrouping] = useState<ApiGrouping>("provider");
  const [selected, setSelected] = useState<Selection | null>(null);
  const [addFlow, setAddFlow] = useState<AddFlow | null>(null);
  const [editor, setEditor] = useState<{ editing: Model | null; seed?: ModelDraftSeed } | null>(null);

  // Poll the runtime status while a download/install is in flight (same cadence as the old gate).
  useEffect(() => {
    if (!providerRuntime) void appStore.refreshProviderRuntime();
  }, [providerRuntime]);
  useEffect(() => {
    if (providerRuntime?.state !== "initializing") return;
    const timer = window.setInterval(() => void appStore.refreshProviderRuntime(), 300);
    return () => window.clearInterval(timer);
  }, [providerRuntime?.state]);

  const initialize = async () => {
    if (starting) return;
    cancelRequested.current = false;
    setStarting(true);
    const status = await appStore.initializeProviderRuntime();
    setStarting(false);
    if (cancelRequested.current && status?.state === "initializing") {
      void appStore.cancelProviderRuntimeInitialization();
    }
  };
  const cancelInitialize = () => {
    cancelRequested.current = true;
    void appStore.cancelProviderRuntimeInitialization();
  };

  const groups = useMemo(() => apiKeyGroups(models, apiGrouping), [models, apiGrouping]);

  // Keep the selection pointed at a real entry; fall back to the first account, then the first API-key group.
  useEffect(() => {
    setSelected((current) => {
      if (current?.kind === "combo" && (current.comboId === null || combos.some((combo) => combo.combo_id === current.comboId))) return current;
      if (current?.kind === "account" && providers.some((provider) => provider.id === current.providerId)) return current;
      if (current?.kind === "apikey" && groups.some((group) => group.key === current.groupKey)) return current;
      if (current?.kind === "apikey" && groups[0]) return { kind: "apikey", groupKey: groups[0].key };
      if (providers[0]) return { kind: "account", providerId: providers[0].id };
      if (groups[0]) return { kind: "apikey", groupKey: groups[0].key };
      if (combos[0]) return { kind: "combo", comboId: combos[0].combo_id };
      return null;
    });
  }, [providers, groups, combos]);

  const providerModels = configuredProviderModels(providers);
  const testTargets = [
    ...models.map((model) => ({ model_hash: model.model_hash, display_name: model.display_name })),
    ...providerModels.map((model) => ({ model_hash: model.id, display_name: model.displayName })),
  ];

  const listItems: ListItem[] = [
    { kind: "header", id: "accounts", label: t("Accounts") },
    ...providers.map((provider): ListItem => ({ kind: "account", id: `account:${provider.id}`, provider })),
    { kind: "header", id: "apikeys", label: t("API keys") },
    ...groups.map((group): ListItem => ({ kind: "apikey", id: `apikey:${group.key}`, group })),
    { kind: "header", id: "combos", label: t("Combos") },
    ...combos.map((combo): ListItem => ({ kind: "combo", id: `combo:${combo.combo_id}`, combo })),
  ];

  const isSelected = (item: ListItem) =>
    (item.kind === "account" && selected?.kind === "account" && selected.providerId === item.provider.id)
    || (item.kind === "apikey" && selected?.kind === "apikey" && selected.groupKey === item.group.key)
    || (item.kind === "combo" && selected?.kind === "combo" && selected.comboId === item.combo.combo_id);

  const selectedProvider = selected?.kind === "account" ? providers.find((provider) => provider.id === selected.providerId) ?? null : null;
  const selectedCombo = selected?.kind === "combo" ? combos.find((combo) => combo.combo_id === selected.comboId) ?? null : null;
  const selectedGroup = selected?.kind === "apikey" ? groups.find((group) => group.key === selected.groupKey) ?? null : null;

  const addableProviders = providers.filter((provider) => provider.resources.some((resource) => resource.add.length > 0 || resource.import !== null));

  const openAddModel = (group: ApiGroup) => {
    const sharedHeaders = sharedValue(group.models.map((model) => JSON.stringify(model.custom_headers ?? {})));
    const seed: ModelDraftSeed = {
      type: sharedValue(group.models.map((model) => model.type)) === "anthropic" ? "anthropic" : "openai",
      base_url: sharedValue(group.models.map((model) => model.base_url)) ?? "",
      api_key: sharedValue(group.models.map((model) => model.api_key)) ?? "",
      group_name: sharedValue(group.models.map((model) => model.group_name ?? ""))?.trim() || null,
      use_full_url: sharedValue(group.models.map((model) => String(model.use_full_url))) === "true",
      custom_headers_enabled: sharedValue(group.models.map((model) => String(model.custom_headers_enabled))) === "true",
      custom_headers: sharedHeaders ? JSON.parse(sharedHeaders) : {},
    };
    setEditor({ editing: null, seed });
  };

  const addFlowTitle = addFlow?.step === "kind"
    ? t("Add provider")
    : addFlow?.step === "account"
      ? t("Choose a provider")
      : addFlow?.step === "provider"
        ? t("Add {name} account", { name: addFlow.provider.name })
        : "";

  return <>
    <PageActions>
      {testTargets.length > 0 && <button
        type="button"
        className={controls.secondary}
        disabled={cursorBusy || (!tests.batchTesting && tests.testingModelHashes.size > 0)}
        onClick={() => void (tests.batchTesting ? tests.cancelAllTests() : tests.testAllModels(testTargets))}
      >{tests.batchTesting ? t("Cancel all tests") : t("Test all")}</button>}
      <Button variant="primary" onClick={() => setAddFlow({ step: "kind" })}>{t("Add provider")}</Button>
    </PageActions>
    <PageContent title={t("Providers")} fixed sections={[{
      key: "providers",
      estimatedHeight: 0,
      content: <div className={styles.pageBody}>
        <ProviderRuntimeBanner status={providerRuntime} starting={starting} onInitialize={() => void initialize()} onCancel={cancelInitialize} />
        <div className={styles.layout}>
          <nav className={styles.listPane} aria-label={t("Providers")}>
            <VirtualList
              items={listItems}
              itemKey={(item) => item.id}
              estimatedItemHeight={52}
              className={styles.list}
              empty={<div className={styles.listEmpty}>{t("No providers or models yet.")}</div>}
            >
              {(item) => {
                if (item.kind === "header") {
                  return <div className={styles.listHeader}>
                    <span>{item.label}</span>
                    {item.id === "apikeys" && groups.length > 0 && <span className={styles.groupingToggle} role="group" aria-label={t("Group models by")}>
                      <button type="button" aria-pressed={apiGrouping === "provider"} onClick={() => setApiGrouping("provider")}>{t("By provider")}</button>
                      <button type="button" aria-pressed={apiGrouping === "type"} onClick={() => setApiGrouping("type")}>{t("By type")}</button>
                      <button type="button" aria-pressed={apiGrouping === "flat"} onClick={() => setApiGrouping("flat")}>{t("Default layout")}</button>
                    </span>}
                    {item.id === "combos" && <span className={styles.groupingToggle}>
                      <button type="button" aria-pressed={selected?.kind === "combo" && selected.comboId === null} onClick={() => setSelected({ kind: "combo", comboId: null })}>{t("Add combo")}</button>
                    </span>}
                  </div>;
                }
                if (item.kind === "combo") {
                  return <button
                    type="button"
                    className={`${styles.listItem} ${isSelected(item) ? styles.listItemActive : ""}`}
                    onClick={() => setSelected({ kind: "combo", comboId: item.combo.combo_id })}
                  >
                    <Icon className={styles.listItemIconGlyph} icon={flatColorComboChartIcon} />
                    <span className={styles.listItemText}>
                      <span className={styles.listItemName}>{item.combo.display_name}</span>
                      <span className={styles.listItemMeta}>{t("{count} models", { count: item.combo.members.length })}</span>
                    </span>
                  </button>;
                }
                if (item.kind === "account") {
                  const provider = item.provider;
                  const accountCount = provider.resources.reduce((count, resource) => count + resource.resources.length, 0);
                  const configured = provider.channels.some((channel) => channel.configured);
                  return <button
                    type="button"
                    className={`${styles.listItem} ${isSelected(item) ? styles.listItemActive : ""}`}
                    onClick={() => setSelected({ kind: "account", providerId: provider.id })}
                  >
                    <img className={styles.listItemIcon} src={provider.icon} alt="" />
                    <span className={styles.listItemText}>
                      <span className={styles.listItemName}>{provider.name}</span>
                      <span className={styles.listItemMeta}>{t("{count} accounts", { count: accountCount })}</span>
                    </span>
                    <span className={`${styles.stateDot} ${configured ? styles.stateDotReady : ""}`} title={configured ? t("Configured") : t("Not configured")} />
                  </button>;
                }
                const group = item.group;
                return <button
                  type="button"
                  className={`${styles.listItem} ${isSelected(item) ? styles.listItemActive : ""}`}
                  onClick={() => setSelected({ kind: "apikey", groupKey: group.key })}
                >
                  <Icon className={styles.listItemIconGlyph} icon={group.icon} />
                  <span className={styles.listItemText}>
                    <span className={styles.listItemName}>{group.label}</span>
                    <span className={styles.listItemMeta}>{t("{count} models", { count: group.models.length })}</span>
                  </span>
                </button>;
              }}
            </VirtualList>
          </nav>
          <div className={styles.detailPane}>
            {selectedProvider && <AccountProviderDetail
              key={selectedProvider.id}
              provider={selectedProvider}
              tests={tests}
              onAddAccount={() => setAddFlow({ step: "provider", provider: selectedProvider })}
            />}
            {selectedGroup && <ApiKeyProviderDetail
              key={`${apiGrouping}:${selectedGroup.key}`}
              groupName={selectedGroup.label}
              groupModels={selectedGroup.models}
              tests={tests}
              onEditModel={(model) => setEditor({ editing: model })}
              onAddModel={() => openAddModel(selectedGroup)}
            />}
            {selected?.kind === "combo" && (selected.comboId === null || selectedCombo) && <ComboDetail
              key={selectedCombo?.combo_id ?? "new"}
              combo={selectedCombo}
              onSaved={(combo) => setSelected({ kind: "combo", comboId: combo.combo_id })}
            />}
            {!selectedProvider && !selectedGroup && selected?.kind !== "combo" && <div className={styles.emptyDetail}>
              <strong>{t("Nothing to show yet")}</strong>
              <span>{providers.length === 0 && models.length === 0
                ? t("Add a signed-in provider account or an API-key endpoint to get started.")
                : t("Select a provider on the left.")}</span>
              <Button variant="primary" onClick={() => setAddFlow({ step: "kind" })}>{t("Add provider")}</Button>
            </div>}
          </div>
        </div>
      </div>,
    }]} />
    <Modal
      open={addFlow !== null}
      title={addFlowTitle}
      onClose={() => setAddFlow(null)}
      closeLabel={t("Cancel")}
      fullHeight={addFlow?.step === "provider"}
    >
      {addFlow?.step === "kind" && <div className={styles.kindOptions}>
        <button type="button" className={styles.kindOption} onClick={() => setAddFlow({ step: "account" })}>
          <Icon icon={providerIcon} size="1.6em" />
          <strong>{t("Provider account")}</strong>
          <span>{t("Sign in with OAuth or import account credentials from an installed provider.")}</span>
        </button>
        <button type="button" className={styles.kindOption} onClick={() => {
          setAddFlow(null);
          setEditor({ editing: null });
        }}>
          <Icon icon={openAiIcon} size="1.6em" />
          <strong>{t("API key endpoint")}</strong>
          <span>{t("Configure an OpenAI or Anthropic compatible endpoint with an API key.")}</span>
        </button>
        <button type="button" className={styles.kindOption} onClick={() => {
          setAddFlow(null);
          setSelected({ kind: "combo", comboId: null });
        }}>
          <Icon icon={flatColorComboChartIcon} size="1.6em" />
          <strong>{t("Model combo")}</strong>
          <span>{t("One Cursor model name backed by several models, with automatic fallback when one fails or refuses.")}</span>
        </button>
      </div>}
      {addFlow?.step === "account" && <div className={styles.providerPickList}>
        {addableProviders.map((provider) => {
          const accountCount = provider.resources.reduce((count, resource) => count + resource.resources.length, 0);
          return <button
            key={provider.id}
            type="button"
            className={styles.kindOption}
            onClick={() => setAddFlow({ step: "provider", provider })}
          >
            <img className={styles.listItemIcon} src={provider.icon} alt="" />
            <strong>{provider.name}</strong>
            <span>{accountCount > 0 ? t("{count} accounts", { count: accountCount }) : t("No accounts yet")}</span>
          </button>;
        })}
        {addableProviders.length === 0 && <span>{t("No installed provider can add accounts right now.")}</span>}
      </div>}
      {addFlow?.step === "provider" && <ProviderAddPanel provider={addFlow.provider} onConfigured={() => setAddFlow(null)} />}
    </Modal>
    <ModelEditorModal
      open={editor !== null}
      editing={editor?.editing ?? null}
      seed={editor?.seed}
      tests={tests}
      onClose={() => setEditor(null)}
    />
  </>;
}

import { useRef, useState } from "react";
import {
  api,
  providerText,
  type ChannelDescriptor,
  type ProviderDescriptor,
  type ProviderImportFile,
  type ProviderModelDescriptor,
  type ProviderResourceAction,
  type ProviderResourceActionResult,
  type ProviderResourceDescriptor,
  type ProviderResourceView,
} from "../../shared/api";
import { useI18n } from "../../i18n/store";
import { appStore, useAppStore } from "../../shared/store/appStore";
import { ActionMenu, type ActionMenuItem } from "../../shared/ui/ActionMenu";
import { Button } from "../../shared/ui/Button";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { useMessage } from "../../shared/ui/message";
import { Switch } from "../../shared/ui/Switch";
import { TruncatedButton } from "../../shared/ui/TruncatedButton";
import { VirtualPage, type VirtualPageSection } from "../../shell/layout/VirtualPage";
import { ProviderResourceList, ResourceActionModal } from "./ProviderResourceList";
import { ModelTestResult } from "./ModelTestResult";
import { errorText } from "./modelEditing";
import type { ModelTests } from "./useModelTests";
import styles from "./ProvidersPage.module.scss";
import resourceStyles from "./ProviderResourcePanels.module.scss";

export function AccountProviderDetail({ provider, tests, onAddAccount }: {
  provider: ProviderDescriptor;
  tests: ModelTests;
  onAddAccount: () => void;
}) {
  const { locale } = useI18n();
  const { ports } = useAppStore();
  const message = useMessage();
  const importInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [resourceAction, setResourceAction] = useState<{
    resource: ProviderResourceDescriptor;
    item: ProviderResourceView;
  } | null>(null);
  const [resourceActionResult, setResourceActionResult] = useState<ProviderResourceActionResult | null>(null);
  const [resourceActionError, setResourceActionError] = useState<string | null>(null);

  const configured = provider.channels.some((channel) => channel.configured);
  const accountCount = provider.resources.reduce((count, resource) => count + resource.resources.length, 0);
  const modelCount = provider.channels.reduce((count, channel) => count + channel.models.length, 0);
  const subtitle = provider.channels.map((channel) => providerText(channel.displayName, locale)).join(" - ");
  const importResource = provider.resources.find((resource) => resource.import);
  const exportResource = provider.resources.find((resource) => resource.resources.length > 0);
  const hasAddOptions = provider.resources.some((resource) => resource.add.length > 0 || resource.import !== null);

  const run = async (key: string, task: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await task();
      await appStore.refreshProviders();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const importFiles = async (files: FileList | null) => {
    if (!files?.length || !importResource) return;
    setImporting(true);
    try {
      const entries: ProviderImportFile[] = await Promise.all(
        [...files].map(async (file) => ({ name: file.name, content: await file.text() })),
      );
      const result = await api.importProviderResources(provider.id, importResource.type, entries);
      await appStore.refreshProviders();
      const summary = t("Import finished: {added} added, {updated} updated", { added: result.added, updated: result.updated });
      if (result.modelSyncError) {
        message(t("The account was saved, but model sync failed: {error}", { error: result.modelSyncError }), { duration: 5000 });
      } else if (result.warnings.length > 0) {
        message(`${summary} - ${result.warnings.join("; ")}`, { duration: 5000 });
      } else {
        message(summary);
      }
    } catch (cause) {
      message(errorText(cause), { duration: 5000 });
    } finally {
      setImporting(false);
      if (importInput.current) importInput.current.value = "";
    }
  };

  const executeResourceAction = async (
    target: { resource: ProviderResourceDescriptor; item: ProviderResourceView },
    action: ProviderResourceAction,
    input: unknown = {},
  ) => {
    const key = `action:${target.item.id}:${action.id}`;
    setBusy(key);
    setResourceActionError(null);
    try {
      const result = await api.providerResourceAction(
        provider.id,
        target.resource.type,
        target.item.id,
        action.id,
        input,
      );
      setResourceActionResult(result);
      await appStore.refreshProviders();
    } catch (cause) {
      setResourceActionError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const openResourceAction = (resource: ProviderResourceDescriptor, item: ProviderResourceView, action: ProviderResourceAction) => {
    setResourceAction({ resource, item });
    setResourceActionResult(null);
    setResourceActionError(null);
    void executeResourceAction({ resource, item }, action);
  };

  const moreItems: ActionMenuItem[] = [
    ...(importResource
      ? [{ id: "import", label: importing ? t("Importing...") : t("Bulk import"), disabled: importing, onSelect: () => importInput.current?.click() }]
      : []),
    ...(exportResource
      ? [{
          id: "export",
          label: t("Bulk export"),
          onSelect: () => void api.openExternalUrl(api.providerResourceExportUrl(ports.service_port, provider.id, exportResource.type)),
        }]
      : []),
    { id: "remove", label: t("Remove provider configuration"), onSelect: () => setConfirmRemove(true) },
    ...(provider.version ? [{ id: "version", type: "text" as const, label: `v${provider.version}` }] : []),
  ];

  const multiChannel = provider.channels.length > 1;
  const sections: VirtualPageSection[] = [
    {
      key: "header",
      estimatedHeight: 96,
      content: <div className={styles.detailHeader}>
        <img className={styles.detailIcon} src={provider.icon} alt="" />
        <div className={styles.detailIdentity}>
          <div className={styles.detailNameRow}>
            <span className={styles.detailName}>{provider.name}</span>
            <span className={`${styles.stateBadge} ${configured ? styles.stateReady : ""}`}>
              {configured ? t("Configured") : t("Not configured")}
            </span>
          </div>
          <span className={styles.detailMeta}>
            {subtitle && `${subtitle} - `}
            {t("{accounts} accounts - {models} models", { accounts: accountCount, models: modelCount })}
            {provider.author ? ` - ${provider.author}` : ""}
            {provider.version ? ` - v${provider.version}` : ""}
          </span>
        </div>
        <div className={styles.detailHeaderActions}>
          {hasAddOptions && <Button variant="primary" size="small" disabled={busy !== null} onClick={onAddAccount}>{t("Add account")}</Button>}
          <ActionMenu label={t("More")} items={moreItems} disabled={busy !== null} />
          {importResource && <input
            ref={importInput}
            type="file"
            hidden
            accept={importResource.import?.accept.join(",")}
            multiple={importResource.import?.multiple ?? false}
            onChange={(event) => void importFiles(event.target.files)}
          />}
        </div>
      </div>,
    },
    ...provider.resources.map((resource): VirtualPageSection => ({
      key: `resource:${resource.type}`,
      estimatedHeight: 60 + Math.min(resource.resources.length || 1, 10) * 72,
      content: <ProviderResourceList
        resource={resource}
        busy={busy !== null}
        onAction={(item, action) => openResourceAction(resource, item, action)}
        onRefresh={(item) => void run(`refresh:${item.id}`, () => api.refreshProviderResource(provider.id, resource.type, item.id))}
        onDelete={(item) => void run(`delete:${item.id}`, () => api.deleteProviderResource(provider.id, resource.type, item.id))}
      />,
    })),
    ...provider.channels.map((channel): VirtualPageSection => ({
      key: `channel:${channel.id}`,
      estimatedHeight: 60 + Math.max(1, channel.models.length) * 56,
      content: <ChannelSection
        provider={provider}
        channel={channel}
        showChannelName={multiChannel}
        busy={busy !== null}
        busyKey={busy}
        tests={tests}
        run={run}
      />,
    })),
    {
      key: "footer-error",
      estimatedHeight: error ? 32 : 1,
      content: error ? <span className={resourceStyles.error} role="alert">{error}</span> : null,
    },
  ];

  return <>
    <VirtualPage sections={sections} />
    {resourceAction && <ResourceActionModal
      action={resourceAction.resource.actions.find((item) => item.target === "resource") ?? null}
      cardAction={resourceAction.resource.actions.find((item) => item.target === "card") ?? null}
      result={resourceActionResult}
      busy={busy !== null}
      error={resourceActionError}
      onClose={() => setResourceAction(null)}
      onCardAction={(action, card) => void executeResourceAction(resourceAction, action, { cardId: card.id })}
    />}
    <ConfirmDialog
      open={confirmRemove}
      title={t("Remove provider configuration")}
      cancelLabel={t("Cancel")}
      confirmLabel={t("Remove")}
      onCancel={() => setConfirmRemove(false)}
      onConfirm={() => {
        setConfirmRemove(false);
        void run("remove-provider", () => appStore.removeProviderConfiguration(provider.id));
      }}
    >
      <p>{t("Remove all accounts and configuration for {name}? Installed provider files are kept.", { name: provider.name })}</p>
    </ConfirmDialog>
  </>;
}

function ChannelSection({ provider, channel, showChannelName, busy, busyKey, tests, run }: {
  provider: ProviderDescriptor;
  channel: ChannelDescriptor;
  showChannelName: boolean;
  busy: boolean;
  busyKey: string | null;
  tests: ModelTests;
  run: (key: string, task: () => Promise<void>) => Promise<void>;
}) {
  const { locale } = useI18n();
  const syncing = busyKey === `sync:${channel.id}`;

  const setAllEnabled = (enabled: boolean) => void run(`models:${channel.id}`, async () => {
    for (const model of channel.models) {
      if (model.enabled !== enabled) await api.setChannelModelEnabled(provider.id, channel.id, model.modelId, enabled);
    }
  });

  return <section className={styles.detailSection} aria-label={showChannelName ? providerText(channel.displayName, locale) : t("Models")}>
    <div className={styles.sectionHeader}>
      <div className={styles.sectionTitle}>
        <strong>{showChannelName ? providerText(channel.displayName, locale) : t("Models")}</strong>
        <span className={styles.sectionMeta}>
          {showChannelName && `${channel.brand} - `}
          {channel.models.length > 0 ? t("{count} models", { count: channel.models.length }) : t("Models not synced yet")}
          {" - "}
          {channel.configured ? t("Callable") : t("Not ready")}
        </span>
      </div>
      {channel.hasModels && <div className={styles.sectionActions}>
        <Button size="small" disabled={busy || channel.models.length === 0} onClick={() => setAllEnabled(true)}>{t("Enable all")}</Button>
        <Button size="small" disabled={busy || channel.models.length === 0} onClick={() => setAllEnabled(false)}>{t("Disable all")}</Button>
        <Button size="small" disabled={busy} onClick={() => void run(`sync:${channel.id}`, () => api.syncChannelModels(provider.id, channel.id).then(() => undefined))}>
          {syncing ? t("Syncing...") : t("Sync models")}
        </Button>
      </div>}
    </div>
    <div className={styles.modelList}>
      {channel.models.map((model) => <ProviderModelRow
        key={model.id}
        model={model}
        disabled={busy}
        testing={tests.testingModelHashes.has(model.id)}
        result={tests.testResults.get(model.id)}
        onToggle={(enabled) => void run(`enable:${model.id}`, () => api.setChannelModelEnabled(provider.id, channel.id, model.modelId, enabled))}
        onTest={() => void tests.testModel({ model_hash: model.id, display_name: model.displayName })}
      />)}
      {channel.models.length === 0 && <span className={resourceStyles.empty}>{t("Models not synced yet")}</span>}
    </div>
  </section>;
}

function ProviderModelRow({ model, disabled, testing, result, onToggle, onTest }: {
  model: ProviderModelDescriptor;
  disabled: boolean;
  testing: boolean;
  result: ReturnType<ModelTests["testResults"]["get"]>;
  onToggle: (enabled: boolean) => void;
  onTest: () => void;
}) {
  return <div className={styles.modelRow}>
    <div className={styles.modelRowName}>
      <span className={styles.modelRowNameText}>{model.displayName}</span>
      <span className={styles.modelRowModelId}>{model.modelId}{model.description ? ` - ${model.description}` : ""}</span>
    </div>
    <ModelTestResult compact state={result} testing={testing} />
    <div className={styles.modelRowActions}>
      <TruncatedButton size="small" disabled={disabled && !testing} label={testing ? t("Cancel test") : t("Test")} onClick={onTest} />
      <Switch
        checked={model.enabled}
        disabled={disabled}
        label={t("Enable {model}", { model: model.displayName })}
        onChange={onToggle}
      />
    </div>
  </div>;
}

import { useEffect, useRef, useState } from "react";
import { api, providerText, type ProviderDescriptor, type ProviderImportFile, type ProviderRuntimePhase, type ProviderRuntimeStatus } from "../../shared/api";
import { useI18n } from "../../i18n/store";
import { PageContent } from "../../shell/layout/PageContent";
import { appStore, useAppStore } from "../../shared/store/appStore";
import { ActionMenu, type ActionMenuItem } from "../../shared/ui/ActionMenu";
import { Button } from "../../shared/ui/Button";
import { Card } from "../../shared/ui/Card";
import { Modal } from "../../shared/ui/Modal";
import { useMessage } from "../../shared/ui/message";
import { TruncatedButton } from "../../shared/ui/TruncatedButton";
import { ProviderAddPanel, ProviderSettingsPanel } from "./ProviderResourcePanels";
import styles from "./ProviderManagementPage.module.scss";

export function ProviderManagementPage() {
  const { providerRuntime, providers } = useAppStore();
  const [progressOpen, setProgressOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [selected, setSelected] = useState<{ providerId: string; mode: "add" | "settings" } | null>(null);
  const cancelRequested = useRef(false);
  const selectedProvider = selected ? providers.find((provider) => provider.id === selected.providerId) ?? null : null;

  useEffect(() => {
    if (!providerRuntime) void appStore.refreshProviderRuntime();
  }, [providerRuntime]);

  useEffect(() => {
    if (providerRuntime?.state !== "initializing") return;
    if (!cancelRequested.current) setProgressOpen(true);
    const timer = window.setInterval(() => void appStore.refreshProviderRuntime(), 300);
    return () => window.clearInterval(timer);
  }, [providerRuntime?.state]);

  const initialize = async () => {
    if (starting) return;
    cancelRequested.current = false;
    setStarting(true);
    setProgressOpen(true);
    const status = await appStore.initializeProviderRuntime();
    setStarting(false);
    if (!status) {
      setProgressOpen(false);
    } else if (cancelRequested.current && status.state === "initializing") {
      void appStore.cancelProviderRuntimeInitialization();
    }
  };

  const closeProgress = () => {
    setProgressOpen(false);
    cancelRequested.current = true;
    if (providerRuntime?.state === "initializing") {
      void appStore.cancelProviderRuntimeInitialization();
    }
  };

  const content = providerRuntime?.state === "ready"
    ? <ProviderCards providers={providers} onOpen={(providerId, mode) => setSelected({ providerId, mode })} />
    : <RuntimeGate status={providerRuntime} starting={starting} onInitialize={() => void initialize()} />;
  const estimatedHeight = providers.length > 0
    ? Math.max(320, Math.ceil(providers.length / 3) * 180)
    : 320;

  return <>
    <PageContent
      title={t("Providers")}
      sections={[{ key: "installed-providers", estimatedHeight, content }]}
    />
    <RuntimeProgressModal
      open={progressOpen}
      status={providerRuntime}
      starting={starting}
      onClose={closeProgress}
    />
    <Modal
      fullHeight
      open={selectedProvider !== null}
      title={selected?.mode === "settings"
        ? t("{name} accounts", { name: selectedProvider?.name ?? "" })
        : t("Add {name} account", { name: selectedProvider?.name ?? "" })}
      onClose={() => setSelected(null)}
      onSubmit={() => setSelected(null)}
      submitLabel={t("Confirm")}
    >
      {selected?.mode === "add" && selectedProvider && <ProviderAddPanel provider={selectedProvider} onConfigured={() => setSelected(null)} />}
      {selected?.mode === "settings" && selectedProvider && <ProviderSettingsPanel provider={selectedProvider} />}
    </Modal>
  </>;
}

function RuntimeGate({ status, starting, onInitialize }: { status: ProviderRuntimeStatus | null; starting: boolean; onInitialize: () => void }) {
  const checking = status === null;
  const initializing = starting || status?.state === "initializing";
  const failed = status?.state === "failed";
  const unsupported = status?.state === "unsupported";
  const title = checking
    ? t("Checking the provider runtime")
    : failed
      ? t("Provider runtime initialization failed")
      : unsupported
        ? t("Provider runtime is not supported on this system")
        : t("Initialize the provider runtime first");
  const description = failed
    ? t("Try initializing again")
    : unsupported
      ? status.error ?? t("This operating system or CPU architecture is not currently supported")
      : t("Initialization downloads and installs the provider runtime.");

  return <div className={styles.gate}>
    <strong>{title}</strong>
    <span>{description}</span>
    {!unsupported && <Button variant="primary" disabled={checking || initializing} onClick={onInitialize}>
      {checking ? t("Checking...") : initializing ? t("Initializing...") : failed ? t("Reinitialize providers") : t("Initialize providers")}
    </Button>}
  </div>;
}

function ProviderCards({ providers, onOpen }: {
  providers: ProviderDescriptor[];
  onOpen: (providerId: string, mode: "add" | "settings") => void;
}) {
  if (providers.length === 0) {
    return <div className={styles.empty}>
      <strong>{t("No providers installed")}</strong>
      <span>{t("Installed providers will appear here.")}</span>
    </div>;
  }
  return <div className={styles.providerGrid}>
    {providers.map((provider) => <ProviderCard key={provider.id} provider={provider} onOpen={onOpen} />)}
  </div>;
}

function ProviderCard({ provider, onOpen }: {
  provider: ProviderDescriptor;
  onOpen: (providerId: string, mode: "add" | "settings") => void;
}) {
  const { locale } = useI18n();
  const { ports } = useAppStore();
  const message = useMessage();
  const importInput = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const configured = provider.channels.some((channel) => channel.configured);
  const accountCount = provider.resources.reduce((count, resource) => count + resource.resources.length, 0);
  const modelCount = provider.channels.reduce((count, channel) => count + channel.models.length, 0);
  const subtitle = provider.channels.map((channel) => providerText(channel.displayName, locale)).join(" - ") || provider.id;
  const importResource = provider.resources.find((resource) => resource.import);
  const exportResource = provider.resources.find((resource) => resource.resources.length > 0);

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
      message(cause instanceof Error ? cause.message : String(cause), { duration: 5000 });
    } finally {
      setImporting(false);
      if (importInput.current) importInput.current.value = "";
    }
  };

  const moreItems: ActionMenuItem[] = [
    ...(importResource
      ? [
          {
            id: "import",
            label: importing ? t("Importing...") : t("Bulk import"),
            disabled: importing,
            onSelect: () => importInput.current?.click(),
          },
        ]
      : []),
    ...(exportResource
      ? [
          {
            id: "export",
            label: t("Bulk export"),
            onSelect: () =>
              void api.openExternalUrl(
                api.providerResourceExportUrl(
                  ports.service_port,
                  provider.id,
                  exportResource.type,
                ),
              ),
          },
        ]
      : []),
    ...(provider.version
      ? [{ id: "version", type: "text" as const, label: `v${provider.version}` }]
      : []),
  ];

  return (
    <Card className={styles.providerCard}>
      <div className={styles.providerCardTop}>
        <img className={styles.providerIcon} src={provider.icon} />
        <div className={styles.providerIdentity}>
          <span className={styles.providerName}>{provider.name}</span>
          <span className={styles.providerId}>{subtitle}</span>
        </div>
        <span
          className={`${styles.stateBadge} ${configured ? styles.stateReady : ""}`}
        >
          {configured ? t("Configured") : t("Not configured")}
        </span>
      </div>
      <div className={styles.providerMeta}>
        <span>
          {t("{accounts} accounts - {models} models", {
            accounts: accountCount,
            models: modelCount,
          })}
        </span>
        {provider.author && (
          <span className={styles.providerAuthor}>{provider.author}</span>
        )}
      </div>
      <div className={styles.cardActions}>
        <TruncatedButton
          size="small"
          variant="primary"
          label={t("Add account")}
          onClick={() => onOpen(provider.id, "add")}
        />
        {configured && (
          <TruncatedButton
            size="small"
            label={t("Manage accounts")}
            onClick={() => onOpen(provider.id, "settings")}
          />
        )}
        {moreItems.length > 0 && (
          <span className={styles.moreAction}>
            <ActionMenu label={t("More")} items={moreItems} />
          </span>
        )}
        {importResource && (
          <input
            ref={importInput}
            type="file"
            hidden
            accept={importResource.import?.accept.join(",")}
            multiple={importResource.import?.multiple ?? false}
            onChange={(event) => void importFiles(event.target.files)}
          />
        )}
      </div>
    </Card>
  );
}

function RuntimeProgressModal({ open, status, starting, onClose }: { open: boolean; status: ProviderRuntimeStatus | null; starting: boolean; onClose: () => void }) {
  const initializing = starting || status?.state === "initializing";
  const downloaded = status?.downloaded_bytes ?? 0;
  const total = status?.total_bytes ?? null;
  const percent = total && total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : null;
  const stage = status?.state === "ready"
    ? t("Provider runtime initialized")
    : status?.state === "failed"
      ? t("Provider runtime initialization failed")
      : phaseText(status?.phase ?? null);

  return <Modal
    open={open}
    title={t("Initialize provider runtime")}
    closeLabel={status?.state === "ready" ? t("Done") : initializing ? t("Cancel") : t("Close")}
    onClose={onClose}
  >
    <div className={styles.progressContent} aria-live="polite">
      <strong>{stage}</strong>
      {status?.phase === "downloading" && <>
        <div
          className={styles.progressBar}
          role="progressbar"
          aria-label={t("Download progress")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent ?? undefined}
        >
          <div
            className={styles.progressFill}
            style={{ width: `${percent ?? 100}%` }}
          />
        </div>
        <span>
          {total ? t("Downloaded {downloaded} / {total}", { downloaded: formatBytes(downloaded), total: formatBytes(total) }) : t("Downloaded {downloaded}", { downloaded: formatBytes(downloaded) })}
        </span>
      </>}
      {status?.state === "failed" && <span className={styles.error}>{t("Try initializing again")}</span>}
      {status?.state === "ready" && <span>{t("Provider runtime {version} is installed and ready to use.", { version: status.version })}</span>}
    </div>
  </Modal>;
}

function phaseText(phase: ProviderRuntimePhase | null) {
  switch (phase) {
    case "checking": return t("Checking the provider runtime");
    case "downloading": return t("Downloading the provider runtime");
    case "verifying": return t("Verifying the provider runtime download");
    case "installing": return t("Installing the provider runtime");
    case "validating": return t("Validating the provider runtime");
    default: return t("Preparing the provider runtime");
  }
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : value.toFixed(0)} ${units[unit]}`;
}

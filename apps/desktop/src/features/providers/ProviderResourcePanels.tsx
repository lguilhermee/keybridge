import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  providerText,
  type ProviderAddMethod,
  type ProviderDescriptor,
  type ProviderImportDescriptor,
  type ProviderImportFile,
  type ProviderOAuthBegin,
  type ChannelDescriptor,
  type ProviderResourceAction,
  type ProviderResourceActionCard,
  type ProviderResourceActionResult,
  type ProviderResourceDescriptor,
  type ProviderResourceView,
} from "../../shared/api";
import { useI18n } from "../../i18n/store";
import { appStore } from "../../shared/store/appStore";
import { Button } from "../../shared/ui/Button";
import { Card } from "../../shared/ui/Card";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { FormField, TextInput } from "../../shared/ui/FormControls";
import { useMessage } from "../../shared/ui/message";
import { Modal } from "../../shared/ui/Modal";
import { Switch } from "../../shared/ui/Switch";
import styles from "./ProviderResourcePanels.module.scss";

const PAGE_SIZE = 10;

export function ProviderAddPanel({ provider, onConfigured }: { provider: ProviderDescriptor; onConfigured: () => void }) {
  const hasAddOptions = provider.resources.some((resource) => resource.add.length > 0 || resource.import !== null);
  return <div className={styles.panel}>
    {provider.resources.map((resource) => <ResourceAddSection
      key={resource.type}
      provider={provider}
      resource={resource}
      onConfigured={onConfigured}
    />)}
    {!hasAddOptions && <span className={styles.empty}>{t("This provider does not need any resources.")}</span>}
  </div>;
}

function ResourceAddSection({ provider, resource, onConfigured }: {
  provider: ProviderDescriptor;
  resource: ProviderResourceDescriptor;
  onConfigured: () => void;
}) {
  return <>
    {resource.add.map((method) => <OAuthMethodCard
      key={method.id}
      providerId={provider.id}
      resourceType={resource.type}
      method={method}
      onConfigured={onConfigured}
    />)}
    {resource.import && <ImportMethodCard
      providerId={provider.id}
      resourceType={resource.type}
      descriptor={resource.import}
      onConfigured={onConfigured}
    />}
  </>;
}

function ImportMethodCard({ providerId, resourceType, descriptor, onConfigured }: {
  providerId: string;
  resourceType: string;
  descriptor: ProviderImportDescriptor;
  onConfigured: () => void;
}) {
  const { locale } = useI18n();
  const message = useMessage();
  const input = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [pasted, setPasted] = useState("");
  const [error, setError] = useState<string | null>(null);

  const finishImport = async (entries: ProviderImportFile[]) => {
    const result = await api.importProviderResources(providerId, resourceType, entries);
    await appStore.refreshProviders();
    const summary = t("Import finished: {added} added, {updated} updated", { added: result.added, updated: result.updated });
    if (result.modelSyncError) {
      message(t("The account was saved, but model sync failed: {error}", { error: result.modelSyncError }), { duration: 5000 });
    } else if (result.warnings.length > 0) {
      message(`${summary} - ${result.warnings.join("; ")}`, { duration: 5000 });
    } else {
      message(summary);
    }
    onConfigured();
  };

  const importFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setImporting(true);
    setError(null);
    try {
      const entries: ProviderImportFile[] = await Promise.all(
        [...files].map(async (file) => ({ name: file.name, content: await file.text() })),
      );
      await finishImport(entries);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setImporting(false);
      if (input.current) input.current.value = "";
    }
  };

  const importPasted = async () => {
    const content = pasted.trim();
    if (!content) return;
    setImporting(true);
    setError(null);
    try {
      await finishImport([{ name: "pasted.txt", content }]);
      setPasted("");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setImporting(false);
    }
  };

  return <Card className={styles.methodCard}>
    <strong>{providerText(descriptor.displayName, locale)}</strong>
    {descriptor.description && <span>{providerText(descriptor.description, locale)}</span>}
    <div className={styles.actions}>
      <TextInput
        aria-label={t("Paste credential")}
        placeholder={t("Paste a key or credential...")}
        value={pasted}
        disabled={importing}
        onChange={(event) => setPasted(event.target.value)}
      />
      <Button variant="primary" disabled={importing || !pasted.trim()} onClick={() => void importPasted()}>
        {t("Add")}
      </Button>
      {descriptor.helpUrl && <Button disabled={importing} onClick={() => void api.openExternalUrl(descriptor.helpUrl!)}>
        {t("Get key")}
      </Button>}
      <Button disabled={importing} onClick={() => input.current?.click()}>
        {importing ? t("Importing...") : t("Bulk import")}
      </Button>
      <input
        ref={input}
        type="file"
        hidden
        accept={descriptor.accept.join(",")}
        multiple={descriptor.multiple}
        onChange={(event) => void importFiles(event.target.files)}
      />
    </div>
    {error && <span className={styles.error} role="alert">{error}</span>}
  </Card>;
}

function OAuthMethodCard({ providerId, resourceType, method, onConfigured }: {
  providerId: string;
  resourceType: string;
  method: ProviderAddMethod;
  onConfigured: () => void;
}) {
  const { locale } = useI18n();
  const [status, setStatus] = useState<"idle" | "starting" | "polling" | "success" | "error">("idle");
  const [begun, setBegun] = useState<ProviderOAuthBegin | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const stopped = useRef(false);

  const copyCode = async (code: string) => {
    await api.copyCursorText(code).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  useEffect(() => () => { stopped.current = true; }, []);

  useEffect(() => {
    if (!begun || status !== "polling") return;
    let timer = 0;
    const poll = async (intervalMs: number) => {
      if (stopped.current) return;
      try {
        const result = await api.providerOAuthPoll(begun.sessionId);
        if (stopped.current) return;
        if (result.status === "pending") {
          timer = window.setTimeout(() => void poll(result.pollIntervalMs), Math.max(1000, result.pollIntervalMs));
          return;
        }
        if (result.status === "completed") {
          await appStore.refreshProviders();
          if (result.modelSyncError) {
            setStatus("error");
            setError(t("The account was saved, but model sync failed: {error}", { error: result.modelSyncError }));
            return;
          }
          setStatus("success");
          onConfigured();
          return;
        }
        setStatus("error");
        setError(result.message || t("Authorization was denied or failed."));
      } catch (cause) {
        if (stopped.current) return;
        setError(errorText(cause));
        timer = window.setTimeout(() => void poll(intervalMs), Math.max(1000, intervalMs));
      }
    };
    timer = window.setTimeout(() => void poll(begun.pollIntervalMs), Math.max(1000, begun.pollIntervalMs));
    return () => window.clearTimeout(timer);
  }, [begun, onConfigured, status]);

  const start = async () => {
    setStatus("starting");
    setError(null);
    try {
      const next = await api.providerOAuthBegin(providerId, resourceType, method.id);
      setBegun(next);
      setStatus("polling");
      if (next.userCode) await api.copyCursorText(next.userCode).catch(() => undefined);
      await api.openExternalUrl(next.verificationUrlComplete || next.verificationUrl);
    } catch (cause) {
      setStatus("error");
      setError(errorText(cause));
    }
  };

  const userCode = begun?.userCode;
  return <Card className={styles.methodCard}>
    <strong>{providerText(method.displayName, locale)}</strong>
    {method.description && <span>{providerText(method.description, locale)}</span>}
    {userCode && status === "polling" && <div className={styles.deviceCode}>
      <small>{t("Device code")}</small>
      <button type="button" onClick={() => void copyCode(userCode)}>{userCode}</button>
      <button type="button" className={styles.copy} onClick={() => void copyCode(userCode)}>
        {copied ? t("Copied") : t("Duplicate")}
      </button>
    </div>}
    <div className={styles.actions}>
      <Button variant="primary" disabled={status === "starting" || status === "polling"} onClick={() => void start()}>
        {status === "starting" ? t("Requesting an authorization code...") : status === "polling" ? t("Waiting for browser authorization...") : t("Start sign-in")}
      </Button>
      {begun && status === "polling" && <Button onClick={() => void api.openExternalUrl(begun.verificationUrlComplete || begun.verificationUrl)}>{t("Open authorization page")}</Button>}
    </div>
    {status === "success" && <span className={styles.success}>{t("Account saved and the model catalog is synced.")}</span>}
    {error && <span className={styles.error} role="alert">{error}</span>}
  </Card>;
}

export function ProviderSettingsPanel({ provider }: { provider: ProviderDescriptor }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modelChannelId, setModelChannelId] = useState<string | null>(null);
  const [resourceAction, setResourceAction] = useState<{
    resource: ProviderResourceDescriptor;
    item: ProviderResourceView;
  } | null>(null);
  const [resourceActionResult, setResourceActionResult] = useState<ProviderResourceActionResult | null>(null);
  const [resourceActionError, setResourceActionError] = useState<string | null>(null);
  const modelChannel = modelChannelId ? provider.channels.find((channel) => channel.id === modelChannelId) ?? null : null;

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

  return <div className={styles.panel}>
    {provider.channels.map((channel) => <ChannelRow
      key={channel.id}
      channel={channel}
      busy={busy !== null}
      syncing={busy === `sync:${channel.id}`}
      onManageModels={() => setModelChannelId(channel.id)}
      onSync={() => void run(`sync:${channel.id}`, async () => {
        await api.syncChannelModels(provider.id, channel.id);
      })}
    />)}
    {provider.resources.map((resource) => <ResourceList
      key={resource.type}
      resource={resource}
      busy={busy !== null}
      onAction={(item, action) => openResourceAction(resource, item, action)}
      onRefresh={(item) => void run(`refresh:${item.id}`, async () => {
        await api.refreshProviderResource(provider.id, resource.type, item.id);
      })}
      onDelete={(item) => void run(`delete:${item.id}`, async () => {
        await api.deleteProviderResource(provider.id, resource.type, item.id);
      })}
    />)}
    {error && <span className={styles.error} role="alert">{error}</span>}
    {modelChannel && <ModelManagementModal
      channel={modelChannel}
      busy={busy !== null}
      onClose={() => setModelChannelId(null)}
      onSubmit={(enabledByModel) => void run("models", async () => {
        for (const model of modelChannel.models) {
          const enabled = enabledByModel[model.id] ?? model.enabled;
          if (model.enabled !== enabled) await api.setChannelModelEnabled(provider.id, modelChannel.id, model.modelId, enabled);
        }
      })}
    />}
    {resourceAction && <ResourceActionModal
      action={resourceAction.resource.actions.find((item) => item.target === "resource") ?? null}
      cardAction={resourceAction.resource.actions.find((item) => item.target === "card") ?? null}
      result={resourceActionResult}
      busy={busy !== null}
      error={resourceActionError}
      onClose={() => setResourceAction(null)}
      onCardAction={(action, card) => void executeResourceAction(resourceAction, action, { cardId: card.id })}
    />}
  </div>;
}

function ChannelRow({ channel, busy, syncing, onManageModels, onSync }: {
  channel: ChannelDescriptor;
  busy: boolean;
  syncing: boolean;
  onManageModels: () => void;
  onSync: () => void;
}) {
  const { locale } = useI18n();
  return <Card className={styles.channelRow}>
    <div>
      <strong>{providerText(channel.displayName, locale)}</strong>
      <span>
        {channel.brand}
        {" - "}
        {channel.models.length > 0 ? t("{count} models", { count: channel.models.length }) : t("Models not synced yet")}
        {" - "}
        {channel.configured ? t("Callable") : t("Not ready")}
      </span>
    </div>
    {channel.hasModels && <div className={styles.actions}>
      <Button size="small" disabled={busy || channel.models.length === 0} onClick={onManageModels}>{t("Model management")}</Button>
      <Button size="small" disabled={busy} onClick={onSync}>
        {syncing ? t("Syncing...") : t("Sync models")}
      </Button>
    </div>}
  </Card>;
}

function ModelManagementModal({ channel, busy, onClose, onSubmit }: {
  channel: ChannelDescriptor;
  busy: boolean;
  onClose: () => void;
  onSubmit: (enabledByModel: Record<string, boolean>) => void;
}) {
  const { locale } = useI18n();
  const [enabledByModel, setEnabledByModel] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setEnabledByModel(Object.fromEntries(channel.models.map((model) => [model.id, model.enabled])));
  }, [channel.models]);

  const setAll = (enabled: boolean) => {
    setEnabledByModel(Object.fromEntries(channel.models.map((model) => [model.id, enabled])));
  };

  return <Modal
    fullHeight
    open
    title={t("{name} model management", { name: providerText(channel.displayName, locale) })}
    busy={busy}
    onClose={onClose}
    onSubmit={() => onSubmit(enabledByModel)}
    submitLabel={t("Confirm")}
  >
    <div className={styles.modelToolbar}>
      <Button size="small" disabled={busy || channel.models.length === 0} onClick={() => setAll(true)}>{t("Select all")}</Button>
      <Button size="small" disabled={busy || channel.models.length === 0} onClick={() => setAll(false)}>{t("Deselect all")}</Button>
    </div>
    <div className={styles.modelTableWrap}>
      <table className={styles.modelTable}>
        <thead><tr><th scope="col">{t("Model name")}</th><th scope="col">{t("Enabled")}</th></tr></thead>
        <tbody>
          {channel.models.map((model) => <tr key={model.id}>
            <td><div className={styles.modelName}>
              <strong>{model.displayName}</strong>
              {model.description && <span>{model.description}</span>}
            </div></td>
            <td><Switch
              checked={enabledByModel[model.id] ?? model.enabled}
              disabled={busy}
              label={t("Enable {model}", { model: model.displayName })}
              onChange={(enabled) => setEnabledByModel((current) => ({ ...current, [model.id]: enabled }))}
            /></td>
          </tr>)}
        </tbody>
      </table>
      {channel.models.length === 0 && <span className={styles.empty}>{t("Models not synced yet")}</span>}
    </div>
  </Modal>;
}

function ResourceList({ resource, busy, onAction, onRefresh, onDelete }: {
  resource: ProviderResourceDescriptor;
  busy: boolean;
  onAction: (item: ProviderResourceView, action: ProviderResourceAction) => void;
  onRefresh: (item: ProviderResourceView) => void;
  onDelete: (item: ProviderResourceView) => void;
}) {
  const { locale } = useI18n();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const filtered = useMemo(
    () => resource.resources.filter((item) => item.displayName.toLowerCase().includes(query.trim().toLowerCase())),
    [resource.resources, query],
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visible = filtered.slice((Math.min(page, pageCount) - 1) * PAGE_SIZE, Math.min(page, pageCount) * PAGE_SIZE);

  useEffect(() => setPage(1), [query]);

  return <FormField label={providerText(resource.displayName, locale)}>
    <div className={styles.resourceSection}>
      {resource.resources.length > PAGE_SIZE && <div className={styles.toolbar}>
        <TextInput aria-label={t("Search resources")} placeholder={t("Search resources")} value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>}
      <div className={styles.resourceList}>
        {visible.map((item) => <ResourceRow
          key={item.id}
          item={item}
          actions={resource.actions.filter((action) => action.target === "resource")}
          canRefresh={resource.canRefresh}
          disabled={busy}
          onAction={(action) => onAction(item, action)}
          onRefresh={() => onRefresh(item)}
          onDelete={() => onDelete(item)}
        />)}
        {visible.length === 0 && <span className={styles.empty}>{t("No resources yet. Add one first.")}</span>}
      </div>
      {pageCount > 1 && <div className={styles.pagination}>
        <Button size="small" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>{t("Previous page")}</Button>
        <span>{t("Page {page} / {total}", { page: Math.min(page, pageCount), total: pageCount })}</span>
        <Button size="small" disabled={page >= pageCount} onClick={() => setPage((current) => current + 1)}>{t("Next page")}</Button>
      </div>}
    </div>
  </FormField>;
}

function ResourceRow({ item, actions, canRefresh, disabled, onAction, onRefresh, onDelete }: {
  item: ProviderResourceView;
  actions: ProviderResourceAction[];
  canRefresh: boolean;
  disabled: boolean;
  onAction: (action: ProviderResourceAction) => void;
  onRefresh: () => void;
  onDelete: () => void;
}) {
  const { locale } = useI18n();
  return <Card className={styles.resourceRow}>
    <div>
      <strong>{item.displayName}</strong>
      {item.description && <span>{providerText(item.description, locale)}</span>}
      {item.metrics.map((metric) => <span key={metric.id}>
        {metric.unit === "percent"
          ? t("{label}: {percent}% left", { label: providerText(metric.label, locale), percent: Math.round(metric.value) })
          : `${providerText(metric.label, locale)}: ${metric.value}`}
      </span>)}
    </div>
    <div className={styles.actions}>
      <StateBadge state={item.state} />
      {actions.map((action) => <Button key={action.id} size="small" disabled={disabled} onClick={() => onAction(action)}>{providerText(action.displayName, locale)}</Button>)}
      {canRefresh && <Button size="small" disabled={disabled} onClick={onRefresh}>{t("Refresh")}</Button>}
      <Button size="small" disabled={disabled} onClick={onDelete}>{t("Delete")}</Button>
    </div>
  </Card>;
}

function ResourceActionModal({ action, cardAction, result, busy, error, onClose, onCardAction }: {
  action: ProviderResourceAction | null;
  cardAction: ProviderResourceAction | null;
  result: ProviderResourceActionResult | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onCardAction: (action: ProviderResourceAction, card: ProviderResourceActionCard) => void;
}) {
  const { locale } = useI18n();
  const [pendingCard, setPendingCard] = useState<ProviderResourceActionCard | null>(null);
  const title = result ? providerText(result.title, locale) : action ? providerText(action.displayName, locale) : t("Resource details");
  const cardActions = cardAction ? [cardAction] : [];

  return <>
    <Modal compact open title={title} busy={busy} onClose={onClose} submitLabel={t("Close")} onSubmit={onClose}>
      <div className={styles.actionBody}>
        {result?.description && <span className={styles.actionDescription}>{providerText(result.description, locale)}</span>}
        {busy && <span className={styles.empty}>{t("Loading...")}</span>}
        {error && <span className={styles.error} role="alert">{error}</span>}
        {!busy && !error && result && result.cards.length === 0 && <span className={styles.empty}>{t("No reset cards available.")}</span>}
        {!busy && !error && result && <div className={styles.actionCardList}>
        {result.cards.map((card) => <Card key={card.id} className={styles.actionCard}>
          <div className={styles.actionCardMain}>
            <strong>{providerText(card.title, locale)}</strong>
            {card.status && <span>{formatActionStatus(card.status, locale)}</span>}
            {card.grantedAtMs !== null && card.grantedAtMs !== undefined && <span>{t("Granted: {time}", { time: formatActionDate(card.grantedAtMs, locale) })}</span>}
            {card.expiresAtMs !== null && card.expiresAtMs !== undefined && <span>{t("Expires: {time}", { time: formatActionDate(card.expiresAtMs, locale) })}</span>}
            {card.fields.map((field) => <span key={field.id}>{providerText(field.label, locale)}: {field.value}</span>)}
          </div>
          {cardActions.length > 0 && <div className={styles.actions}>
            {cardActions.map((cardActionItem) => <Button
              key={cardActionItem.id}
              size="small"
              disabled={busy || card.status !== "available"}
              onClick={() => cardActionItem.destructive ? setPendingCard(card) : onCardAction(cardActionItem, card)}
            >{providerText(cardActionItem.displayName, locale)}</Button>)}
          </div>}
        </Card>)}
      </div>}
      </div>
    </Modal>
    {pendingCard && cardAction && <ConfirmDialog
      open
      title={t("Use reset card")}
      busy={busy}
      confirmLabel={t("Confirm use")}
      onCancel={() => setPendingCard(null)}
      onConfirm={() => {
        const card = pendingCard;
        setPendingCard(null);
        onCardAction(cardAction, card);
      }}
    >
      <p>{t("Using this card consumes it immediately and cannot be undone. Continue?")}</p>
      <strong>{providerText(pendingCard.title, locale)}</strong>
    </ConfirmDialog>}
  </>;
}

function formatActionStatus(status: ProviderResourceActionCard["status"], locale: string) {
  const value = typeof status === "string" ? status : providerText(status, locale);
  switch (value.toLowerCase()) {
    case "available": return t("Ready");
    case "redeemed":
    case "used": return t("Used");
    case "expired": return t("Expired");
    default: return value;
  }
}

function formatActionDate(value: number, locale: string) {
  return new Date(value).toLocaleString(locale);
}

function StateBadge({ state }: { state: ProviderResourceView["state"] }) {
  if (state.status === "cooling") {
    return <span className={styles.cooling} title={state.message ?? undefined}>{t("Cooling down")}</span>;
  }
  if (state.status === "invalid") {
    return <span className={styles.invalid} title={state.message ?? undefined}>{t("Invalid")}</span>;
  }
  return <span className={styles.ready}>{t("Ready")}</span>;
}

function errorText(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

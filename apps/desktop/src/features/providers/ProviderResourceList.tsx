import { useEffect, useMemo, useState } from "react";
import {
  providerText,
  type ProviderResourceAction,
  type ProviderResourceActionCard,
  type ProviderResourceActionResult,
  type ProviderResourceDescriptor,
  type ProviderResourceMetric,
  type ProviderResourceView,
} from "../../shared/api";
import { useI18n } from "../../i18n/store";
import { Button } from "../../shared/ui/Button";
import { Card } from "../../shared/ui/Card";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { FormField, TextInput } from "../../shared/ui/FormControls";
import { Modal } from "../../shared/ui/Modal";
import styles from "./ProviderResourcePanels.module.scss";

const PAGE_SIZE = 10;

export function ProviderResourceList({ resource, busy, onAction, onRefresh, onDelete }: {
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
      {item.metrics.map((metric) => <ResourceMetric key={metric.id} metric={metric} locale={locale} />)}
      {item.state.retryAtMs != null && item.state.status === "cooling" && <span>
        {t("Available again at {time}", { time: formatActionDate(item.state.retryAtMs, locale) })}
      </span>}
    </div>
    <div className={styles.actions}>
      <ProviderResourceStateBadge state={item.state} />
      {actions.map((action) => <Button key={action.id} size="small" disabled={disabled} onClick={() => onAction(action)}>{providerText(action.displayName, locale)}</Button>)}
      {canRefresh && <Button size="small" disabled={disabled} onClick={onRefresh}>{t("Refresh")}</Button>}
      <Button size="small" disabled={disabled} onClick={onDelete}>{t("Delete")}</Button>
    </div>
  </Card>;
}

function ResourceMetric({ metric, locale }: { metric: ProviderResourceMetric; locale: string }) {
  if (metric.unit === "percent") {
    const percent = Math.round(metric.value);
    return <span className={styles.metric}>
      <span className={styles.metricLabel}>{providerText(metric.label, locale)}</span>
      <span className={styles.quotaBar} role="meter" aria-label={providerText(metric.label, locale)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <span className={styles.quotaFill} style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
      </span>
      <span className={styles.metricValue}>{t("{percent}% left", { percent })}</span>
      {metric.resetAtMs != null && <span className={styles.metricReset}>{t("Resets {time}", { time: formatActionDate(metric.resetAtMs, locale) })}</span>}
    </span>;
  }
  return <span className={styles.metric}>
    <span className={styles.metricLabel}>{providerText(metric.label, locale)}</span>
    <span className={styles.metricValue}>{metric.value}</span>
    {metric.resetAtMs != null && <span className={styles.metricReset}>{t("Resets {time}", { time: formatActionDate(metric.resetAtMs, locale) })}</span>}
  </span>;
}

export function ResourceActionModal({ action, cardAction, result, busy, error, onClose, onCardAction }: {
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
              disabled={busy || providerText(card.status, locale).toLowerCase() !== "available"}
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

export function ProviderResourceStateBadge({ state }: { state: ProviderResourceView["state"] }) {
  if (state.status === "cooling") {
    return <span className={styles.cooling} title={state.message ?? undefined}>{t("Cooling down")}</span>;
  }
  if (state.status === "invalid") {
    return <span className={styles.invalid} title={state.message ?? undefined}>{t("Invalid")}</span>;
  }
  return <span className={styles.ready}>{t("Ready")}</span>;
}

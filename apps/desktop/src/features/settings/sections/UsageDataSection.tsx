import { useEffect, useState } from "react";
import { api, type StatisticsStorage, type StatisticsStorageScope, type TokenPricingSettings } from "../../../shared/api";
import { appStore, DEFAULT_TOKEN_PRICING, useAppStore } from "../../../shared/store/appStore";
import { Button } from "../../../shared/ui/Button";
import { ConfirmDialog } from "../../../shared/ui/ConfirmDialog";
import { FormField, TextInput } from "../../../shared/ui/FormControls";
import { useMessage } from "../../../shared/ui/message";
import { Select } from "../../../shared/ui/Select";
import { Switch } from "../../../shared/ui/Switch";
import type { VirtualPageSection } from "../../../shell/layout/VirtualPage";
import { LegacyModelImport } from "../../cursor/LegacyModelImport";
import { SectionCard } from "../SectionCard";
import styles from "./sections.module.scss";

export function usageDataGroups(): VirtualPageSection[] {
  return [
    { key: "observability", estimatedHeight: 96, content: <ObservabilityGroup /> },
    { key: "pricing", estimatedHeight: 200, content: <PricingGroup /> },
    { key: "storage", estimatedHeight: 96, content: <StorageGroup /> },
    { key: "import", estimatedHeight: 96, content: <ImportGroup /> },
  ];
}

function ObservabilityGroup() {
  const { detailed } = useAppStore();
  return <SectionCard title={t("Call observability")}>
    <div className={styles.stackRow}>
      <div>
        <strong>{t("Detailed mode")}</strong>
        <small>
          {t("Also store complete requests and streamed responses; by default only timing, status, and usage are stored.")}
        </small>
      </div>
      <Switch
        label={t("Detailed mode")}
        checked={detailed}
        onChange={(checked) => void appStore.updateDetailed(checked)}
      />
    </div>
  </SectionCard>;
}

type PricingDraft = {
  input_per_million: string;
  output_per_million: string;
  cache_read_per_million: string;
  cache_write_per_million: string;
};

function toDraft(pricing: TokenPricingSettings): PricingDraft {
  return {
    input_per_million: String(pricing.input_per_million),
    output_per_million: String(pricing.output_per_million),
    cache_read_per_million: String(pricing.cache_read_per_million),
    cache_write_per_million: String(pricing.cache_write_per_million),
  };
}

function formatPrice(value: number) {
  return `$${value}`;
}

function parsePrice(value: string, label: string) {
  const price = Number(value);
  if (!Number.isFinite(price) || price < 0) {
    throw new Error(t("{label} must be a non-negative number", { label }));
  }
  return price;
}

function toSettings(draft: PricingDraft): TokenPricingSettings {
  return {
    input_per_million: parsePrice(draft.input_per_million, t("Input price")),
    output_per_million: parsePrice(draft.output_per_million, t("Output price")),
    cache_read_per_million: parsePrice(draft.cache_read_per_million, t("Cache read price")),
    cache_write_per_million: parsePrice(draft.cache_write_per_million, t("Cache write price")),
  };
}

function PricingGroup() {
  const { pricing } = useAppStore();
  const message = useMessage();
  const [draft, setDraft] = useState<PricingDraft>(() => toDraft(pricing));
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(toDraft(pricing));
  }, [pricing, editing]);

  const edit = () => {
    setDraft(toDraft(pricing));
    setEditing(true);
  };

  const cancel = () => {
    setDraft(toDraft(pricing));
    setEditing(false);
  };

  const save = async () => {
    try {
      setSaving(true);
      const next = toSettings(draft);
      if (await appStore.updatePricingSettings(next)) {
        setEditing(false);
        message(t("Pricing settings saved"));
      }
    } catch (cause) {
      message(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const restoreDefault = () => {
    setDraft(toDraft(DEFAULT_TOKEN_PRICING));
  };

  const action = editing ? (
    <div className={styles.actions}>
      <Button size="small" disabled={saving} onClick={restoreDefault}>{t("Restore default")}</Button>
      <Button size="small" disabled={saving} onClick={cancel}>{t("Cancel")}</Button>
      <Button variant="primary" size="small" disabled={saving} onClick={() => void save()}>
        {saving ? t("Saving...") : t("Save")}
      </Button>
    </div>
  ) : (
    <button type="button" className={styles.textAction} onClick={edit}>{t("Edit")}</button>
  );

  return (
    <SectionCard title={t("Token pricing")} action={action}>
      <div className={styles.content}>
        <small>{t("Token unit prices used for the home page estimated value. Unit: USD per million tokens.")}</small>
        {editing ? (
          <div className={styles.customFields}>
            <FormField label={t("Input price ($/1M)")}>
              <TextInput
                type="number"
                min={0}
                step="any"
                value={draft.input_per_million}
                onChange={(event) => setDraft({ ...draft, input_per_million: event.target.value })}
              />
            </FormField>
            <FormField label={t("Output price ($/1M)")}>
              <TextInput
                type="number"
                min={0}
                step="any"
                value={draft.output_per_million}
                onChange={(event) => setDraft({ ...draft, output_per_million: event.target.value })}
              />
            </FormField>
            <FormField label={t("Cache read price ($/1M)")}>
              <TextInput
                type="number"
                min={0}
                step="any"
                value={draft.cache_read_per_million}
                onChange={(event) => setDraft({ ...draft, cache_read_per_million: event.target.value })}
              />
            </FormField>
            <FormField label={t("Cache write price ($/1M)")}>
              <TextInput
                type="number"
                min={0}
                step="any"
                value={draft.cache_write_per_million}
                onChange={(event) => setDraft({ ...draft, cache_write_per_million: event.target.value })}
              />
            </FormField>
          </div>
        ) : (
          <>
            <div className={styles.row}>
              <strong>{t("Input price ($/1M)")}</strong>
              <span className={styles.value}>{formatPrice(pricing.input_per_million)}</span>
            </div>
            <div className={styles.row}>
              <strong>{t("Output price ($/1M)")}</strong>
              <span className={styles.value}>{formatPrice(pricing.output_per_million)}</span>
            </div>
            <div className={styles.row}>
              <strong>{t("Cache read price ($/1M)")}</strong>
              <span className={styles.value}>{formatPrice(pricing.cache_read_per_million)}</span>
            </div>
            <div className={styles.row}>
              <strong>{t("Cache write price ($/1M)")}</strong>
              <span className={styles.value}>{formatPrice(pricing.cache_write_per_million)}</span>
            </div>
          </>
        )}
      </div>
    </SectionCard>
  );
}

function StorageGroup() {
  const message = useMessage();
  const [storage, setStorage] = useState<StatisticsStorage | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearScope, setClearScope] = useState<StatisticsStorageScope>("details");
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    const report = (cause: unknown) => message(cause instanceof Error ? cause.message : String(cause));
    void api.statisticsStorage().then(setStorage).catch(report);
  }, [message]);

  const clearStorage = async () => {
    try {
      setClearing(true);
      setStorage(await api.clearStatisticsStorage(clearScope));
      setConfirmClear(false);
      await appStore.refresh();
      message(clearScope === "all" ? t("All statistics cleared") : t("Detailed records cleared"));
    } catch (cause) {
      message(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setClearing(false);
    }
  };

  const clearTitle = clearScope === "all" ? t("Clear all statistics?") : t("Clear detailed records?");
  const clearDescription = clearScope === "all"
    ? t("All call summaries, detailed content, and trace records will be deleted. Model configuration, CA, and application settings are unaffected. This action cannot be undone.")
    : t("Only request, response, and trace attachments are deleted; call summaries, metrics, and configuration are kept.");

  return <>
    <SectionCard title={t("Storage management")}>
      <div className={styles.stackRow}>
        <div>
          <strong>{t("Statistics")}</strong>
          <small>{storage ? t("{calls} call records - {traces} trace records", { calls: storage.call_count, traces: storage.trace_count }) : t("Calculating...")}</small>
        </div>
        <button
          type="button"
          className={styles.textAction}
          onClick={() => { setClearScope("details"); setConfirmClear(true); }}
        >
          {t("Clear storage")}
        </button>
      </div>
    </SectionCard>
    <ConfirmDialog
      open={confirmClear}
      title={clearTitle}
      busy={clearing}
      cancelLabel={t("Cancel")}
      confirmLabel={t("Confirm clear")}
      onCancel={() => setConfirmClear(false)}
      onConfirm={() => void clearStorage()}
    >
      <div className={styles.confirmContent}>
        <Select
          value={clearScope}
          ariaLabel={t("Clear scope")}
          options={[
            { value: "details", label: t("Only clear detailed records") },
            { value: "all", label: t("Clear all statistics") },
          ]}
          onChange={(value) => setClearScope(value as StatisticsStorageScope)}
        />
        <small>{clearDescription}</small>
      </div>
    </ConfirmDialog>
  </>;
}

function ImportGroup() {
  return <LegacyModelImport>{({ busy, previewing, open }) => <SectionCard title={t("Import")}>
    <div className={styles.stackRow}>
      <div>
        <strong>{t("Legacy configuration")}</strong>
        <small>{t("Read models from the local legacy configuration. New and existing models are shown before confirmation.")}</small>
      </div>
      <Button size="small" disabled={busy} onClick={open}>
        {previewing ? t("Reading...") : t("Review and import")}
      </Button>
    </div>
  </SectionCard>}</LegacyModelImport>;
}

import { useEffect, useState } from "react";
import { api, configuredProviderModels, type ModelTokenPricing, type StatisticsStorage, type StatisticsStorageScope, type TokenPricingSettings } from "../../../shared/api";
import { appStore, DEFAULT_TOKEN_PRICING, useAppStore } from "../../../shared/store/appStore";
import { Button } from "../../../shared/ui/Button";
import { ConfirmDialog } from "../../../shared/ui/ConfirmDialog";
import { FormField, TextInput } from "../../../shared/ui/FormControls";
import { Icon } from "../../../shared/ui/Icon";
import { useMessage } from "../../../shared/ui/message";
import { Combobox, Select } from "../../../shared/ui/Select";
import { Switch } from "../../../shared/ui/Switch";
import { trashIcon } from "../../../shared/ui/icons";
import controls from "../../../shared/ui/Controls.module.scss";
import type { VirtualPageSection } from "../../../shell/layout/VirtualPage";
import { LegacyModelImport } from "../../cursor/LegacyModelImport";
import { SectionCard } from "../SectionCard";
import styles from "./sections.module.scss";

export function usageDataGroups(): VirtualPageSection[] {
  return [
    { key: "observability", estimatedHeight: 96, content: <ObservabilityGroup /> },
    { key: "pricing", estimatedHeight: 340, content: <PricingGroup /> },
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

type ModelPriceDraft = {
  modelId: string;
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
};

type PricingDraft = {
  input_per_million: string;
  output_per_million: string;
  cache_read_per_million: string;
  cache_write_per_million: string;
  models: ModelPriceDraft[];
};

const priceField = (value: number | undefined) => value == null ? "" : String(value);

function toDraft(pricing: TokenPricingSettings): PricingDraft {
  return {
    input_per_million: String(pricing.input_per_million),
    output_per_million: String(pricing.output_per_million),
    cache_read_per_million: String(pricing.cache_read_per_million),
    cache_write_per_million: String(pricing.cache_write_per_million),
    models: Object.entries(pricing.model_prices).map(([modelId, prices]) => ({
      modelId,
      input: priceField(prices.input_per_million),
      output: priceField(prices.output_per_million),
      cacheRead: priceField(prices.cache_read_per_million),
      cacheWrite: priceField(prices.cache_write_per_million),
    })),
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

/** Empty override fields stay unset so the model falls back to the global price. */
function parseOptionalPrice(value: string, label: string): number | undefined {
  if (value.trim() === "") return undefined;
  return parsePrice(value, label);
}

function toSettings(draft: PricingDraft): TokenPricingSettings {
  const modelPrices: Record<string, ModelTokenPricing> = {};
  for (const row of draft.models) {
    const modelId = row.modelId.trim();
    if (!modelId) {
      if (row.input.trim() || row.output.trim() || row.cacheRead.trim() || row.cacheWrite.trim()) {
        throw new Error(t("Each override needs a model ID"));
      }
      continue;
    }
    if (modelPrices[modelId]) throw new Error(t("Duplicate model override: {model}", { model: modelId }));
    const label = (name: string) => t("{name} price for {model}", { name, model: modelId });
    const entry: ModelTokenPricing = {
      input_per_million: parseOptionalPrice(row.input, label(t("Input"))),
      output_per_million: parseOptionalPrice(row.output, label(t("Output"))),
      cache_read_per_million: parseOptionalPrice(row.cacheRead, label(t("Cache read"))),
      cache_write_per_million: parseOptionalPrice(row.cacheWrite, label(t("Cache write"))),
    };
    if (Object.values(entry).every((value) => value === undefined)) continue;
    modelPrices[modelId] = entry;
  }
  return {
    input_per_million: parsePrice(draft.input_per_million, t("Input price")),
    output_per_million: parsePrice(draft.output_per_million, t("Output price")),
    cache_read_per_million: parsePrice(draft.cache_read_per_million, t("Cache read price")),
    cache_write_per_million: parsePrice(draft.cache_write_per_million, t("Cache write price")),
    model_prices: modelPrices,
  };
}

function PricingGroup() {
  const { pricing, overview, models, providers } = useAppStore();
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

  const modelSuggestions = Array.from(new Set([
    ...overview.by_model.map((model) => model.model_id),
    ...models.map((model) => model.model_id),
    ...configuredProviderModels(providers).map((model) => model.modelId),
    ...Object.keys(pricing.model_prices),
  ])).sort();

  const setModelRow = (index: number, patch: Partial<ModelPriceDraft>) => {
    setDraft((current) => ({
      ...current,
      models: current.models.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row),
    }));
  };
  const removeModelRow = (index: number) => {
    setDraft((current) => ({ ...current, models: current.models.filter((_, rowIndex) => rowIndex !== index) }));
  };
  const addModelRow = () => {
    const unused = modelSuggestions.find((candidate) => !draft.models.some((row) => row.modelId === candidate));
    setDraft((current) => ({
      ...current,
      models: [...current.models, { modelId: unused ?? "", input: "", output: "", cacheRead: "", cacheWrite: "" }],
    }));
  };

  const overrideCount = Object.keys(pricing.model_prices).length;
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
        <div className={styles.modelPrices}>
          <div className={styles.modelPricesHeader}>
            <strong>{t("Per-model prices")}</strong>
            {editing
              ? <button type="button" className={styles.textAction} onClick={addModelRow}>{t("Add model")}</button>
              : <small>{overrideCount === 0 ? t("All models use the global prices") : t("{count} overrides", { count: overrideCount })}</small>}
          </div>
          {editing ? (
            draft.models.length === 0 ? null : (
              <div className={styles.modelPriceTable} role="table" aria-label={t("Per-model prices")}>
                <div className={styles.modelPriceRow} role="row">
                  <span role="columnheader">{t("Model")}</span>
                  <span role="columnheader">{t("Input")}</span>
                  <span role="columnheader">{t("Output")}</span>
                  <span role="columnheader">{t("Cache read")}</span>
                  <span role="columnheader">{t("Cache write")}</span>
                  <span />
                </div>
                {draft.models.map((row, index) => (
                  <div className={styles.modelPriceRow} role="row" key={index}>
                    <Combobox
                      value={row.modelId}
                      options={modelSuggestions}
                      placeholder={t("Model ID")}
                      onChange={(value) => setModelRow(index, { modelId: value })}
                    />
                    <TextInput type="number" min={0} step="any" placeholder={formatPrice(pricing.input_per_million)} value={row.input} onChange={(event) => setModelRow(index, { input: event.target.value })} />
                    <TextInput type="number" min={0} step="any" placeholder={formatPrice(pricing.output_per_million)} value={row.output} onChange={(event) => setModelRow(index, { output: event.target.value })} />
                    <TextInput type="number" min={0} step="any" placeholder={formatPrice(pricing.cache_read_per_million)} value={row.cacheRead} onChange={(event) => setModelRow(index, { cacheRead: event.target.value })} />
                    <TextInput type="number" min={0} step="any" placeholder={formatPrice(pricing.cache_write_per_million)} value={row.cacheWrite} onChange={(event) => setModelRow(index, { cacheWrite: event.target.value })} />
                    <button type="button" className={controls.iconButton} aria-label={t("Remove override")} onClick={() => removeModelRow(index)}>
                      <Icon icon={trashIcon} size="1.1em" />
                    </button>
                  </div>
                ))}
              </div>
            )
          ) : (
            overrideCount > 0 && (
              <div className={styles.modelPriceTable} role="table" aria-label={t("Per-model prices")}>
                <div className={styles.modelPriceRow} role="row">
                  <span role="columnheader">{t("Model")}</span>
                  <span role="columnheader">{t("Input")}</span>
                  <span role="columnheader">{t("Output")}</span>
                  <span role="columnheader">{t("Cache read")}</span>
                  <span role="columnheader">{t("Cache write")}</span>
                </div>
                {Object.entries(pricing.model_prices).map(([modelId, prices]) => (
                  <div className={styles.modelPriceRow} role="row" key={modelId}>
                    <span className={styles.modelPriceId} title={modelId}>{modelId}</span>
                    <span>{prices.input_per_million != null ? formatPrice(prices.input_per_million) : t("Global")}</span>
                    <span>{prices.output_per_million != null ? formatPrice(prices.output_per_million) : t("Global")}</span>
                    <span>{prices.cache_read_per_million != null ? formatPrice(prices.cache_read_per_million) : t("Global")}</span>
                    <span>{prices.cache_write_per_million != null ? formatPrice(prices.cache_write_per_million) : t("Global")}</span>
                  </div>
                ))}
              </div>
            )
          )}
        </div>
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

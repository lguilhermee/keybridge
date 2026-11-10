import { useMemo, useState } from "react";
import type { RefusalFallback } from "../../../shared/api";
import { useI18n } from "../../../i18n/store";
import { appStore, useAppStore } from "../../../shared/store/appStore";
import { Button } from "../../../shared/ui/Button";
import { Checkbox } from "../../../shared/ui/Checkbox";
import controls from "../../../shared/ui/Controls.module.scss";
import { Icon, type IconProps } from "../../../shared/ui/Icon";
import { chevronRightIcon, searchIcon, windowCloseIcon } from "../../../shared/ui/icons";
import { useMessage } from "../../../shared/ui/message";
import { Modal } from "../../../shared/ui/Modal";
import { ModelSelect, type ModelSelectOption } from "../../../shared/ui/ModelSelect";
import { configuredModelOptions } from "../../../shared/utils/configuredModelOptions";
import { VirtualList } from "../../../shared/virtual/VirtualList";
import { SectionCard } from "../SectionCard";
import styles from "./sections.module.scss";
import refusalStyles from "./RefusalFallbackGroup.module.scss";

/** Refusing model id -> refusal model id. */
type Fallbacks = Map<string, string>;

type StatusFilter = "all" | "enabled";

type ProviderGroupInfo = {
  group: string;
  icon?: IconProps["icon"];
  iconSrc?: string;
  options: ModelSelectOption[];
};

type ListItem =
  | {
      kind: "provider";
      key: string;
      group: string;
      icon?: IconProps["icon"];
      iconSrc?: string;
      total: number;
      enabled: number;
      modelIds: string[];
    }
  | {
      kind: "model";
      key: string;
      option: ModelSelectOption;
    };

function fallbackMap(fallbacks: RefusalFallback[]): Fallbacks {
  return new Map(fallbacks.map((fallback) => [fallback.model_id, fallback.fallback_model_id]));
}

function serializeFallbacks(fallbacks: Fallbacks): RefusalFallback[] {
  return [...fallbacks.entries()]
    .filter(([, fallbackModelId]) => Boolean(fallbackModelId))
    .map(([model_id, fallback_model_id]) => ({ model_id, fallback_model_id }));
}

function errorText(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Per model: when it refuses, send that request and the rest of its run to another model. */
export function RefusalFallbackGroup() {
  const { models, providers, refusalFallbacks } = useAppStore();
  const { locale } = useI18n();
  const message = useMessage();

  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<Fallbacks>(() => new Map());
  const [preferredFallbackId, setPreferredFallbackId] = useState("");
  const [bulkModelId, setBulkModelId] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [providerFilter, setProviderFilter] = useState<string | null>(null);

  const options = useMemo(() => configuredModelOptions(models, providers, locale), [locale, models, providers]);
  const optionByValue = useMemo(() => new Map(options.map((option) => [option.value, option])), [options]);
  const saved = useMemo(() => fallbackMap(refusalFallbacks), [refusalFallbacks]);

  const providerGroups = useMemo<ProviderGroupInfo[]>(() => {
    const groups = new Map<string, ProviderGroupInfo>();
    for (const option of options) {
      const existing = groups.get(option.group);
      if (existing) {
        existing.options.push(option);
      } else {
        groups.set(option.group, {
          group: option.group,
          icon: option.icon,
          iconSrc: option.iconSrc,
          options: [option],
        });
      }
    }
    return [...groups.values()];
  }, [options]);

  const defaultTargetFor = (sourceModelId: string, currentDraft: Fallbacks): string => {
    const candidates = [
      bulkModelId,
      preferredFallbackId,
      ...[...currentDraft.values()],
      ...options.map((option) => option.value),
    ];
    return candidates.find((candidate) => candidate && candidate !== sourceModelId && optionByValue.has(candidate))
      ?? options.find((option) => option.value !== sourceModelId)?.value
      ?? "";
  };

  const openEditor = () => {
    const initialDraft = new Map(saved);
    const firstSavedTarget = [...initialDraft.values()][0] ?? options[0]?.value ?? "";
    setDraft(initialDraft);
    setPreferredFallbackId(firstSavedTarget);
    setBulkModelId(firstSavedTarget);
    setQuery("");
    setStatusFilter("all");
    setProviderFilter(null);
    setEditing(true);
  };

  const toggle = (modelId: string, enabled: boolean) => {
    setDraft((current) => {
      const next = new Map(current);
      if (enabled) {
        const target = defaultTargetFor(modelId, current);
        next.set(modelId, target);
      } else {
        next.delete(modelId);
      }
      return next;
    });
  };

  const choose = (modelId: string, fallbackId: string) => {
    setPreferredFallbackId(fallbackId);
    setDraft((current) => new Map(current).set(modelId, fallbackId));
  };

  const filteredOptions = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return options.filter((option) => {
      if (providerFilter !== null && option.group !== providerFilter) return false;
      const fallbackId = draft.get(option.value);
      if (statusFilter === "enabled" && fallbackId === undefined) return false;
      if (!terms.length) return true;
      const fallbackLabel = fallbackId ? optionByValue.get(fallbackId)?.label ?? fallbackId : "";
      const haystack = `${option.label} ${option.group} ${option.value} ${fallbackLabel}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [draft, optionByValue, options, providerFilter, query, statusFilter]);

  const listItems = useMemo<ListItem[]>(() => {
    const byGroup = new Map<string, ModelSelectOption[]>();
    for (const option of filteredOptions) {
      const list = byGroup.get(option.group);
      if (list) list.push(option);
      else byGroup.set(option.group, [option]);
    }
    const items: ListItem[] = [];
    for (const [group, groupOptions] of byGroup) {
      const first = groupOptions[0];
      const enabledCount = groupOptions.filter((option) => draft.has(option.value)).length;
      items.push({
        kind: "provider",
        key: `provider:${group}`,
        group,
        icon: first?.icon,
        iconSrc: first?.iconSrc,
        total: groupOptions.length,
        enabled: enabledCount,
        modelIds: groupOptions.map((option) => option.value),
      });
      for (const option of groupOptions) {
        items.push({ kind: "model", key: `model:${option.value}`, option });
      }
    }
    return items;
  }, [draft, filteredOptions]);

  const applicableFiltered = useMemo(
    () => filteredOptions.filter((option) => option.value !== bulkModelId),
    [bulkModelId, filteredOptions],
  );

  const enabledFilteredCount = useMemo(
    () => filteredOptions.filter((option) => draft.has(option.value)).length,
    [draft, filteredOptions],
  );

  const applyBulk = () => {
    if (!bulkModelId) return;
    setPreferredFallbackId(bulkModelId);
    setDraft((current) => {
      const next = new Map(current);
      for (const option of applicableFiltered) {
        next.set(option.value, bulkModelId);
      }
      return next;
    });
  };

  const clearModels = (modelIds: string[]) => {
    setDraft((current) => {
      const next = new Map(current);
      for (const id of modelIds) next.delete(id);
      return next;
    });
  };

  const persistMap = async (target: Fallbacks, closeModal: boolean) => {
    if ([...target.values()].some((fallbackId) => !fallbackId)) {
      message(t("Choose a refusal model for every checked model"));
      return;
    }
    setSaving(true);
    try {
      await appStore.saveRefusalFallbacks(serializeFallbacks(target));
      if (closeModal) setEditing(false);
      message(t("Refusal fallback saved"));
    } catch (cause) {
      message(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  const removeSavedRule = async (modelId: string) => {
    const next = new Map(saved);
    next.delete(modelId);
    await persistMap(next, false);
  };

  const savedGroups = useMemo(() => {
    const groups = new Map<string, {
      group: string;
      icon?: IconProps["icon"];
      iconSrc?: string;
      rows: { modelId: string; fallbackId: string }[];
    }>();
    for (const [modelId, fallbackId] of saved) {
      const sourceOption = optionByValue.get(modelId);
      const groupName = sourceOption?.group ?? t("Other");
      const current = groups.get(groupName);
      if (current) {
        current.rows.push({ modelId, fallbackId });
      } else {
        groups.set(groupName, {
          group: groupName,
          icon: sourceOption?.icon,
          iconSrc: sourceOption?.iconSrc,
          rows: [{ modelId, fallbackId }],
        });
      }
    }
    return [...groups.values()];
  }, [optionByValue, saved]);

  const cardTitle = (
    <div className={refusalStyles.titleRow}>
      <span>{t("Refusal fallback")}</span>
      {saved.size > 0 && (
        <span className={refusalStyles.countBadge}>
          {t("{count} configured", { count: saved.size })}
        </span>
      )}
    </div>
  );

  const cardAction = (
    <Button size="small" variant="primary" disabled={options.length < 2 || saving} onClick={openEditor}>
      {t("Configure")}
    </Button>
  );

  return <>
    <SectionCard title={cardTitle} action={cardAction}>
      <div className={styles.content}>
        <div className={styles.description}>
          <small>{t("When a checked model refuses a request, only that request goes to the chosen refusal model. The next request tries the original model again.")}</small>
        </div>
        {saved.size === 0 ? (
          <div className={refusalStyles.emptyState}>
            <strong>{t("Off for every model")}</strong>
            {options.length < 2 && (
              <small>{t("Configure at least two models to set a refusal fallback.")}</small>
            )}
          </div>
        ) : (
          <div className={refusalStyles.summaryGroups}>
            {savedGroups.map((group) => (
              <div key={group.group} className={refusalStyles.summaryGroup}>
                <div className={refusalStyles.summaryGroupHeader}>
                  <span className={refusalStyles.summaryGroupTitle}>
                    {(group.icon || group.iconSrc) && <Icon icon={group.icon} src={group.iconSrc} size="1.05em" />}
                    <span>{group.group}</span>
                  </span>
                  <span>{group.rows.length}</span>
                </div>
                {group.rows.map(({ modelId, fallbackId }) => {
                  const source = optionByValue.get(modelId);
                  const target = optionByValue.get(fallbackId);
                  return (
                    <div key={modelId} className={refusalStyles.summaryRow}>
                      <span className={refusalStyles.modelPill} title={source?.label ?? modelId}>
                        {(source?.icon || source?.iconSrc) && <Icon icon={source.icon} src={source.iconSrc} size="1em" />}
                        <span>{source?.label ?? modelId}</span>
                      </span>
                      <span className={refusalStyles.arrow} aria-hidden="true">
                        <Icon icon={chevronRightIcon} size="1em" />
                      </span>
                      <span className={refusalStyles.targetPill} title={target ? `${target.group} · ${target.label}` : fallbackId}>
                        {(target?.icon || target?.iconSrc) && <Icon icon={target.icon} src={target.iconSrc} size="1em" />}
                        <span>{target?.label ?? fallbackId}</span>
                      </span>
                      <button
                        type="button"
                        className={refusalStyles.removeRule}
                        disabled={saving}
                        aria-label={t("Remove")}
                        title={t("Remove")}
                        onClick={() => void removeSavedRule(modelId)}
                      >
                        <Icon icon={windowCloseIcon} size="0.95em" />
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </SectionCard>

    <Modal
      open={editing}
      title={t("Refusal fallback")}
      wide
      fullHeight
      scrollable={false}
      busy={saving}
      onClose={() => setEditing(false)}
      onSubmit={() => void persistMap(draft, true)}
      submitLabel={saving ? t("Saving...") : t("Save")}
      closeLabel={t("Cancel")}
      secondaryAction={
        <>
          <span className={refusalStyles.footerNote}>
            {t("{count} configured", { count: draft.size })}
          </span>
          {draft.size > 0 && (
            <button
              type="button"
              className={controls.secondary}
              disabled={saving}
              onClick={() => setDraft(new Map())}
            >
              {t("Disable all")}
            </button>
          )}
        </>
      }
    >
      <div className={refusalStyles.modalLayout}>
        <div className={refusalStyles.toolbar}>
          <div className={refusalStyles.searchRow}>
            <div className={refusalStyles.searchBox}>
              <Icon icon={searchIcon} size="1em" />
              <input
                value={query}
                placeholder={t("Search by model or provider")}
                aria-label={t("Search by model or provider")}
                spellCheck={false}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && query) {
                    event.preventDefault();
                    event.stopPropagation();
                    setQuery("");
                  }
                }}
              />
              {query && (
                <button
                  type="button"
                  className={refusalStyles.clearSearch}
                  aria-label={t("Clear search")}
                  onClick={() => setQuery("")}
                >
                  <Icon icon={windowCloseIcon} size="0.95em" />
                </button>
              )}
            </div>
            <div className={refusalStyles.statusTabs} role="group" aria-label={t("Filter")}>
              <button
                type="button"
                data-active={statusFilter === "all" || undefined}
                onClick={() => setStatusFilter("all")}
              >
                {t("All ({count})", { count: options.length })}
              </button>
              <button
                type="button"
                data-active={statusFilter === "enabled" || undefined}
                onClick={() => setStatusFilter("enabled")}
              >
                {t("Configured ({count})", { count: draft.size })}
              </button>
            </div>
          </div>

          {providerGroups.length > 1 && (
            <div className={refusalStyles.providerBar} role="group" aria-label={t("Providers")}>
              <button
                type="button"
                className={refusalStyles.providerChip}
                data-active={providerFilter === null || undefined}
                onClick={() => setProviderFilter(null)}
              >
                <span>{t("All providers")}</span>
                <span className={refusalStyles.chipCount}>{options.length}</span>
              </button>
              {providerGroups.map((group) => {
                const enabledCount = group.options.filter((option) => draft.has(option.value)).length;
                return (
                  <button
                    key={group.group}
                    type="button"
                    className={refusalStyles.providerChip}
                    data-active={providerFilter === group.group || undefined}
                    onClick={() => setProviderFilter(providerFilter === group.group ? null : group.group)}
                  >
                    {(group.icon || group.iconSrc) && <Icon icon={group.icon} src={group.iconSrc} size="1em" />}
                    <span>{group.group}</span>
                    <span className={refusalStyles.chipCount} data-configured={enabledCount > 0 || undefined}>
                      {enabledCount > 0 ? `${enabledCount}/${group.options.length}` : group.options.length}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          <div className={refusalStyles.bulkBar}>
            <span className={refusalStyles.bulkLabel}>
              {t("Bulk set refusal model ({count} shown)", { count: filteredOptions.length })}
            </span>
            <div className={refusalStyles.bulkControls}>
              <div className={refusalStyles.bulkSelect}>
                <ModelSelect
                  mode="single"
                  value={bulkModelId}
                  options={options}
                  disabled={saving}
                  label={t("Refusal model")}
                  onChange={setBulkModelId}
                />
              </div>
              <Button
                size="small"
                disabled={saving || !bulkModelId || applicableFiltered.length === 0}
                onClick={applyBulk}
              >
                {t("Apply to shown")}
              </Button>
              <Button
                size="small"
                disabled={saving || enabledFilteredCount === 0}
                onClick={() => clearModels(filteredOptions.map((option) => option.value))}
              >
                {t("Clear shown")}
              </Button>
            </div>
          </div>
        </div>

        <VirtualList
          items={listItems}
          itemKey="key"
          estimatedItemHeight={44}
          overscan={6}
          className={refusalStyles.listViewport}
          contentClassName={refusalStyles.listContent}
          empty={<div className={refusalStyles.emptyList}>{t("No results")}</div>}
        >
          {(item) => {
            if (item.kind === "provider") {
              return (
                <div className={refusalStyles.groupHeader}>
                  <span className={refusalStyles.groupIdentity}>
                    {(item.icon || item.iconSrc) && <Icon icon={item.icon} src={item.iconSrc} size="1.05em" />}
                    <span>{item.group}</span>
                    <span className={refusalStyles.groupCount}>
                      {item.enabled > 0 ? `${item.enabled}/${item.total}` : item.total}
                    </span>
                  </span>
                  {item.enabled > 0 && (
                    <button
                      type="button"
                      className={refusalStyles.groupClear}
                      disabled={saving}
                      onClick={() => clearModels(item.modelIds)}
                    >
                      {t("Clear")}
                    </button>
                  )}
                </div>
              );
            }

            const { option } = item;
            const fallbackId = draft.get(option.value);
            const enabled = fallbackId !== undefined;
            return (
              <div className={refusalStyles.modelRow} data-enabled={enabled || undefined}>
                <div className={refusalStyles.modelToggle}>
                  <Checkbox
                    label={option.label}
                    checked={enabled}
                    disabled={saving}
                    onChange={(checked) => toggle(option.value, checked)}
                  />
                </div>
                <div className={refusalStyles.fallbackControl}>
                  {enabled ? (
                    <ModelSelect
                      mode="single"
                      value={fallbackId}
                      options={options.filter((candidate) => candidate.value !== option.value)}
                      disabled={saving}
                      label={t("Refusal model")}
                      onChange={(value) => choose(option.value, value)}
                    />
                  ) : (
                    <button
                      type="button"
                      className={refusalStyles.offBadge}
                      disabled={saving}
                      onClick={() => toggle(option.value, true)}
                    >
                      {t("Set refusal model")}
                    </button>
                  )}
                </div>
              </div>
            );
          }}
        </VirtualList>
      </div>
    </Modal>
  </>;
}

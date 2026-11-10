import { useEffect, useState } from "react";
import { api, providerText, type Overview, type OverviewModelUsage } from "../../shared/api";
import { ContributionCalendarChart } from "./charts/ContributionCalendarChart";
import { DailyTokenUsageChart } from "./charts/DailyTokenUsageChart";
import { OverviewMetrics } from "./metrics/OverviewMetrics";
import { ModelBreakdown } from "./models/ModelBreakdown";
import { PageContent } from "../../shell/layout/PageContent";
import type { VirtualPageSection } from "../../shell/layout/VirtualPage";
import { OverviewTimeRangeFilter, type OverviewRangePreset, type QuickPreset } from "./OverviewTimeRangeFilter";
import { PageActions } from "../../shell/PageActions";
import { appStore, useAppStore } from "../../shared/store/appStore";
import { formatTimeInput, parseTimeInput } from "../../shared/utils/parseTimeInput";
import { modelProviderName } from "../../shared/utils/modelProvider";
import { downloadTextFile, toCsv } from "../../shared/utils/csv";
import { claudeIcon, downloadIcon, flatColorOrganizationIcon, openAiIcon } from "../../shared/ui/icons";
import { Icon } from "../../shared/ui/Icon";
import { TooltipTrigger } from "../../shared/ui/TooltipTrigger";
import { useI18n } from "../../i18n/store";
import controls from "../../shared/ui/Controls.module.scss";
import { useMessage } from "../../shared/ui/message";

type TimeRange = { startMs: number; endMs: number };

const CALENDAR_DAYS = 365;

function localDateKey(value: Date) {
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${value.getFullYear()}-${month}-${day}`;
}

function contributionCalendarData(overview: Overview, endMs: number) {
  const tokensByDate = new Map<string, number>();
  for (const bucket of overview.token_usage_series) {
    const date = localDateKey(new Date(bucket.bucket_start_ms));
    const tokens = bucket.input_tokens + bucket.cache_read_tokens + bucket.cache_write_tokens + bucket.output_tokens;
    tokensByDate.set(date, (tokensByDate.get(date) ?? 0) + tokens);
  }
  const lastDay = new Date(Math.max(0, endMs - 1));
  lastDay.setHours(0, 0, 0, 0);
  return Array.from({ length: CALENDAR_DAYS }, (_, offset) => {
    const day = new Date(lastDay);
    day.setDate(lastDay.getDate() - (CALENDAR_DAYS - 1) + offset);
    const date = localDateKey(day);
    return { date, tokens: tokensByDate.get(date) ?? 0 };
  });
}

function presetRange(preset: Exclude<OverviewRangePreset, "custom">, now = new Date()): TimeRange {
  const endMs = now.getTime();
  if (preset === "today") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return { startMs: start.getTime(), endMs };
  }
  if (preset === "month") {
    const start = new Date(now);
    start.setMonth(start.getMonth() - 1);
    return { startMs: start.getTime(), endMs };
  }
  const duration = preset === "ten-minutes" ? 10 * 60_000
    : preset === "hour" ? 60 * 60_000
    : 7 * 24 * 60 * 60_000;
  return { startMs: now.getTime() - duration, endMs };
}

/** Seconds covered by the overview's buckets when no explicit range is applied. */
function seriesDurationSeconds(overview: Overview): number | null {
  const series = overview.token_usage_series;
  if (series.length < 2) return null;
  const first = series[0].bucket_start_ms;
  const last = series[series.length - 1].bucket_start_ms;
  const step = series[1].bucket_start_ms - first;
  return Math.max(1, (last + step - first) / 1000);
}

function breakdownCsv(models: OverviewModelUsage[]) {
  return toCsv(
    [t("Model"), t("Model ID"), t("Calls"), t("Input tokens"), t("Cache read tokens"), t("Cache write tokens"), t("Output tokens"), t("Total tokens"), t("Cost (USD)")],
    models.map((model) => [
      model.display_name,
      model.model_id,
      model.calls,
      model.input_tokens,
      model.cache_read_tokens,
      model.cache_write_tokens,
      model.output_tokens,
      model.input_tokens + model.cache_read_tokens + model.cache_write_tokens + model.output_tokens,
      model.cost.toFixed(6),
    ]),
  );
}

export function OverviewPage() {
  const { overview, busy, models, providers } = useAppStore();
  const { locale } = useI18n();
  const message = useMessage();
  const [preset, setPreset] = useState<OverviewRangePreset>("month");
  const [quick, setQuick] = useState<QuickPreset | null>(null);
  const [customRange, setCustomRange] = useState<TimeRange | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [appliedModels, setAppliedModels] = useState<string[]>([]);
  const [rangeOverview, setRangeOverview] = useState<Overview | null>(null);
  const [rangeBusy, setRangeBusy] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const selectedRange = preset === "custom" ? customRange : presetRange(preset);

  useEffect(() => {
    if (!selectedRange) return;
    let active = true;
    setRangeBusy(true);
    void api.overview({
      ...selectedRange,
      modelHashes: appliedModels,
    }).then((next) => {
      if (active) setRangeOverview(next);
    }).finally(() => {
      if (active) setRangeBusy(false);
    });
    return () => { active = false; };
  }, [preset, customRange, overview, refreshVersion, appliedModels]);

  const filteredOverview = rangeOverview ?? overview;
  const dailyTokenUsage = filteredOverview.token_usage_series.map((bucket) => ({
    bucketStartMs: bucket.bucket_start_ms,
    inputTokens: bucket.input_tokens,
    cacheReadTokens: bucket.cache_read_tokens,
    cacheWriteTokens: bucket.cache_write_tokens,
    outputTokens: bucket.output_tokens,
  }));
  const contribution = contributionCalendarData(filteredOverview, selectedRange?.endMs ?? Date.now());
  const metrics = {
    llmCalls: filteredOverview.metrics.llm_calls,
    successfulCalls: filteredOverview.metrics.successful_calls,
    failedCalls: filteredOverview.metrics.failed_calls,
    tokenUsage: filteredOverview.metrics.token_usage,
    promptTokens: filteredOverview.metrics.prompt_tokens,
    inputTokens: filteredOverview.metrics.input_tokens,
    cacheReadTokens: filteredOverview.metrics.cache_read_tokens,
    cacheWriteTokens: filteredOverview.metrics.cache_write_tokens,
    outputTokens: filteredOverview.metrics.output_tokens,
    cost: filteredOverview.metrics.cost,
    rangeSeconds: selectedRange
      ? Math.max(1, (selectedRange.endMs - selectedRange.startMs) / 1000)
      : seriesDurationSeconds(filteredOverview),
  };
  const openCustom = (open: boolean) => {
    if (open && !customStart && !customEnd) {
      const now = new Date();
      setCustomEnd(formatTimeInput(now));
      setCustomStart(formatTimeInput(new Date(now.getTime() - 60 * 60_000)));
    }
    setCustomOpen(open);
  };
  const applyCustom = () => {
    const startMs = parseTimeInput(customStart);
    const endMs = parseTimeInput(customEnd);
    if (startMs === null || endMs === null || startMs >= endMs) return;
    setCustomRange({ startMs, endMs });
    setAppliedModels(selectedModels);
    setQuick(null);
    setPreset("custom");
    setCustomOpen(false);
  };
  const selectQuick = (durationMs: number) => {
    const end = new Date();
    const start = new Date(end.getTime() - durationMs);
    setCustomStart(formatTimeInput(start));
    setCustomEnd(formatTimeInput(end));
    setCustomRange({ startMs: start.getTime(), endMs: end.getTime() });
    setAppliedModels(selectedModels);
    setQuick(durationMs === 4 * 60 * 60_000 ? "four-hours" : "twenty-four-hours");
    setPreset("custom");
    setCustomOpen(false);
  };
  const selectPreset = (value: Exclude<OverviewRangePreset, "custom">) => {
    setPreset(value);
    setQuick(null);
    setCustomOpen(false);
  };
  const refresh = async () => {
    await appStore.refresh();
    setRefreshVersion((version) => version + 1);
  };
  const exportBreakdown = () => {
    try {
      downloadTextFile(`model-breakdown-${new Date().toISOString().slice(0, 10)}.csv`, breakdownCsv(filteredOverview.by_model));
      message(t("Breakdown exported"));
    } catch (cause) {
      message(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const iconFor = (type: string) => type === "anthropic" ? claudeIcon : openAiIcon;
  const modelOptions = [
    ...models.map((model) => ({
      value: model.model_hash,
      label: model.display_name,
      group: modelProviderName(model),
      icon: iconFor(model.type),
    })),
    ...providers.flatMap((provider) => provider.channels.flatMap((channel) =>
      channel.configured ? channel.models.filter((model) => model.enabled).map((model) => ({
        value: model.id,
        label: model.displayName,
        group: providerText(channel.displayName, locale) || model.providerName,
        iconSrc: model.icon || undefined,
        icon: model.icon ? undefined : flatColorOrganizationIcon,
      })) : [],
    )),
  ];
  const sections: VirtualPageSection[] = [
    {
      key: "metrics",
      estimatedHeight: 130,
      content: <OverviewMetrics data={metrics} refreshVersion={refreshVersion} />,
    },
    {
      key: "daily-token-usage",
      estimatedHeight: 240,
      content: <DailyTokenUsageChart
        data={dailyTokenUsage}
        granularity={filteredOverview.token_usage_granularity}
      />,
    },
    {
      key: "by-model",
      estimatedHeight: 200,
      content: <ModelBreakdown models={filteredOverview.by_model} />,
    },
    {
      key: "activity",
      estimatedHeight: 106,
      content: <ContributionCalendarChart data={contribution} />,
    },
  ];

  return <>
    <PageActions>
      <OverviewTimeRangeFilter
        value={preset}
        quick={quick}
        customOpen={customOpen}
        customStart={customStart}
        customEnd={customEnd}
        modelOptions={modelOptions}
        selectedModels={selectedModels}
        busy={busy || rangeBusy}
        onSelect={selectPreset}
        onQuickSelect={selectQuick}
        onCustomOpenChange={openCustom}
        onCustomStartChange={setCustomStart}
        onCustomEndChange={setCustomEnd}
        onSelectedModelsChange={setSelectedModels}
        onCustomApply={applyCustom}
        onRefresh={() => void refresh()}
      />
      <TooltipTrigger label={t("Export model breakdown as CSV")}>
        <button className={controls.iconButton} aria-label={t("Export model breakdown as CSV")} disabled={filteredOverview.by_model.length === 0} onClick={exportBreakdown}>
          <Icon icon={downloadIcon} size="1.1em" />
        </button>
      </TooltipTrigger>
    </PageActions>
    <PageContent title={t("Overview")} sections={sections} />
  </>;
}

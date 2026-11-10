import { formatCompactInteger, formatInteger } from "../../../shared/utils/numberFormat";
import { Icon } from "../../../shared/ui/Icon";
import { useTooltip, type TooltipAnchor } from "../../../shared/ui/Tooltip";
import { informationOutlineIcon } from "../../../shared/ui/icons";
import { CacheHitRateChart } from "./CacheHitRateChart";
import styles from "./OverviewMetrics.module.scss";

export type OverviewMetricsData = {
  llmCalls: number;
  successfulCalls: number;
  failedCalls: number;
  tokenUsage: number;
  promptTokens: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  /** Estimated cost in USD over the filtered range (per-model prices applied server-side). */
  cost: number;
  /** Length of the filtered range in seconds; output speed falls back to "--" without it. */
  rangeSeconds: number | null;
};

function formatMetricValue(value: number) {
  const full = formatInteger(value);
  const compact = formatCompactInteger(value);
  return full === compact ? full : `${full} (${compact})`;
}

function formatRate(value: number | null) {
  return value === null ? t("No data") : `${(Math.max(0, Math.min(1, value)) * 100).toFixed(2)}%`;
}

function calculateRate(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : null;
}

export function formatUSD(value: number) {
  return `$${value.toFixed(value !== 0 && Math.abs(value) < 0.01 ? 4 : 2)}`;
}

function elementAnchor(element: HTMLElement): TooltipAnchor {
  return {
    contextElement: element,
    getBoundingClientRect: () => element.getBoundingClientRect(),
  };
}

function InfoTooltip({ content }: { content: string }) {
  const { show, hide } = useTooltip();

  return <button
    type="button"
    className={styles.info}
    aria-label={t("View instructions")}
    onMouseEnter={(event) => show(elementAnchor(event.currentTarget), undefined, <div className={styles.tooltipText}>{content}</div>)}
    onMouseLeave={hide}
    onFocus={(event) => show(elementAnchor(event.currentTarget), undefined, <div className={styles.tooltipText}>{content}</div>)}
    onBlur={hide}
  ><Icon icon={informationOutlineIcon} size="1.1em" /></button>;
}

export function OverviewMetrics({ data, refreshVersion = 0 }: { data: OverviewMetricsData; refreshVersion?: number }) {
  const cacheHitRate = calculateRate(data.cacheReadTokens, data.cacheReadTokens + data.inputTokens);
  const cacheReuseRate = calculateRate(
    data.cacheReadTokens,
    data.cacheReadTokens + data.cacheWriteTokens + data.inputTokens,
  );
  const successfulCallRate = calculateRate(data.successfulCalls, data.llmCalls);
  const outputSpeed = data.rangeSeconds && data.rangeSeconds > 0
    ? data.outputTokens / data.rangeSeconds
    : null;
  const cacheTooltip = [
    t("Current: {rate}", { rate: formatRate(cacheHitRate) }),
    t("Formula: cache read / (cache read + non-cached input)"),
    t("Default {defaultRate} / include creation {reuseRate}", {
      defaultRate: formatRate(cacheHitRate),
      reuseRate: formatRate(cacheReuseRate),
    }),
  ].join("\n");
  const callsTooltip = [
    t("Aggregated from historical LLM calls; in-progress calls are excluded."),
    "",
    t("Total calls: {count}", { count: formatMetricValue(data.llmCalls) }),
    t("Successful calls: {count}", { count: formatMetricValue(data.successfulCalls) }),
    t("Failed calls: {count}", { count: formatMetricValue(data.failedCalls) }),
    t("Success rate: {rate}", { rate: formatRate(successfulCallRate) }),
  ].join("\n");
  const tokensTooltip = [
    t("Total request Tokens include the prompt and model output."),
    "",
    t("Total requests: {tokens}", { tokens: formatMetricValue(data.tokenUsage) }),
    t("Prompt: {tokens}", { tokens: formatMetricValue(data.promptTokens) }),
    t("Estimated output: {tokens}", { tokens: formatMetricValue(data.outputTokens) }),
    t("Non-cached input: {tokens}", { tokens: formatMetricValue(data.inputTokens) }),
    t("Cache read: {tokens}", { tokens: formatMetricValue(data.cacheReadTokens) }),
    t("Cache write: {tokens}", { tokens: formatMetricValue(data.cacheWriteTokens) }),
    "",
    t("Cache reads and writes are included in prompt-side statistics."),
  ].join("\n");
  const costTooltip = [
    t("Estimated using configured token pricing; per-model prices apply where set."),
    "",
    t("Total: {cost}", { cost: formatUSD(data.cost) }),
  ].join("\n");
  const speedTooltip = [
    t("Average output tokens per second over the selected range."),
    "",
    t("Model output: {tokens}", { tokens: formatMetricValue(data.outputTokens) }),
  ].join("\n");

  return <div className={styles.scroller}>
    <section className={styles.root} aria-label={t("Call statistics")}>
      <article className={styles.metric}>
        <div className={styles.label}>{t("Token usage")}<InfoTooltip content={tokensTooltip} /></div>
        <div className={styles.body}>
          <div className={styles.value} title={formatInteger(data.tokenUsage)}>{formatCompactInteger(data.tokenUsage)}</div>
          <div className={styles.secondary}>{t("Prompt {tokens}", { tokens: formatCompactInteger(data.promptTokens) })}</div>
        </div>
      </article>
      <article className={styles.metric}>
        <div className={styles.label}>{t("Estimated value")}<InfoTooltip content={costTooltip} /></div>
        <div className={styles.body}>
          <div className={styles.value} title={formatUSD(data.cost)}>{formatUSD(data.cost)}</div>
          <div className={styles.secondary}>{t("Output {tokens}", { tokens: formatCompactInteger(data.outputTokens) })}</div>
        </div>
      </article>
      <article className={styles.metric}>
        <div className={styles.label}>{t("Cache hit rate")}<InfoTooltip content={cacheTooltip} /></div>
        <CacheHitRateChart rate={cacheHitRate ?? 0} animationKey={refreshVersion} />
      </article>
      <article className={styles.metric}>
        <div className={styles.label}>{t("LLM calls")}<InfoTooltip content={callsTooltip} /></div>
        <div className={styles.body}>
          <div className={styles.value} title={formatInteger(data.llmCalls)}>{formatCompactInteger(data.llmCalls)}</div>
          <div className={styles.secondary}>{t("{rate} success", { rate: formatRate(successfulCallRate) })}</div>
        </div>
      </article>
      <article className={styles.metric}>
        <div className={styles.label}>{t("Output speed")}<InfoTooltip content={speedTooltip} /></div>
        <div className={styles.body}>
          <div className={styles.value}>{outputSpeed === null ? "--" : `${formatCompactInteger(outputSpeed)}`}<span className={styles.unit}>{outputSpeed === null ? "" : ` ${t("tokens/s")}`}</span></div>
          <div className={styles.secondary}>{t("Output {tokens}", { tokens: formatCompactInteger(data.outputTokens) })}</div>
        </div>
      </article>
    </section>
  </div>;
}

import type { ReactNode } from "react";
import type { LlmCall, TokenPricingSettings } from "../../shared/api";
import { pricingForModel } from "../../shared/api";
import { ScrollableContent } from "../../shared/virtual/ScrollableContent";
import { formatCompactInteger, formatInteger } from "../../shared/utils/numberFormat";
import styles from "./CallsTable.module.scss";

export type CallRow = { kind: "call"; call: LlmCall };
export type ConversationRow = { kind: "group"; conversationId: string; calls: number; context: { used: number; window: number } | null };
export type TableRow = CallRow | ConversationRow;

export function formatDuration(ms: number | null) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

export function formatClock(ms: number) {
  const value = new Date(ms);
  const today = new Date();
  const sameDay = value.getFullYear() === today.getFullYear()
    && value.getMonth() === today.getMonth()
    && value.getDate() === today.getDate();
  const time = value.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  if (sameDay) return time;
  return `${value.getMonth() + 1}/${value.getDate()} ${time}`;
}

export function callCost(call: LlmCall, pricing: TokenPricingSettings): number | null {
  if (call.call_kind !== "provider_llm") return null;
  const prices = pricingForModel(pricing, call.model_id);
  const output = call.output_tokens ?? (call.output_estimated ? call.estimated_output_tokens ?? 0 : 0);
  const cost = ((call.input_tokens ?? 0) * prices.input
    + (call.cache_read_tokens ?? 0) * prices.cacheRead
    + (call.cache_write_tokens ?? 0) * prices.cacheWrite
    + output * prices.output) / 1_000_000;
  return Number.isFinite(cost) ? cost : null;
}

export function formatCost(cost: number | null) {
  if (cost == null) return "-";
  return `$${cost.toFixed(cost !== 0 && Math.abs(cost) < 0.01 ? 4 : 2)}`;
}

function cachedTokens(call: LlmCall) {
  return (call.cache_read_tokens ?? 0) + (call.cache_write_tokens ?? 0);
}

function StatusPill({ status }: { status: string }) {
  return <span className={styles.status} data-status={status}>{status}</span>;
}

function ContextMeter({ used, window: size }: { used: number; window: number }) {
  const ratio = size > 0 ? Math.min(1, used / size) : 0;
  return <span className={styles.contextMeter} title={t("Context: {used} of {size} tokens", { used: formatInteger(used), size: formatInteger(size) })}>
    <span className={styles.contextMeterBar}><span style={{ width: `${ratio * 100}%` }} data-warn={ratio > 0.85 || undefined} /></span>
    <span className={styles.contextMeterText}>{formatCompactInteger(used)}/{formatCompactInteger(size)}</span>
  </span>;
}

const HEADERS = () => [
  t("Time"),
  t("Model"),
  t("Input"),
  t("Cached"),
  t("Output"),
  t("Cost"),
  t("Duration"),
];

export function CallsTable({ rows, selectedCallId, pricing, onSelect, emptyText = t("No calls match the current filters") }: {
  rows: TableRow[];
  selectedCallId: string | null;
  pricing: TokenPricingSettings;
  onSelect: (call: LlmCall) => void;
  emptyText?: ReactNode;
}) {
  const headers = HEADERS();
  return <div className={styles.tableRegion}>
    <ScrollableContent horizontal className={[styles.viewport, rows.length === 0 ? styles.emptyViewport : ""].filter(Boolean).join(" ")} viewportClassName={styles.tableViewport} contentClassName={styles.tableContent} scrollbarInsetTop="33px">
      <table className={styles.table}>
        <thead><tr>{headers.map((header, index) => <th key={index}>{header}</th>)}</tr></thead>
        <tbody>
          {rows.map((row) => row.kind === "group" ? (
            <tr key={`group-${row.conversationId}`} className={styles.groupRow}>
              <td colSpan={headers.length}>
                <span className={styles.groupLabel} title={row.conversationId}>{t("Conversation {id}", { id: row.conversationId || "-" })}</span>
                <span className={styles.groupMeta}>{t("{count} calls", { count: row.calls })}</span>
                {row.context && <ContextMeter used={row.context.used} window={row.context.window} />}
              </td>
            </tr>
          ) : (
            <CallRowView key={row.call.call_id} call={row.call} pricing={pricing} selected={row.call.call_id === selectedCallId} onSelect={onSelect} />
          ))}
        </tbody>
      </table>
    </ScrollableContent>
    {rows.length === 0 && <div className={styles.emptyState}>{emptyText}</div>}
  </div>;
}

function CallRowView({ call, pricing, selected, onSelect }: { call: LlmCall; pricing: TokenPricingSettings; selected: boolean; onSelect: (call: LlmCall) => void }) {
  const output = call.output_tokens ?? (call.output_estimated ? call.estimated_output_tokens : null);
  const duration = call.duration_ms ?? (call.status === "running" ? Math.max(0, Date.now() - call.created_at_ms) : null);
  return <tr
    className={[styles.callRow, selected ? styles.selected : "", call.status === "running" ? styles.running : ""].filter(Boolean).join(" ")}
    data-selected={selected || undefined}
    onClick={() => onSelect(call)}
  >
    <td>
      <span className={styles.timeCell}><StatusPill status={call.status} /><span className={styles.time}>{formatClock(call.created_at_ms)}</span></span>
    </td>
    <td title={call.model_id}>
      <div className={styles.modelName}>{call.display_name || call.model_id}</div>
      {call.display_name && call.display_name !== call.model_id && <div className={styles.modelId}>{call.model_id}</div>}
    </td>
    <td title={call.input_tokens == null ? undefined : formatInteger(call.input_tokens)}>{call.input_tokens == null ? "-" : formatCompactInteger(call.input_tokens)}</td>
    <td title={formatInteger(cachedTokens(call))}>{cachedTokens(call) === 0 && call.cache_read_tokens == null && call.cache_write_tokens == null ? "-" : formatCompactInteger(cachedTokens(call))}</td>
    <td title={output == null ? undefined : formatInteger(output)}>
      {output == null ? "-" : formatCompactInteger(output)}{call.output_estimated && output != null ? <span className={styles.estimated}>{t("(est.)")}</span> : null}
    </td>
    <td title={(() => { const cost = callCost(call, pricing); return cost == null ? undefined : `$${cost.toFixed(6)}`; })()}>{formatCost(callCost(call, pricing))}</td>
    <td>{formatDuration(duration)}</td>
  </tr>;
}

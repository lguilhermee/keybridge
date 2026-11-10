import type { ReactNode } from "react";
import type { LlmCall, TokenPricingSettings } from "../../shared/api";
import { ScrollableContent } from "../../shared/virtual/ScrollableContent";
import { Button } from "../../shared/ui/Button";
import { Icon } from "../../shared/ui/Icon";
import { closeIcon } from "../../shared/ui/icons";
import controls from "../../shared/ui/Controls.module.scss";
import { TooltipTrigger } from "../../shared/ui/TooltipTrigger";
import { formatInteger } from "../../shared/utils/numberFormat";
import { callCost, formatCost, formatDuration } from "./CallsTable";
import styles from "./CallSidePanel.module.scss";

const show = (value: string | number | null | undefined) => value == null || value === "" ? "-" : value;
const timing = (value: number | null | undefined) => value == null ? "-" : `${value} ms`;

export function CallSidePanel({ call, pricing, contextWindow, onClose, onOpenDetails }: {
  call: LlmCall;
  pricing: TokenPricingSettings;
  contextWindow: number | null;
  onClose: () => void;
  onOpenDetails: (call: LlmCall) => void;
}) {
  const contextUsed = call.usage?.context_input_tokens ?? null;
  const contextRatio = contextWindow && contextUsed != null ? Math.min(1, contextUsed / contextWindow) : null;
  const fields: Array<[string, ReactNode]> = [
    ["Call ID", call.call_id],
    ["Run ID", call.run_id],
    ["Conversation ID", call.conversation_id],
    [t("Call type"), call.call_kind === "cursor_official" ? t("Cursor official") : "LLM"],
    [t("Route"), call.route === "cursor_official" ? t("Cursor official") : "BYOK"],
    [t("Provider call sequence"), call.provider_call_index],
    [t("Status"), call.status],
    ["Finish Reason", show(call.finish_reason)],
    ["HTTP Status", show(call.http_status)],
    ["Model ID", call.model_id],
    ["Model Hash", show(call.model_hash)],
    [t("Protocol type"), call.protocol_type],
    [t("Endpoint URL"), call.endpoint_url],
    [t("Reasoning effort"), show(call.reasoning_effort)],
    ["Fast", call.fast == null ? "-" : call.fast ? t("Yes") : t("No")],
    ["Created At", `${call.created_at_ms} - ${new Date(call.created_at_ms).toLocaleString()}`],
    [t("Duration"), formatDuration(call.duration_ms)],
    ["TTFB", timing(call.ttfb_ms)],
    ["TTFT", timing(call.ttft_ms)],
    ["TTFR", timing(call.ttfr_ms)],
    ["Input Token", call.input_tokens == null ? "-" : formatInteger(call.input_tokens)],
    ["Context Input", contextUsed == null ? "-" : formatInteger(contextUsed)],
    ["Output Token", outputLabel(call)],
    ["Total Token", call.total_tokens == null ? "-" : formatInteger(call.total_tokens)],
    ["Cache Read Token", call.cache_read_tokens == null ? "-" : formatInteger(call.cache_read_tokens)],
    ["Cache Write Token", call.cache_write_tokens == null ? "-" : formatInteger(call.cache_write_tokens)],
    ["Reasoning Token", call.reasoning_tokens == null ? "-" : formatInteger(call.reasoning_tokens)],
    [t("Cost"), formatCost(callCost(call, pricing))],
    [t("Messages"), call.message_count],
    [t("Tools"), call.tool_count],
    [t("Detailed records"), call.detailed ? t("Yes") : t("No")],
    ["Error Kind", show(call.error_kind)],
    ["Error Message", show(call.error_message)],
  ];

  return <aside className={styles.panel} aria-label={t("Call details")}>
    <header className={styles.header}>
      <div className={styles.headerText}>
        <strong title={call.model_id}>{call.display_name || call.model_id}</strong>
        <span className={styles.status} data-status={call.status}>{call.status}</span>
      </div>
      <TooltipTrigger label={t("Close")}>
        <button className={controls.iconButton} aria-label={t("Close")} onClick={onClose}><Icon icon={closeIcon} size="1.1em" /></button>
      </TooltipTrigger>
    </header>
    {contextRatio != null && contextWindow && (
      <div className={styles.context}>
        <div className={styles.contextLabel}>
          <span>{t("Context window")}</span>
          <span>{formatInteger(contextUsed!)} / {formatInteger(contextWindow)}</span>
        </div>
        <div className={styles.contextBar}><span style={{ width: `${contextRatio * 100}%` }} data-warn={contextRatio > 0.85 || undefined} /></div>
      </div>
    )}
    <ScrollableContent className={styles.fields} viewportClassName={styles.fieldsViewport}>
      <dl className={styles.list}>
        {fields.map(([label, value]) => <div key={label} className={styles.row}><dt>{label}</dt><dd title={typeof value === "string" || typeof value === "number" ? String(value) : undefined}>{value}</dd></div>)}
      </dl>
    </ScrollableContent>
    <footer className={styles.footer}>
      <Button variant="secondary" size="small" onClick={() => onOpenDetails(call)}>{t("Open full details")}</Button>
    </footer>
  </aside>;
}

function outputLabel(call: LlmCall) {
  const output = call.output_tokens ?? (call.output_estimated ? call.estimated_output_tokens : null);
  if (output == null) return "-";
  return call.output_estimated ? `${formatInteger(output)} ${t("(est.)")}` : formatInteger(output);
}

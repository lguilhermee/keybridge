import { useEffect, useMemo, useRef, useState } from "react";
import { useKeepAliveContext } from "keepalive-for-react";
import { api, configuredProviderModels, type CallPage, type LlmCall, type OverviewModelUsage } from "../../shared/api";
import { PageContent } from "../../shell/layout/PageContent";
import { PageActions } from "../../shell/PageActions";
import { appStore, useAppStore } from "../../shared/store/appStore";
import { Select } from "../../shared/ui/Select";
import { Pagination } from "../../shared/ui/Pagination";
import { Icon } from "../../shared/ui/Icon";
import { TooltipTrigger } from "../../shared/ui/TooltipTrigger";
import { downloadIcon, groupIcon, searchIcon } from "../../shared/ui/icons";
import { useMessage } from "../../shared/ui/message";
import { downloadTextFile, toCsv } from "../../shared/utils/csv";
import { formatInteger } from "../../shared/utils/numberFormat";
import { callCost, CallsTable, type TableRow } from "./CallsTable";
import { CallSidePanel } from "./CallSidePanel";
import styles from "./CallsPage.module.scss";

const CALL_REFRESH_INTERVAL_MS = 1_000;
const SEARCH_DEBOUNCE_MS = 350;
const EXPORT_BATCH = 500;
const EXPORT_MAX_ROWS = 5_000;

/** Groups the current page's calls by conversation, preserving first-seen order. */
function groupRows(calls: LlmCall[], contextWindows: Map<string, number>): TableRow[] {
  const groups = new Map<string, LlmCall[]>();
  for (const call of calls) {
    const key = call.conversation_id || call.call_id;
    const group = groups.get(key);
    if (group) group.push(call);
    else groups.set(key, [call]);
  }
  const rows: TableRow[] = [];
  for (const [conversationId, members] of groups) {
    // The page is sorted newest-first, so the first member with a reported
    // context size is the conversation's latest known usage.
    const anchor = members.find((call) => call.usage?.context_input_tokens != null);
    const contextWindow = anchor ? contextWindows.get(anchor.model_id) ?? null : null;
    const used = anchor?.usage?.context_input_tokens ?? null;
    rows.push({
      kind: "group",
      conversationId,
      calls: members.length,
      context: contextWindow && used != null ? { used, window: contextWindow } : null,
    });
    for (const call of members) rows.push({ kind: "call", call });
  }
  return rows;
}

/** Calls table plus the overview per-model breakdown appended as a second section. */
function callsCsv(calls: LlmCall[], pricing: Parameters<typeof callCost>[1], breakdown: OverviewModelUsage[]) {
  const breakdownCsv = toCsv(
    [t("Model"), t("Model ID"), t("Calls"), t("Input tokens"), t("Cache read tokens"), t("Cache write tokens"), t("Output tokens"), t("Total tokens"), t("Cost (USD)")],
    breakdown.map((model) => [
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
  ).slice(1); // strip the second BOM; the first table already carries it
  return toCsv(
    [
      t("Time"), t("Status"), t("Call type"), t("Route"), t("Model"), "Model ID",
      t("Input tokens"), t("Cache read tokens"), t("Cache write tokens"), t("Output tokens"), t("Output estimated"),
      t("Total tokens"), t("Reasoning tokens"), t("Cost (USD)"),
      t("Duration (ms)"), "TTFB (ms)", "TTFT (ms)", "TTFR (ms)",
      "HTTP", "Finish Reason", t("Messages"), t("Tools"),
      "Error Kind", "Error Message", "Call ID", "Run ID", "Conversation ID",
    ],
    calls.map((call) => {
      const output = call.output_tokens ?? (call.output_estimated ? call.estimated_output_tokens : null);
      const cost = callCost(call, pricing);
      return [
        new Date(call.created_at_ms).toISOString(),
        call.status,
        call.call_kind,
        call.route,
        call.display_name,
        call.model_id,
        call.input_tokens,
        call.cache_read_tokens,
        call.cache_write_tokens,
        output,
        call.output_estimated ? "1" : "0",
        call.total_tokens,
        call.reasoning_tokens,
        cost == null ? null : cost.toFixed(6),
        call.duration_ms,
        call.ttfb_ms,
        call.ttft_ms,
        call.ttfr_ms,
        call.http_status,
        call.finish_reason,
        call.message_count,
        call.tool_count,
        call.error_kind,
        call.error_message,
        call.call_id,
        call.run_id,
        call.conversation_id,
      ];
    }),
  ) + "\r\n\r\n" + t("Per-model breakdown") + "\r\n" + breakdownCsv;
}

export function CallsPage() {
  const { models, overview, providers, pricing } = useAppStore();
  const { active } = useKeepAliveContext();
  const message = useMessage();
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [status, setStatus] = useState("");
  const [model, setModel] = useState("");
  const [grouping, setGrouping] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [data, setData] = useState<CallPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  const selectedFallback = useRef<LlmCall | null>(null);
  const requestSeq = useRef(0);

  // Debounce the search box so typing does not fire a request per keystroke.
  useEffect(() => {
    const timer = window.setTimeout(() => setAppliedQuery(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  const filters = useMemo(() => ({
    status: status || undefined,
    model: model || undefined,
    q: appliedQuery || undefined,
  }), [status, model, appliedQuery]);
  const offset = (page - 1) * pageSize;

  useEffect(() => {
    let cancelled = false;
    const seq = ++requestSeq.current;
    const load = () => {
      void api.calls({ ...filters, offset, limit: pageSize }).then((next) => {
        if (cancelled || seq !== requestSeq.current) return;
        setData(next);
        setError(null);
      }).catch((cause) => {
        if (cancelled || seq !== requestSeq.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    };
    load();
    const tick = () => {
      if (!cancelled && active && document.visibilityState === "visible") load();
    };
    const interval = window.setInterval(tick, CALL_REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("focus", tick);
    };
  }, [filters, offset, pageSize, active]);

  // Reset to the first page whenever the applied filters change.
  useEffect(() => {
    setPage(1);
  }, [status, model, appliedQuery]);

  const pageCount = Math.max(1, Math.ceil((data?.total ?? 0) / pageSize));
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  const calls = data?.calls ?? [];
  const contextWindows = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of models) {
      if (item.context_window_tokens) map.set(item.model_id, item.context_window_tokens);
    }
    for (const descriptor of configuredProviderModels(providers)) {
      if (descriptor.contextWindow) map.set(descriptor.modelId, descriptor.contextWindow);
    }
    return map;
  }, [models, providers]);

  const modelOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const item of models) {
      if (!seen.has(item.model_id)) seen.set(item.model_id, item.display_name || item.model_id);
    }
    for (const descriptor of configuredProviderModels(providers)) {
      if (!seen.has(descriptor.modelId)) seen.set(descriptor.modelId, descriptor.displayName || descriptor.modelId);
    }
    return [
      { value: "", label: t("All models") },
      ...Array.from(seen.entries()).sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label })),
    ];
  }, [models, providers]);

  const rows = useMemo<TableRow[]>(() => {
    if (!grouping) return calls.map((call) => ({ kind: "call", call }));
    return groupRows(calls, contextWindows);
  }, [calls, grouping, contextWindows]);

  const selectedCall = useMemo(() => {
    if (!selectedCallId) return null;
    const found = calls.find((call) => call.call_id === selectedCallId) ?? null;
    return found ?? (selectedFallback.current?.call_id === selectedCallId ? selectedFallback.current : null);
  }, [calls, selectedCallId]);

  const selectCall = (call: LlmCall) => {
    selectedFallback.current = call;
    setSelectedCallId((current) => current === call.call_id ? null : call.call_id);
  };

  const exportCalls = async () => {
    try {
      setExporting(true);
      const exported: LlmCall[] = [];
      let total = data?.total ?? 0;
      while (exported.length < total && exported.length < EXPORT_MAX_ROWS) {
        const pageData = await api.calls({ ...filters, offset: exported.length, limit: EXPORT_BATCH });
        exported.push(...pageData.calls);
        total = pageData.total;
        if (pageData.calls.length < EXPORT_BATCH) break;
      }
      downloadTextFile(`calls-${new Date().toISOString().slice(0, 10)}.csv`, callsCsv(exported, pricing, overview.by_model));
      message(exported.length < total
        ? t("Exported the first {count} of {total} calls", { count: formatInteger(exported.length), total: formatInteger(total) })
        : t("Exported {count} calls", { count: formatInteger(exported.length) }));
    } catch (cause) {
      message(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setExporting(false);
    }
  };

  const statusOptions = [
    { value: "", label: t("All statuses") },
    { value: "running", label: t("Running") },
    { value: "completed", label: t("Completed") },
    { value: "error", label: t("Error") },
    { value: "cancelled", label: t("Cancelled") },
  ];
  const selectedContextWindow = selectedCall ? contextWindows.get(selectedCall.model_id) ?? null : null;
  const content = (
    <div className={styles.page}>
      {error && <div className={styles.errorBar} role="alert">{error}</div>}
      <div className={styles.body}>
        <div className={styles.tableWrap}>
          <CallsTable
            rows={rows}
            selectedCallId={selectedCallId}
            pricing={pricing}
            onSelect={selectCall}
            emptyText={error ? t("Unable to load calls") : t("No calls match the current filters")}
          />
          <Pagination
            page={page}
            pageCount={pageCount}
            pageSize={pageSize}
            total={data?.total ?? 0}
            onPageChange={setPage}
            onPageSizeChange={(next) => { setPageSize(next); setPage(1); }}
          />
        </div>
        {selectedCall && <CallSidePanel
          call={selectedCall}
          pricing={pricing}
          contextWindow={selectedContextWindow}
          onClose={() => setSelectedCallId(null)}
          onOpenDetails={(call) => void appStore.openCallDetails(call.call_id)}
        />}
      </div>
    </div>
  );

  return <>
    <PageActions>
      <div className={styles.search}>
        <Icon icon={searchIcon} size="1.05em" className={styles.searchIcon} />
        <input
          type="search"
          value={query}
          placeholder={t("Search calls")}
          aria-label={t("Search calls")}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className={styles.filter}><Select ariaLabel={t("Status")} value={status} options={statusOptions} onChange={setStatus} /></div>
      <div className={styles.filter}><Select ariaLabel={t("Model")} value={model} options={modelOptions} onChange={setModel} /></div>
      <TooltipTrigger label={t("Group by conversation")}>
        <button
          type="button"
          className={styles.toggle}
          aria-pressed={grouping}
          aria-label={t("Group by conversation")}
          onClick={() => setGrouping((current) => !current)}
        ><Icon icon={groupIcon} size="1.1em" /></button>
      </TooltipTrigger>
      <TooltipTrigger label={t("Export filtered calls as CSV")}>
        <button
          type="button"
          className={styles.toggle}
          aria-label={t("Export filtered calls as CSV")}
          disabled={exporting || (data?.total ?? 0) === 0}
          onClick={() => void exportCalls()}
        ><Icon icon={downloadIcon} size="1.1em" /></button>
      </TooltipTrigger>
    </PageActions>
    <PageContent fixed title={t("Calls")} contentClassName={styles.pageContent} sections={[{ key: "calls", estimatedHeight: 720, content }]} />
  </>;
}

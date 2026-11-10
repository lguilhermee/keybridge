import type { OverviewModelUsage } from "../../../shared/api";
import { ScrollableContent } from "../../../shared/virtual/ScrollableContent";
import { formatCompactInteger, formatInteger } from "../../../shared/utils/numberFormat";
import { formatUSD } from "../metrics/OverviewMetrics";
import styles from "./ModelBreakdown.module.scss";

function tokens(value: number) {
  return formatInteger(value);
}

function totalTokens(model: OverviewModelUsage) {
  return model.input_tokens + model.cache_read_tokens + model.cache_write_tokens + model.output_tokens;
}

export function ModelBreakdown({ models }: { models: OverviewModelUsage[] }) {
  if (models.length === 0) {
    return <div className={styles.empty}>{t("No calls recorded in this range")}</div>;
  }
  return <div className={styles.root}>
    <ScrollableContent horizontal viewportClassName={styles.viewport}>
      <table className={styles.table}>
        <thead><tr>
          <th>{t("Model")}</th>
          <th>{t("Calls")}</th>
          <th>{t("Input")}</th>
          <th>{t("Cache read")}</th>
          <th>{t("Cache write")}</th>
          <th>{t("Output")}</th>
          <th>{t("Total")}</th>
          <th>{t("Cost")}</th>
        </tr></thead>
        <tbody>
          {models.map((model) => <tr key={model.model_id}>
            <td title={model.model_id}>
              <div className={styles.modelName}>{model.display_name || model.model_id}</div>
              {model.display_name && model.display_name !== model.model_id && <div className={styles.modelId}>{model.model_id}</div>}
            </td>
            <td title={tokens(model.calls)}>{formatCompactInteger(model.calls)}</td>
            <td title={tokens(model.input_tokens)}>{formatCompactInteger(model.input_tokens)}</td>
            <td title={tokens(model.cache_read_tokens)}>{formatCompactInteger(model.cache_read_tokens)}</td>
            <td title={tokens(model.cache_write_tokens)}>{formatCompactInteger(model.cache_write_tokens)}</td>
            <td title={tokens(model.output_tokens)}>{formatCompactInteger(model.output_tokens)}</td>
            <td title={tokens(totalTokens(model))}>{formatCompactInteger(totalTokens(model))}</td>
            <td className={styles.cost} title={`$${model.cost.toFixed(6)}`}>{formatUSD(model.cost)}</td>
          </tr>)}
        </tbody>
      </table>
    </ScrollableContent>
  </div>;
}

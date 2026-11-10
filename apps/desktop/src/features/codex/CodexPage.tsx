import { appStore, useAppStore } from "../../shared/store/appStore";
import { Card } from "../../shared/ui/Card";
import { Switch } from "../../shared/ui/Switch";
import { TooltipTrigger } from "../../shared/ui/TooltipTrigger";
import { PageContent } from "../../shell/layout/PageContent";
import { PageActions } from "../../shell/PageActions";
import styles from "./CodexPage.module.scss";

/** Connects the Codex desktop app and CLI to the models configured in Keybridge. */
export function CodexPage() {
  const { codexHarness, codexBusy } = useAppStore();
  const integration = codexHarness?.integration ?? "disabled";
  const on = integration !== "disabled";
  const switchLabel = on ? t("Disconnect Codex") : t("Connect Codex");
  const stateLabel = integration === "enabled"
    ? t("Connected")
    : integration === "degraded" ? t("Waiting") : t("Not connected");

  const content = <div className={styles.page}>
    <Card as="section" aria-label={t("Codex connection")}>
      <div className={styles.row}>
        <strong>{t("Status")}</strong>
        <span className={styles.value} data-state={integration}>{stateLabel}</span>
      </div>
      {integration === "degraded" && <div className={styles.row}>
        <span className={styles.hint}>{codexHarness?.configured_models
          ? t("Codex is using its own settings until the External API is enabled again under Settings, Network.")
          : t("Codex is using its own settings until a model is added on the Providers page.")}</span>
      </div>}
      <div className={styles.row}>
        <strong>{t("Models offered to Codex")}</strong>
        <span className={styles.value}>{codexHarness?.configured_models ?? 0}</span>
      </div>
      {codexHarness?.model && <div className={styles.row}>
        <strong>{t("Model selected in Codex")}</strong>
        <code className={styles.value}>{codexHarness.model}</code>
      </div>}
      <div className={styles.row}>
        <strong>{t("Codex configuration file")}</strong>
        <code className={styles.value}>{codexHarness?.config_path ?? ""}</code>
      </div>
      {codexHarness && !codexHarness.installed && <div className={styles.row}>
        <span className={styles.hint}>{t("No Codex folder was found on this computer. It is created when you connect.")}</span>
      </div>}
    </Card>
    <ul className={styles.notes}>
      <li>{t("Restart Codex after connecting or disconnecting so it loads the new model list.")}</li>
      <li>{t("While connected, Codex reaches Keybridge models through the External API, which is turned on automatically.")}</li>
      <li>{t("Your own Codex model settings are put back when you disconnect and whenever Keybridge is not running.")}</li>
      <li>{t("Reasoning effort follows each model's settings in Keybridge. Codex's built-in web search is not available with these models.")}</li>
    </ul>
  </div>;

  return <>
    <PageActions position="left">
      <div className={styles.actions}>
        <span className={styles.status}>{stateLabel}</span>
        <TooltipTrigger label={switchLabel}>
          <Switch
            checked={on}
            disabled={codexBusy || !codexHarness}
            label={switchLabel}
            onChange={(enabled) => void appStore.setCodexEnabled(enabled)}
          />
        </TooltipTrigger>
      </div>
    </PageActions>
    <PageContent title="Codex" sections={[{ key: "codex", estimatedHeight: 420, content }]} />
  </>;
}

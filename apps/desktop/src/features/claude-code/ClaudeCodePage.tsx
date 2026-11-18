import { appStore, useAppStore } from "../../shared/store/appStore";
import { Card } from "../../shared/ui/Card";
import { Switch } from "../../shared/ui/Switch";
import { TooltipTrigger } from "../../shared/ui/TooltipTrigger";
import { PageContent } from "../../shell/layout/PageContent";
import { PageActions } from "../../shell/PageActions";
import styles from "./ClaudeCodePage.module.scss";

/** Connects the local Claude Code CLI to Keybridge models. */
export function ClaudeCodePage() {
  const { claudeCodeHarness, claudeCodeBusy } = useAppStore();
  const integration = claudeCodeHarness?.integration ?? "disabled";
  const on = integration !== "disabled";
  const switchLabel = on ? t("Disconnect Claude Code") : t("Connect Claude Code");
  const stateLabel = integration === "enabled"
    ? t("Connected")
    : integration === "degraded" ? t("Waiting") : t("Not connected");

  const content = <div className={styles.page}>
    <Card as="section" aria-label={t("Claude Code connection")}>
      <div className={styles.row}>
        <strong>{t("Status")}</strong>
        <span className={styles.value} data-state={integration}>{stateLabel}</span>
      </div>
      {integration === "degraded" && <div className={styles.row}>
        <span className={styles.hint}>{claudeCodeHarness?.configured_models
          ? t("Claude Code is using its own settings until the External API is enabled again under Settings, Network.")
          : t("Claude Code is using its own settings until a model is added on the Providers page.")}</span>
      </div>}
      <div className={styles.row}>
        <strong>{t("Models available through Keybridge")}</strong>
        <span className={styles.value}>{claudeCodeHarness?.configured_models ?? 0}</span>
      </div>
      {claudeCodeHarness?.model && <div className={styles.row}>
        <strong>{t("Default model in Claude Code")}</strong>
        <code className={styles.value}>{claudeCodeHarness.model}</code>
      </div>}
      <div className={styles.row}>
        <strong>{t("Claude Code settings file")}</strong>
        <code className={styles.value}>{claudeCodeHarness?.config_path ?? ""}</code>
      </div>
      {claudeCodeHarness && !claudeCodeHarness.installed && <div className={styles.row}>
        <span className={styles.hint}>{t("No Claude Code folder was found on this computer. It is created when you connect.")}</span>
      </div>}
    </Card>
    <ul className={styles.notes}>
      <li>{t("Restart the Claude Code CLI after connecting or disconnecting.")}</li>
      <li>{t("The CLI uses Keybridge through the local External API, which is turned on automatically.")}</li>
      <li>{t("Your previous Claude Code model and gateway settings are restored when you disconnect or Keybridge stops.")}</li>
      <li>{t("Claude Code only shows Claude or Anthropic model IDs from gateway discovery in its model picker. You can select other Keybridge IDs by typing /model followed by the model ID.")}</li>
      <li>{t("The standalone Claude desktop app and its VS Code extension use separate gateway settings.")}</li>
    </ul>
  </div>;

  return <>
    <PageActions position="left">
      <div className={styles.actions}>
        <span className={styles.status}>{stateLabel}</span>
        <TooltipTrigger label={switchLabel}>
          <Switch
            checked={on}
            disabled={claudeCodeBusy || !claudeCodeHarness}
            label={switchLabel}
            onChange={(enabled) => void appStore.setClaudeCodeEnabled(enabled)}
          />
        </TooltipTrigger>
      </div>
    </PageActions>
    <PageContent title="Claude Code" sections={[{ key: "claude-code", estimatedHeight: 440, content }]} />
  </>;
}

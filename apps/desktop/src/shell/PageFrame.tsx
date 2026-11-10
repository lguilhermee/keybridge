import type { RefCallback } from "react";
import { useLocation } from "react-router-dom";
import { Icon } from "../shared/ui/Icon";
import { TooltipTrigger } from "../shared/ui/TooltipTrigger";
import { refreshIcon } from "../shared/ui/icons";
import controls from "../shared/ui/Controls.module.scss";
import { appStore, useAppStore } from "../shared/store/appStore";
import styles from "./PageFrame.module.scss";

type PageFrameProps = {
  titleRef: RefCallback<HTMLDivElement>;
  leftActionsRef: RefCallback<HTMLDivElement>;
  rightActionsRef: RefCallback<HTMLDivElement>;
};

export function PageFrame({ titleRef, leftActionsRef, rightActionsRef }: PageFrameProps) {
  const { busy } = useAppStore();
  const location = useLocation();

  return <header className={styles.bar} data-tauri-drag-region>
    <div ref={titleRef} className={styles.title} />
    <div ref={leftActionsRef} className={styles.actions} />
    <div className={styles.spacer} />
    <div ref={rightActionsRef} className={styles.actions} />
    {location.pathname !== "/" && <TooltipTrigger label={t("Refresh")}>
      <button className={[controls.iconButton, styles.noDrag].join(" ")} aria-label={t("Refresh")} disabled={busy} onClick={() => void appStore.refresh()}>
        <Icon className={busy ? controls.spin : ""} icon={refreshIcon} size="1.1em" />
      </button>
    </TooltipTrigger>}
    <ProxyStatus />
  </header>;
}

function ProxyStatus() {
  const { ports, cursorHarness } = useAppStore();
  const proxyUrl = cursorHarness?.settings_applied ? cursorHarness.proxy_url : null;
  const endpoint = proxyUrl?.replace(/^https?:\/\//, "") || `127.0.0.1:${ports.proxy_port}`;

  return <TooltipTrigger label={proxyUrl ? `${t("Local proxy")}: ${endpoint}` : t("Local proxy is not configured")}>
    <div className={styles.proxy}>
      <span className={styles.proxyDot} data-on={proxyUrl !== null || undefined} />
      <span className={styles.proxyEndpoint}>{endpoint}</span>
    </div>
  </TooltipTrigger>;
}

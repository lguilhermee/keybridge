import { useEffect, useState } from "react";
import { currentAppVersion, hasNativeAppLifecycle } from "../../../shared/native/appLifecycle";
import { updateStore, useUpdateStore } from "../../../shared/store/updateStore";
import { Button } from "../../../shared/ui/Button";
import { useMessage } from "../../../shared/ui/message";
import type { VirtualPageSection } from "../../../shell/layout/VirtualPage";
import { SectionCard } from "../SectionCard";
import styles from "./sections.module.scss";

export function aboutGroups(): VirtualPageSection[] {
  return [
    { key: "about", estimatedHeight: 100, content: <AboutGroup /> },
  ];
}

function AboutGroup() {
  const message = useMessage();
  const native = hasNativeAppLifecycle();
  const { availableVersion, checking, installing } = useUpdateStore();
  const [version, setVersion] = useState("...");

  useEffect(() => {
    let disposed = false;
    void currentAppVersion().then((next) => { if (!disposed) setVersion(next); });
    return () => { disposed = true; };
  }, []);

  const checkUpdate = async () => {
    try {
      const nextVersion = await updateStore.check();
      message(nextVersion ? t("Version {version} is available", { version: nextVersion }) : t("You're up to date"));
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      message(t("Failed to check for updates: {error}", { error }));
    }
  };

  const updateNow = async () => {
    try {
      await updateStore.install();
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      message(t("Failed to install update: {error}", { error }));
    }
  };

  return <SectionCard title={t("Version")}>
    <div className={styles.stackRow}>
      <div>
        <strong>{t("Software updates")}</strong>
        <small>{availableVersion
          ? t("Version {version} is ready to install", { version: availableVersion })
          : t("Current version {version}", { version })}</small>
      </div>
      {availableVersion
        ? <Button size="small" variant="primary" disabled={installing} onClick={() => void updateNow()}>
            {installing ? t("Installing...") : t("Download and install")}
            <span className={styles.updateDot} aria-hidden="true" />
          </Button>
        : <Button size="small" disabled={!native || checking} onClick={() => void checkUpdate()}>
            {checking ? t("Checking...") : t("Check for updates")}
          </Button>}
    </div>
  </SectionCard>;
}

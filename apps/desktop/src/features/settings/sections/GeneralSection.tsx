import { useEffect, useState } from "react";
import { setLocalePreference, useI18n, type LocalePreference } from "../../../i18n/store";
import {
  hasDockVisibilitySetting,
  hasNativeAppLifecycle,
  readAutostart,
  readDesktopSettings,
  writeAutostart,
  writeDockIconVisibility,
  writeSilentStart,
} from "../../../shared/native/appLifecycle";
import { appStore, useAppStore } from "../../../shared/store/appStore";
import { themeOptions } from "../../../shared/theme/theme";
import { useMessage } from "../../../shared/ui/message";
import { Select } from "../../../shared/ui/Select";
import { Switch } from "../../../shared/ui/Switch";
import type { VirtualPageSection } from "../../../shell/layout/VirtualPage";
import { SectionCard } from "../SectionCard";
import styles from "./sections.module.scss";

export function generalGroups(): VirtualPageSection[] {
  return [
    { key: "language", estimatedHeight: 100, content: <LanguageGroup /> },
    { key: "theme", estimatedHeight: 90, content: <ThemeGroup /> },
    { key: "startup", estimatedHeight: 180, content: <StartupTrayGroup /> },
  ];
}

function LanguageGroup() {
  const { preference, locale } = useI18n();
  return <SectionCard title={t("Language")}>
    <div className={styles.stackRow}>
      <div>
        <strong>{t("Display language")}</strong>
        <small>{t("Uses the operating system language by default; unsupported languages fall back to English. Current: {language}", { language: locale === "zh-CN" ? "Simplified Chinese" : locale === "pt-BR" ? "Portuguese (Brazil)" : "English" })}</small>
      </div>
      <div className={styles.control}>
        <Select
          value={preference}
          ariaLabel={t("Display language")}
          options={[
            { value: "system", label: t("Use system language") },
            { value: "zh-CN", label: "Simplified Chinese" },
            { value: "en-US", label: "English" },
            { value: "pt-BR", label: "Portuguese (Brazil)" },
          ]}
          onChange={(value) => setLocalePreference(value as LocalePreference)}
        />
      </div>
    </div>
  </SectionCard>;
}

function ThemeGroup() {
  const { theme } = useAppStore();
  return <SectionCard title={t("Theme")}>
    <div className={styles.themeActions}>
      {themeOptions.map(({ id }) => (
        <button
          className={theme === id ? styles.selected : ""}
          key={id}
          onClick={() => appStore.selectTheme(id)}
        >
          {id === "default-dark" ? t("Default dark") : t("Default light")}
        </button>
      ))}
    </div>
  </SectionCard>;
}

function StartupTrayGroup() {
  const message = useMessage();
  const native = hasNativeAppLifecycle();
  const dockVisibilitySetting = hasDockVisibilitySetting();
  const [autostart, setAutostart] = useState(false);
  const [loadingAutostart, setLoadingAutostart] = useState(native);
  const [silentStart, setSilentStart] = useState(false);
  const [dockIconVisible, setDockIconVisible] = useState(true);
  const [loadingDesktopSettings, setLoadingDesktopSettings] = useState(native);

  useEffect(() => {
    let disposed = false;
    if (native) {
      void readAutostart()
        .then((enabled) => { if (!disposed) setAutostart(enabled); })
        .catch((cause) => message(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => { if (!disposed) setLoadingAutostart(false); });
      void readDesktopSettings()
        .then((settings) => {
          if (disposed) return;
          setSilentStart(settings.silent_start);
          setDockIconVisible(settings.show_dock_icon);
        })
        .catch(() => {})
        .finally(() => {
          if (disposed) return;
          setLoadingDesktopSettings(false);
        });
    }
    return () => { disposed = true; };
  }, [message, native]);

  const toggleAutostart = async (enabled: boolean) => {
    try {
      setLoadingAutostart(true);
      await writeAutostart(enabled);
      setAutostart(await readAutostart());
      message(enabled ? t("Launch at login enabled") : t("Launch at login disabled"));
    } catch (cause) {
      message(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingAutostart(false);
    }
  };

  const toggleSilentStart = async (enabled: boolean) => {
    try {
      setLoadingDesktopSettings(true);
      await writeSilentStart(enabled);
      setSilentStart(enabled);
      message(enabled ? t("Silent start enabled") : t("Silent start disabled"));
    } catch (cause) {
      message(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingDesktopSettings(false);
    }
  };

  const toggleDockIcon = async (visible: boolean) => {
    try {
      setLoadingDesktopSettings(true);
      await writeDockIconVisibility(visible);
      setDockIconVisible(visible);
      message(visible ? t("Dock icon shown") : t("Dock icon hidden"));
    } catch (cause) {
      message(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingDesktopSettings(false);
    }
  };

  return <SectionCard title={t("Startup and tray")}>
    <div className={styles.stackRow}>
      <div>
        <strong>{t("Launch at login")}</strong>
        <small>{t("Start Cursor BYOK automatically after signing in.")}</small>
      </div>
      <Switch
        checked={autostart}
        disabled={!native || loadingAutostart}
        label={t("Launch at login")}
        onChange={(enabled) => void toggleAutostart(enabled)}
      />
    </div>
    {autostart && <div className={styles.stackRow}>
      <div>
        <strong>{t("Silent start")}</strong>
        <small>{t("Hide the main window on startup and keep only the tray icon.")}</small>
      </div>
      <Switch
        checked={silentStart}
        disabled={!native || loadingDesktopSettings}
        label={t("Silent start")}
        onChange={(enabled) => void toggleSilentStart(enabled)}
      />
    </div>}
    {dockVisibilitySetting && <div className={styles.stackRow}>
      <div>
        <strong>{t("Show in Dock")}</strong>
        <small>{t("Hide the Dock icon when disabled. You can still open the app from the menu bar icon.")}</small>
      </div>
      <Switch
        checked={dockIconVisible}
        disabled={loadingDesktopSettings}
        label={t("Show in Dock")}
        onChange={(visible) => void toggleDockIcon(visible)}
      />
    </div>}
  </SectionCard>;
}

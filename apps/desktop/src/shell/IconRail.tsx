import type { IconifyIcon } from "@iconify/react/offline";
import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import cursorIconUrl from "../shared/assets/icons/cursor.svg";
import { Icon } from "../shared/ui/Icon";
import { TooltipTrigger } from "../shared/ui/TooltipTrigger";
import { activityIcon, homeIcon, openAiIcon, providerIcon, searchIcon, settingsIcon } from "../shared/ui/icons";
import { useAppStore } from "../shared/store/appStore";
import { useUpdateStore } from "../shared/store/updateStore";
import styles from "./IconRail.module.scss";

type RailItem = {
  path: string;
  label: string;
  icon: IconifyIcon | string;
  badge?: "cursor" | "codex" | "update";
};

export function IconRail({ onOpenPalette }: { onOpenPalette: () => void }) {
  const { cursorHarness, codexHarness } = useAppStore();
  const { availableVersion } = useUpdateStore();
  const cursorLocal = cursorHarness?.settings_applied ?? false;
  const codexConnected = codexHarness?.integration === "enabled";
  const items: RailItem[] = [
    { path: "/", label: t("Overview"), icon: homeIcon },
    { path: "/calls", label: t("Calls"), icon: activityIcon },
    { path: "/providers", label: t("Providers"), icon: providerIcon },
    {
      path: "/cursor",
      label: cursorHarness ? `Cursor · ${cursorLocal ? t("Local: on") : t("Local: off")}` : "Cursor",
      icon: cursorIconUrl,
      badge: "cursor",
    },
    {
      path: "/codex",
      label: codexHarness ? `Codex · ${codexConnected ? t("Connected") : t("Not connected")}` : "Codex",
      icon: openAiIcon,
      badge: "codex",
    },
  ];
  const settingsLabel = availableVersion ? `${t("Settings")} · ${t("Update available")}` : t("Settings");

  return <nav className={styles.rail} aria-label={t("Main menu")}>
    <TooltipTrigger label={`${t("Command palette")} (Ctrl+K)`} placement="right">
      <button type="button" className={styles.item} aria-label={t("Command palette")} onClick={onOpenPalette}>
        <Icon icon={searchIcon} size="1.25em" />
      </button>
    </TooltipTrigger>
    <div className={styles.items}>
      {items.map((item) => <RailLink key={item.path} item={item}>
        {item.badge === "cursor" && cursorHarness && <span
          className={styles.badge}
          data-on={cursorLocal || undefined}
          title={t("Local proxy configuration only; Remote SSH is not verified.")}
        />}
        {item.badge === "codex" && codexHarness && <span className={styles.badge} data-on={codexConnected || undefined} aria-hidden="true" />}
      </RailLink>)}
    </div>
    <div className={styles.bottom}>
      <RailLink item={{ path: "/settings", label: settingsLabel, icon: settingsIcon, badge: "update" }}>
        {availableVersion && <span className={styles.badge} data-alert aria-hidden="true" />}
      </RailLink>
    </div>
  </nav>;
}

function RailLink({ item, children }: { item: RailItem; children?: ReactNode }) {
  return <TooltipTrigger label={item.label} placement="right">
    <NavLink to={item.path} end={item.path === "/"} className={styles.item}>
      {typeof item.icon === "string" ? <Icon src={item.icon} size="1.25em" /> : <Icon icon={item.icon} size="1.25em" />}
      {children}
    </NavLink>
  </TooltipTrigger>;
}

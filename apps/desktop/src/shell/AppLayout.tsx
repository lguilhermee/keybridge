import { useState } from "react";
import KeepAliveRouteOutlet from "keepalive-for-react-router";
import { useLocation } from "react-router-dom";
import { PageLayout } from "./layout/PageLayout";
import { CommandPalette } from "./CommandPalette";
import { IconRail } from "./IconRail";
import { PageFrame } from "./PageFrame";
import { PageActionsTarget } from "./PageActions";
import styles from "./AppLayout.module.scss";

const keptAlivePages = ["/", "/calls", "/providers", "/cursor", "/settings"];

export function AppLayout() {
  const location = useLocation();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [titleTarget, setTitleTarget] = useState<HTMLDivElement | null>(null);
  const [leftActionTarget, setLeftActionTarget] = useState<HTMLDivElement | null>(null);
  const [rightActionTarget, setRightActionTarget] = useState<HTMLDivElement | null>(null);
  // All settings sections share one cached page; the section switch must not
  // remount it or reset its scroll position.
  const cacheKey = location.pathname.startsWith("/settings") ? "/settings" : location.pathname;

  return <PageLayout className={styles.root}>
    <IconRail onOpenPalette={() => setPaletteOpen(true)} />
    <PageFrame titleRef={setTitleTarget} leftActionsRef={setLeftActionTarget} rightActionsRef={setRightActionTarget} />
    <main className={styles.content}>
      <PageActionsTarget.Provider value={{ title: titleTarget, left: leftActionTarget, right: rightActionTarget }}>
        <KeepAliveRouteOutlet
          activeCacheKey={cacheKey}
          include={keptAlivePages}
          max={keptAlivePages.length}
          enableActivity
          containerClassName={styles.keepAliveContainer}
          cacheNodeClassName={styles.keepAlivePage}
        />
      </PageActionsTarget.Provider>
    </main>
    <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
  </PageLayout>;
}

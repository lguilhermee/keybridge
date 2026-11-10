import { useEffect, useMemo, useRef, useState } from "react";
import { Navigate, matchPath, useLocation, useNavigate } from "react-router-dom";
import { useI18n } from "../../i18n/store";
import { Icon } from "../../shared/ui/Icon";
import { searchIcon } from "../../shared/ui/icons";
import { VirtualList } from "../../shared/virtual/VirtualList";
import type { VirtualListApi } from "../../shared/virtual/virtualTypes";
import { PageContent } from "../../shell/layout/PageContent";
import { VirtualPage, type VirtualPageSection } from "../../shell/layout/VirtualPage";
import {
  defaultSettingsSection,
  filterSettingsSearchEntries,
  isSettingsSectionId,
  settingsSearchEntries,
  settingsSectionIds,
  settingsSectionLabel,
  type SettingsSearchEntry,
  type SettingsSectionId,
} from "./sections";
import { aboutGroups } from "./sections/AboutSection";
import { cursorGroups } from "./sections/CursorSection";
import { generalGroups } from "./sections/GeneralSection";
import { networkGroups } from "./sections/NetworkSection";
import { usageDataGroups } from "./sections/UsageDataSection";
import styles from "./SettingsPage.module.scss";

const sectionGroups: Record<SettingsSectionId, () => VirtualPageSection[]> = {
  general: generalGroups,
  network: networkGroups,
  cursor: cursorGroups,
  usage: usageDataGroups,
  about: aboutGroups,
};

type NavItem =
  | { kind: "section"; id: string; section: SettingsSectionId }
  | { kind: "result"; id: string; entry: SettingsSearchEntry };

export function SettingsPage() {
  // Every settings section shares one kept-alive page, and the cached route
  // element keeps the params of the section that mounted it. The location is
  // the only route state that stays current, so the section is read from it.
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const sectionParam = matchPath("/settings/:section", pathname)?.params.section;
  const valid = isSettingsSectionId(sectionParam);
  // While another page is shown there is no section in the location; keep the last one.
  const [active, setActive] = useState<SettingsSectionId>(valid ? sectionParam : defaultSettingsSection);
  if (valid && sectionParam !== active) setActive(sectionParam);
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState<{ key: string; nonce: number } | null>(null);
  const listApi = useRef<VirtualListApi | null>(null);
  // Re-render (and rebuild the search index) when the display language changes.
  const { locale } = useI18n();

  const groups = useMemo(() => sectionGroups[active](), [active]);
  const displayGroups = useMemo(() => groups.map((group) => ({
    ...group,
    content: focus?.key === group.key ? <div className={styles.jumpTarget}>{group.content}</div> : group.content,
  })), [groups, focus]);
  const results = useMemo(() => filterSettingsSearchEntries(settingsSearchEntries(), query), [query, locale]);

  // A search jump scrolls the target group into view and flashes it. The delayed
  // second scroll corrects for rows whose measured height differs from the estimate.
  useEffect(() => {
    if (!focus) return;
    const index = groups.findIndex((group) => group.key === focus.key);
    if (index < 0) {
      setFocus(null);
      return;
    }
    listApi.current?.scrollToIndex(index);
    const resync = window.setTimeout(() => listApi.current?.scrollToIndex(index), 160);
    const clear = window.setTimeout(() => setFocus(null), 2000);
    return () => {
      window.clearTimeout(resync);
      window.clearTimeout(clear);
    };
  }, [focus, groups]);

  if (sectionParam !== undefined && !valid) return <Navigate to={`/settings/${defaultSettingsSection}`} replace />;

  const jumpTo = (entry: SettingsSearchEntry) => {
    setFocus({ key: entry.group, nonce: Date.now() });
    if (entry.section !== active) navigate(`/settings/${entry.section}`);
  };

  const items: NavItem[] = query.trim()
    ? results.map((entry) => ({ kind: "result", id: entry.id, entry }))
    : settingsSectionIds.map((section) => ({ kind: "section", id: `section:${section}`, section }));

  const content = (
    <div className={styles.pageBody}>
      <div className={styles.layout}>
        <nav className={styles.listPane} aria-label={t("Settings")}>
          <div className={styles.searchBox}>
            <Icon icon={searchIcon} size="1em" />
            <input
              value={query}
              placeholder={t("Search settings")}
              aria-label={t("Search settings")}
              spellCheck={false}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && query) {
                  event.preventDefault();
                  setQuery("");
                }
                if (event.key === "Enter" && results[0]) {
                  event.preventDefault();
                  jumpTo(results[0]);
                }
              }}
            />
          </div>
          <VirtualList
            items={items}
            itemKey={(item) => item.id}
            estimatedItemHeight={40}
            className={styles.navList}
            empty={<div className={styles.listEmpty}>{t("No results")}</div>}
          >
            {(item) => item.kind === "section" ? (
              <button
                type="button"
                className={`${styles.navItem} ${item.section === active ? styles.navItemActive : ""}`}
                aria-current={item.section === active ? "page" : undefined}
                onClick={() => navigate(`/settings/${item.section}`)}
              >
                {settingsSectionLabel(item.section)}
              </button>
            ) : (
              <button type="button" className={styles.resultItem} onClick={() => jumpTo(item.entry)}>
                <span className={styles.resultLabel}>{item.entry.label}</span>
                <span className={styles.resultMeta}>
                  {settingsSectionLabel(item.entry.section)}{item.entry.description ? ` · ${item.entry.description}` : ""}
                </span>
              </button>
            )}
          </VirtualList>
        </nav>
        <div className={styles.detailPane}>
          <VirtualPage sections={displayGroups} onReady={(api) => { listApi.current = api; }} />
        </div>
      </div>
    </div>
  );
  return <PageContent title={t("Settings")} fixed sections={[{ key: "settings", estimatedHeight: 0, content }]} />;
}

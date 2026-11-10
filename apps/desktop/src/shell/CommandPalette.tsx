import { autoUpdate, computePosition, offset, shift, size, type VirtualElement } from "@floating-ui/dom";
import type { IconifyIcon } from "@iconify/react/offline";
import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import cursorIconUrl from "../shared/assets/icons/cursor.svg";
import { configuredProviderModels } from "../shared/api";
import { useAppStore } from "../shared/store/appStore";
import { Icon } from "../shared/ui/Icon";
import { activityIcon, claudeIcon, homeIcon, openAiIcon, providerIcon, searchIcon, settingsIcon } from "../shared/ui/icons";
import { VirtualList } from "../shared/virtual/VirtualList";
import type { VirtualListApi } from "../shared/virtual/virtualTypes";
import { settingsSectionIds, settingsSectionLabel } from "../features/settings/sections";
import styles from "./CommandPalette.module.scss";

type PaletteEntry = {
  id: string;
  group: string;
  label: string;
  keywords?: string;
  icon?: IconifyIcon | string;
  run: () => void;
};

type PaletteRow =
  | { kind: "group"; id: string; label: string }
  | { kind: "item"; id: string; index: number; entry: PaletteEntry };

function scoreEntry(query: string, entry: PaletteEntry): number | null {
  if (!query) return 0;
  const target = `${entry.label} ${entry.keywords ?? ""}`.toLowerCase();
  const lowered = query.toLowerCase();
  const index = target.indexOf(lowered);
  if (index === 0) return index;
  if (index > 0) return 20 + index;
  let consumed = 0;
  for (let position = 0; position < target.length && consumed < lowered.length; position += 1) {
    if (target[position] === lowered[consumed]) consumed += 1;
  }
  return consumed === lowered.length ? 60 : null;
}

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: Dispatch<SetStateAction<boolean>> }) {
  const { providers, models } = useAppStore();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [maxHeight, setMaxHeight] = useState(360);
  const menuRef = useRef<HTMLDivElement>(null);
  const listApi = useRef<VirtualListApi | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpenChange((current) => !current);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onOpenChange]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  const go = (path: string) => () => {
    onOpenChange(false);
    navigate(path);
  };
  const providerModels = configuredProviderModels(providers);
  const entries: PaletteEntry[] = [
    { id: "page-overview", group: t("Pages"), label: t("Overview"), icon: homeIcon, run: go("/") },
    { id: "page-calls", group: t("Pages"), label: t("Calls"), icon: activityIcon, run: go("/calls") },
    { id: "page-providers", group: t("Pages"), label: t("Providers"), icon: providerIcon, run: go("/providers") },
    { id: "page-cursor", group: t("Pages"), label: "Cursor", icon: cursorIconUrl, run: go("/cursor") },
    { id: "page-codex", group: t("Pages"), label: "Codex", icon: openAiIcon, run: go("/codex") },
    { id: "page-settings", group: t("Pages"), label: t("Settings"), icon: settingsIcon, run: go("/settings") },
    ...settingsSectionIds.map((section) => ({
      id: `section-${section}`,
      group: t("Settings"),
      label: settingsSectionLabel(section),
      icon: settingsIcon,
      keywords: section,
      run: go(`/settings/${section}`),
    })),
    ...providers.map((provider) => ({
      id: `provider-${provider.id}`,
      group: t("Providers"),
      label: provider.name,
      icon: provider.icon || providerIcon,
      run: go("/providers"),
    })),
    ...models.map((model) => ({
      id: `model-${model.model_hash}`,
      group: t("Models"),
      label: model.display_name,
      keywords: model.model_id,
      icon: model.type === "anthropic" ? claudeIcon : openAiIcon,
      run: go("/providers"),
    })),
    ...providerModels.map((model) => ({
      id: `provider-model-${model.id}`,
      group: t("Models"),
      label: model.displayName,
      keywords: model.modelId,
      icon: model.icon || providerIcon,
      run: go("/providers"),
    })),
  ];

  const results = entries
    .map((entry) => ({ entry, score: scoreEntry(query.trim(), entry) }))
    .filter((result): result is { entry: PaletteEntry; score: number } => result.score !== null)
    .sort((left, right) => left.score - right.score)
    .map((result) => result.entry);

  const rows: PaletteRow[] = [];
  let lastGroup = "";
  results.forEach((entry, index) => {
    if (entry.group !== lastGroup) {
      rows.push({ kind: "group", id: `group-${entry.group}`, label: entry.group });
      lastGroup = entry.group;
    }
    rows.push({ kind: "item", id: entry.id, index, entry });
  });

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!open || !menu) return;
    const anchor: VirtualElement = {
      getBoundingClientRect: () => {
        const centerX = window.innerWidth / 2;
        const top = Math.round(window.innerHeight * 0.14);
        return { x: centerX, y: top, top, left: centerX, right: centerX, bottom: top, width: 0, height: 0 };
      },
    };
    return autoUpdate(anchor, menu, () => void computePosition(anchor, menu, {
      placement: "bottom",
      middleware: [
        offset(0),
        shift({ padding: 12 }),
        size({ padding: 12, apply: ({ availableHeight }) => setMaxHeight(Math.max(200, availableHeight - 8)) }),
      ],
    }).then(({ x, y }) => {
      menu.style.left = `${x}px`;
      menu.style.top = `${y}px`;
    }));
  }, [open]);

  useEffect(() => {
    if (!open || !results.length) return;
    const rowIndex = rows.findIndex((row) => row.kind === "item" && row.index === active);
    if (rowIndex >= 0) listApi.current?.scrollToIndex(rowIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, open]);

  if (!open) return null;

  const choose = (entry: PaletteEntry) => entry.run();
  return createPortal(
    <div className={styles.overlay} onPointerDown={() => onOpenChange(false)}>
      <div
        ref={menuRef}
        className={styles.palette}
        role="dialog"
        aria-label={t("Command palette")}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); onOpenChange(false); }
          if (event.key === "ArrowDown") { event.preventDefault(); setActive((index) => results.length ? (index + 1) % results.length : 0); }
          if (event.key === "ArrowUp") { event.preventDefault(); setActive((index) => results.length ? (index - 1 + results.length) % results.length : 0); }
          if (event.key === "Enter" && results[active]) { event.preventDefault(); choose(results[active]); }
        }}
      >
        <div className={styles.inputRow}>
          <Icon icon={searchIcon} size="1.1em" />
          <input
            autoFocus
            value={query}
            placeholder={t("Search pages, providers, models, and settings")}
            aria-label={t("Command palette")}
            onChange={(event) => { setQuery(event.target.value); setActive(0); }}
          />
        </div>
        <VirtualList
          items={rows}
          itemKey={(row) => row.id}
          estimatedItemHeight={34}
          className={styles.results}
          style={{ maxHeight }}
          onReady={(api) => { listApi.current = api; }}
          empty={<div className={styles.empty}>{t("No results")}</div>}
        >
          {(row) => row.kind === "group"
            ? <div className={styles.group}>{row.label}</div>
            : <button
                type="button"
                className={styles.item}
                data-active={row.index === active || undefined}
                onMouseEnter={() => setActive(row.index)}
                onClick={() => choose(row.entry)}
              >
                {typeof row.entry.icon === "string" ? <Icon src={row.entry.icon} size="1.2em" /> : <Icon icon={row.entry.icon} size="1.2em" />}
                <span className={styles.itemLabel}>{row.entry.label}</span>
              </button>}
        </VirtualList>
      </div>
    </div>,
    document.body,
  );
}

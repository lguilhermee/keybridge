import { autoUpdate, computePosition, flip, offset, shift, size } from "@floating-ui/dom";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconProps } from "./Icon";
import { checkIcon, chevronDownIcon, searchIcon, windowCloseIcon } from "./icons";
import { VirtualList } from "../virtual/VirtualList";
import styles from "./ModelSelect.module.scss";

export type ModelSelectOption = {
  value: string;
  label: string;
  group: string;
  icon?: IconProps["icon"];
  iconSrc?: string;
};

type ModelSelectProps = {
  label: string;
  options: ModelSelectOption[];
  disabled?: boolean;
} & (
  | { mode: "single"; value: string; onChange: (value: string) => void }
  | { mode: "multiple"; value: string[]; onChange: (value: string[]) => void }
);

type MenuItem =
  | { kind: "group"; key: string; label: string; options: ModelSelectOption[] }
  | { kind: "option"; key: string; option: ModelSelectOption };

function groupedItems(options: ModelSelectOption[]): MenuItem[] {
  const groups = new Map<string, ModelSelectOption[]>();
  for (const option of options) {
    const group = groups.get(option.group);
    if (group) group.push(option);
    else groups.set(option.group, [option]);
  }
  return [...groups].flatMap(([group, groupOptions]) => [
    { kind: "group" as const, key: `group:${group}`, label: group, options: groupOptions },
    ...groupOptions.map((option) => ({ kind: "option" as const, key: `option:${option.value}`, option })),
  ]);
}

function filterModelOptions(options: ModelSelectOption[], query: string): ModelSelectOption[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return options;
  return options.filter((option) => {
    const haystack = `${option.label} ${option.group} ${option.value}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

function GroupCheckbox({ label, options, selected, onChange }: {
  label: string;
  options: ModelSelectOption[];
  selected: Set<string>;
  onChange: (checked: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const selectedCount = options.filter((option) => selected.has(option.value)).length;
  const checked = selectedCount === options.length;
  const indeterminate = selectedCount > 0 && !checked;

  useEffect(() => {
    if (input.current) input.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return <label className={styles.group}>
    <input
      ref={input}
      type="checkbox"
      checked={checked}
      aria-checked={indeterminate ? "mixed" : checked}
      onChange={(event) => onChange(event.target.checked)}
    />
    <span className={styles.checkbox} data-indeterminate={indeterminate || undefined} aria-hidden="true">
      {checked && <Icon icon={checkIcon} size="0.875em" />}
    </span>
    <span>{label}</span>
  </label>;
}

export function ModelSelect(props: ModelSelectProps) {
  const { label, options, disabled, mode } = props;
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const firstOption = useRef<HTMLLabelElement>(null);
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState({ left: 0, top: 0, width: 280, maxHeight: 320 });
  const showSearch = options.length > 6;
  const filteredOptions = useMemo(() => filterModelOptions(options, query), [options, query]);
  const items = useMemo(() => groupedItems(filteredOptions), [filteredOptions]);
  const selected = useMemo(
    () => new Set(mode === "multiple" ? props.value : [props.value]),
    [mode, props.value],
  );

  useLayoutEffect(() => {
    if (!open || !root.current || !menu.current) return;
    return autoUpdate(root.current, menu.current, () => void computePosition(root.current!, menu.current!, {
      placement: "bottom-start",
      middleware: [offset(5), flip({ padding: 10 }), shift({ padding: 10 }), size({
        padding: 10,
        apply: ({ rects, availableHeight }) => setPosition((current) => ({
          ...current,
          width: Math.max(rects.reference.width, 280),
          maxHeight: Math.max(160, Math.min(420, availableHeight)),
        })),
      })],
    }).then(({ x, y }) => setPosition((current) => ({ ...current, left: x, top: y }))));
  }, [open]);

  const close = () => {
    setOpen(false);
    setQuery("");
    trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    if (showSearch) searchInput.current?.focus();
    else firstOption.current?.focus();
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !menu.current?.contains(target)) close();
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open, showSearch]);

  const summary = mode === "multiple"
    ? props.value.length === 0 ? t("All") : t("{count} selected", { count: props.value.length })
    : options.find((option) => option.value === props.value)?.label ?? props.value;

  const choose = (option: ModelSelectOption) => {
    if (mode === "single") {
      props.onChange(option.value);
      close();
      return;
    }
    props.onChange(selected.has(option.value)
      ? props.value.filter((item) => item !== option.value)
      : [...props.value, option.value]);
  };

  const toggleGroup = (groupOptions: ModelSelectOption[], checked: boolean) => {
    if (mode !== "multiple") return;
    const groupValues = new Set(groupOptions.map((option) => option.value));
    props.onChange(checked
      ? [...props.value, ...groupOptions.filter((option) => !selected.has(option.value)).map((option) => option.value)]
      : props.value.filter((value) => !groupValues.has(value)));
  };

  const openMenu = () => {
    if (disabled) return;
    const width = root.current?.getBoundingClientRect().width;
    if (width) setPosition((current) => ({ ...current, width: Math.max(width, 280) }));
    setOpen(true);
  };

  const chromeHeight = (showSearch ? 36 : 0) + (mode === "multiple" && options.length > 0 ? 37 : 0) + 10;

  return <>
    <div ref={root} className={styles.target} data-open={open || undefined} data-disabled={disabled || undefined}>
      <button
        ref={trigger}
        type="button"
        className={styles.trigger}
        disabled={disabled}
        aria-label={t("Filter: {label}, {summary}", { label, summary })}
        aria-haspopup="listbox"
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        onClick={() => { if (open) close(); else openMenu(); }}
        onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); openMenu(); } }}
      >
        <span>{label}</span><span className={styles.summary} aria-hidden="true">{summary}</span><Icon icon={chevronDownIcon} size="1.1em" />
      </button>
      {mode === "multiple" && props.value.length > 0 && <button
        type="button"
        className={styles.clear}
        aria-label={t("Clear {label} filter", { label })}
        onClick={() => props.onChange([])}
      ><Icon icon={windowCloseIcon} size="1.1em" /></button>}
    </div>
    {open && createPortal(<div
      id={menuId}
      ref={menu}
      data-floating-menu=""
      className={styles.menu}
      aria-label={label}
      style={position}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (query) setQuery("");
          else close();
        }
      }}
    >
      {showSearch && <div className={styles.searchBox}>
        <Icon icon={searchIcon} size="1em" />
        <input
          ref={searchInput}
          value={query}
          placeholder={t("Search models")}
          aria-label={t("Search models")}
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && mode === "single" && filteredOptions[0]) {
              event.preventDefault();
              choose(filteredOptions[0]);
            }
          }}
        />
        {query && <button
          type="button"
          className={styles.searchClear}
          aria-label={t("Clear search")}
          onClick={() => {
            setQuery("");
            searchInput.current?.focus();
          }}
        ><Icon icon={windowCloseIcon} size="0.95em" /></button>}
      </div>}
      <div
        className={styles.listFrame}
        role="listbox"
        aria-label={label}
        aria-multiselectable={mode === "multiple" ? "true" : undefined}
        style={{ height: Math.min(Math.max(1, items.length) * 32, Math.max(32, position.maxHeight - chromeHeight)) }}
      ><VirtualList
          items={items}
          itemKey="key"
          className={styles.list}
          style={{ height: "100%" }}
          estimatedItemHeight={32}
          overscan={4}
          empty={<div className={styles.empty}>{t("No results")}</div>}
        >{(item, index) => item.kind === "group"
          ? mode === "multiple"
            ? <GroupCheckbox
                label={item.label}
                options={item.options}
                selected={selected}
                onChange={(checked) => toggleGroup(item.options, checked)}
              />
            : <div className={styles.groupLabel}>{item.label}</div>
          : <label
              ref={index === 1 ? firstOption : undefined}
              className={styles.optionRow}
              role="option"
              aria-selected={selected.has(item.option.value)}
              tabIndex={index === 1 ? 0 : -1}
              onKeyDown={(event) => {
                if (event.key === " " || event.key === "Enter") {
                  event.preventDefault();
                  choose(item.option);
                }
              }}
            >
              <input
                type="checkbox"
                checked={selected.has(item.option.value)}
                tabIndex={-1}
                onChange={() => choose(item.option)}
              />
              <span className={styles.checkbox} aria-hidden="true">
                {selected.has(item.option.value) && <Icon icon={checkIcon} size="0.875em" />}
              </span>
              <span className={styles.option}>
                {(item.option.icon || item.option.iconSrc) && <Icon icon={item.option.icon} src={item.option.iconSrc} />}
                <span>{item.option.label}</span>
              </span>
            </label>}</VirtualList></div>
      {mode === "multiple" && options.length > 0 && <div className={styles.footer}>
        <button
          type="button"
          onClick={() => toggleGroup(filteredOptions, true)}
        >{t("Select all")}</button>
        <button
          type="button"
          onClick={() => query ? toggleGroup(filteredOptions, false) : props.onChange([])}
        >{t("Deselect all")}</button>
      </div>}
    </div>, document.body)}
  </>;
}

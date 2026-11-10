import { useCallback, useEffect, useMemo, useState } from "react";
import cursorIconUrl from "../../../shared/assets/icons/cursor.svg";
import { api, type CommitSettingsView, type HeadroomStatus, type TabMode, type TabSettings } from "../../../shared/api";
import { commitPromptLocale } from "../../../i18n/runtime";
import { useI18n } from "../../../i18n/store";
import { useAppStore } from "../../../shared/store/appStore";
import { Button } from "../../../shared/ui/Button";
import { Icon } from "../../../shared/ui/Icon";
import { useMessage } from "../../../shared/ui/message";
import { Modal } from "../../../shared/ui/Modal";
import { ModelSelect, type ModelSelectOption } from "../../../shared/ui/ModelSelect";
import { Select } from "../../../shared/ui/Select";
import { Switch } from "../../../shared/ui/Switch";
import { TextInput } from "../../../shared/ui/FormControls";
import controls from "../../../shared/ui/Controls.module.scss";
import { configuredModelOptions } from "../../../shared/utils/configuredModelOptions";
import type { VirtualPageSection } from "../../../shell/layout/VirtualPage";
import { SectionCard } from "../SectionCard";
import { RefusalFallbackGroup } from "./RefusalFallbackGroup";
import styles from "./sections.module.scss";

function errorText(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

export function cursorGroups(): VirtualPageSection[] {
  return [
    { key: "tab", estimatedHeight: 120, content: <TabGroup /> },
    { key: "commit", estimatedHeight: 110, content: <CommitGroup /> },
    { key: "refusal", estimatedHeight: 160, content: <RefusalFallbackGroup /> },
    { key: "headroom", estimatedHeight: 210, content: <HeadroomGroup /> },
  ];
}

function TabGroup() {
  const message = useMessage();
  const [settings, setSettings] = useState<TabSettings | null>(null);
  const [draft, setDraft] = useState<TabSettings>({ mode: "public", address: "" });
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void api.tabSettings().then((next) => {
      setSettings(next);
      setDraft(next);
    }).catch((cause: unknown) => message(cause instanceof Error ? cause.message : String(cause)));
  }, [message]);

  const edit = () => {
    if (!settings) return;
    setDraft(settings);
    setEditing(true);
  };

  const cancel = () => {
    if (settings) setDraft(settings);
    setEditing(false);
  };

  const save = async () => {
    try {
      if (draft.mode === "custom" && !draft.address.trim()) throw new Error(t("TAB service address is required"));
      setSaving(true);
      const saved = await api.setTabSettings({ ...draft, address: draft.address.trim() });
      setSettings(saved);
      setDraft(saved);
      setEditing(false);
      message(t("TAB settings saved"));
    } catch (cause) {
      message(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const modeLabel = (mode: TabMode) => {
    if (mode === "public") return t("Use public service");
    if (mode === "direct") return t("Direct");
    return t("Custom");
  };
  const action = editing ? (
    <div className={styles.actions}>
      <Button size="small" disabled={saving} onClick={cancel}>{t("Cancel")}</Button>
      <Button variant="primary" size="small" disabled={saving} onClick={() => void save()}>{saving ? t("Saving...") : t("Save")}</Button>
    </div>
  ) : (
    <button type="button" className={styles.textAction} disabled={!settings} onClick={edit}>{t("Edit")}</button>
  );

  return <SectionCard
    title={<div className={styles.cardTitle}><Icon src={cursorIconUrl} size="1.1em" /><span>{t("TAB settings")}</span></div>}
    action={action}
  >
    <div className={styles.content}>
      {editing ? <>
        <div className={styles.row}>
          <div className={styles.description}>
            <strong>{t("TAB connection")}</strong>
            <small>{t("Choose how Cursor connects to TAB endpoints.")}</small>
          </div>
          <div className={styles.control}><Select
            value={draft.mode}
            ariaLabel={t("TAB connection")}
            options={[
              { value: "public", label: t("Use public service") },
              { value: "direct", label: t("Direct") },
              { value: "custom", label: t("Custom") },
            ]}
            onChange={(mode) => setDraft({ ...draft, mode: mode as TabMode })}
          /></div>
        </div>
        {draft.mode === "custom" && <div className={styles.row}>
          <div className={styles.description}>
            <strong>{t("TAB service address")}</strong>
            <small>{t("The original endpoint path is appended to this service address.")}</small>
          </div>
          <div className={styles.control}><TextInput
            value={draft.address}
            placeholder="https://tab.leokun.cn"
            aria-label={t("TAB service address")}
            onChange={(event) => setDraft({ ...draft, address: event.target.value })}
            onKeyDown={(event) => { if (event.key === "Enter") void save(); }}
          /></div>
        </div>}
      </> : <>
        <div className={styles.row}>
          <strong>{t("TAB connection")}</strong>
          <span className={styles.value}>{settings ? modeLabel(settings.mode) : t("Loading...")}</span>
        </div>
        {settings?.mode === "custom" && <div className={styles.row}>
          <strong>{t("TAB service address")}</strong>
          <span className={styles.value}>{settings.address}</span>
        </div>}
      </>}
    </div>
  </SectionCard>;
}

function CommitGroup() {
  const { models, providers } = useAppStore();
  const { locale } = useI18n();
  const message = useMessage();
  const [view, setView] = useState<CommitSettingsView | null>(null);
  const [modelDraft, setModelDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [savingModel, setSavingModel] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptDraft, setPromptDraft] = useState("");
  const [savingPrompt, setSavingPrompt] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        let loaded = await api.commitSettings(locale);
        const promptLocale = commitPromptLocale(locale);
        if (!loaded.prompt.trim() && loaded.prompt_locale !== promptLocale) {
          loaded = await api.setCommitSettings({
            model_id: loaded.model_id,
            prompt: "",
            prompt_locale: promptLocale,
          });
        }
        if (active) {
          setView(loaded);
          setModelDraft(loaded.model_id);
        }
      } catch (cause) {
        if (active) message(errorText(cause));
      }
    })();
    return () => {
      active = false;
    };
  }, [locale, message]);

  const modelOptions = useMemo(() => {
    const options: ModelSelectOption[] = [
      { value: "", label: t("Direct"), group: "Cursor" },
      ...configuredModelOptions(models, providers, locale),
    ];
    if (view?.model_id && !options.some((option) => option.value === view.model_id)) {
      options.push({ value: view.model_id, label: view.model_id, group: "Cursor" });
    }
    return options;
  }, [locale, models, providers, view]);

  const persist = useCallback(
    async (modelId: string, prompt: string) => {
      if (!view) return null;
      const normalizedPrompt =
        prompt.trim() === view.default_prompt.trim() ? "" : prompt.trim();
      return api.setCommitSettings({
        model_id: modelId,
        prompt: normalizedPrompt,
        prompt_locale: commitPromptLocale(locale),
      });
    },
    [view, locale],
  );

  const editModel = useCallback(() => {
    if (!view) return;
    setModelDraft(view.model_id);
    setEditing(true);
  }, [view]);

  const cancelModelEdit = useCallback(() => {
    setModelDraft(view?.model_id ?? "");
    setEditing(false);
  }, [view]);

  const saveModel = useCallback(async () => {
    if (!view) return;
    setSavingModel(true);
    try {
      const saved = await persist(modelDraft, view.prompt);
      if (saved) {
        setView(saved);
        setModelDraft(saved.model_id);
        setEditing(false);
      }
    } catch (cause) {
      message(errorText(cause));
    } finally {
      setSavingModel(false);
    }
  }, [modelDraft, view, persist, message]);

  const openPrompt = useCallback(() => {
    if (!view) return;
    setPromptDraft(view.prompt || view.default_prompt);
    setPromptOpen(true);
  }, [view]);

  const savePrompt = useCallback(async () => {
    if (!view) return;
    setSavingPrompt(true);
    try {
      const saved = await persist(view.model_id, promptDraft);
      if (saved) setView(saved);
      setPromptOpen(false);
      message(t("Prompt settings saved"));
    } catch (cause) {
      message(errorText(cause));
    } finally {
      setSavingPrompt(false);
    }
  }, [view, promptDraft, persist, message]);

  const resetPrompt = useCallback(() => {
    if (!view) return;
    setPromptDraft(view.default_prompt);
  }, [view]);

  const selectedModelLabel = modelOptions.find((option) => option.value === view?.model_id)?.label
    ?? view?.model_id
    ?? t("Loading...");
  const action = editing ? (
    <div className={styles.actions}>
      <Button size="small" disabled={savingModel} onClick={cancelModelEdit}>{t("Cancel")}</Button>
      <Button variant="primary" size="small" disabled={savingModel} onClick={() => void saveModel()}>
        {savingModel ? t("Saving...") : t("Save")}
      </Button>
    </div>
  ) : (
    <div className={styles.actions}>
      <button type="button" className={styles.textAction} disabled={!view} onClick={openPrompt}>
        {t("Prompt settings")}
      </button>
      <button type="button" className={styles.textAction} disabled={!view} onClick={editModel}>
        {t("Edit")}
      </button>
    </div>
  );

  return (
    <>
      <SectionCard title={t("Commit Message Model Settings")} action={action}>
        <div className={styles.content}>
          <div className={styles.row}>
            <div className={styles.description}>
              <strong>{t("Generation model")}</strong>
            </div>
            {editing ? <div className={styles.control}>
              <ModelSelect
                mode="single"
                value={modelDraft}
                options={modelOptions}
                disabled={savingModel}
                label={t("Generation model")}
                onChange={setModelDraft}
              />
            </div> : <span className={styles.value}>{selectedModelLabel}</span>}
          </div>
        </div>
      </SectionCard>

      <Modal
        open={promptOpen}
        title={t("Prompt settings")}
        wide
        fullHeight
        busy={savingPrompt}
        onClose={() => setPromptOpen(false)}
        onSubmit={() => void savePrompt()}
        submitLabel={t("Save")}
        closeLabel={t("Cancel")}
        secondaryAction={
          <button type="button" className={controls.secondary} onClick={resetPrompt}>
            {t("Restore default")}
          </button>
        }
      >
        <textarea
          className={styles.promptEditor}
          value={promptDraft}
          spellCheck={false}
          aria-label={t("Commit message prompt")}
          onChange={(event) => setPromptDraft(event.target.value)}
        />
      </Modal>
    </>
  );
}

function headroomStateLabel(status: HeadroomStatus): string {
  switch (status.state) {
    case "running": return t("Running");
    case "starting": return t("Starting");
    case "failed": return t("Failed to start");
    case "not_installed": return t("Not installed");
    default: return t("Disabled");
  }
}

function HeadroomGroup() {
  const message = useMessage();
  const [status, setStatus] = useState<HeadroomStatus | null>(null);
  const [port, setPort] = useState("8787");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    void api.headroomSettings()
      .then((next) => {
        setStatus(next);
        setPort(String(next.port));
      })
      .catch((cause) => message(cause instanceof Error ? cause.message : String(cause)));
  }, [message]);

  const report = (cause: unknown) =>
    message(cause instanceof Error ? cause.message : String(cause));

  const save = async (enabled: boolean, nextPort: number) => {
    setSaving(true);
    try {
      const next = await api.setHeadroomSettings({ enabled, port: nextPort });
      setStatus(next);
      setPort(String(next.port));
      setEditing(false);
    } catch (cause) {
      report(cause);
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (enabled: boolean) => {
    if (!status) return;
    await save(enabled, status.port);
  };

  const savePort = async () => {
    const parsed = Number(port);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      message(t("Port must be an integer between 1 and 65535"));
      return;
    }
    if (!status) return;
    await save(status.enabled, parsed);
  };

  const install = async () => {
    setInstalling(true);
    try {
      setStatus(await api.installHeadroom());
    } catch (cause) {
      report(cause);
    } finally {
      setInstalling(false);
    }
  };

  const busy = saving || installing || status?.installing === true;

  return <SectionCard
    title="Headroom"
    action={editing ? (
      <div className={styles.actions}>
        <Button size="small" disabled={busy} onClick={() => { setEditing(false); if (status) setPort(String(status.port)); }}>{t("Cancel")}</Button>
        <Button variant="primary" size="small" disabled={busy} onClick={() => void savePort()}>{saving ? t("Saving...") : t("Save")}</Button>
      </div>
    ) : (
      <button type="button" className={styles.textAction} disabled={!status} onClick={() => setEditing(true)}>{t("Edit")}</button>
    )}
  >
    <div className={styles.stackRow}>
      <div>
        <strong>{t("Enable Headroom")}</strong>
        <small>{t("Compress request context sent to models through the Headroom proxy; requests are sent unchanged when it is not installed or unavailable.")}</small>
      </div>
      <Switch
        label={t("Enable Headroom")}
        checked={status?.enabled ?? false}
        disabled={!status || busy}
        onChange={(checked) => void toggle(checked)}
      />
    </div>
    <div className={styles.stackRow}>
      <div>
        <strong>{t("Local port")}</strong>
        <small>{t("Local port the Headroom proxy listens on.")}</small>
      </div>
      {editing
        ? <TextInput
          type="number" min={1} max={65535} step={1}
          value={port}
          onChange={(event) => setPort(event.target.value)}
        />
        : <span className={styles.value}>{status?.port ?? "..."}</span>}
    </div>
    <div className={styles.stackRow}>
      <div>
        <strong>{t("Status")}</strong>
        {status?.detail && <small>{status.detail}</small>}
      </div>
      <span className={styles.value} data-state={status?.state}>
        {status ? headroomStateLabel(status) : t("Loading...")}
      </span>
    </div>
    {status?.state === "not_installed" && <div className={styles.stackRow}>
      <div>
        <strong>{t("Install Headroom")}</strong>
        <small>{t("Install the headroom-ai[proxy] CLI via uv or pipx.")}</small>
      </div>
      <Button size="small" disabled={busy} onClick={() => void install()}>
        {busy ? t("Installing...") : t("Install")}
      </Button>
    </div>}
  </SectionCard>;
}

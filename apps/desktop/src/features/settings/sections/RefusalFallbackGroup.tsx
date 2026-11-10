import { useEffect, useMemo, useState } from "react";
import { api, type RefusalFallback } from "../../../shared/api";
import { useI18n } from "../../../i18n/store";
import { useAppStore } from "../../../shared/store/appStore";
import { Button } from "../../../shared/ui/Button";
import { Checkbox } from "../../../shared/ui/Checkbox";
import { useMessage } from "../../../shared/ui/message";
import { ModelSelect } from "../../../shared/ui/ModelSelect";
import { configuredModelOptions } from "../../../shared/utils/configuredModelOptions";
import { SectionCard } from "../SectionCard";
import styles from "./sections.module.scss";

/** Refusing model id -> refusal model id. */
type Fallbacks = Map<string, string>;

function fallbackMap(fallbacks: RefusalFallback[]): Fallbacks {
  return new Map(fallbacks.map((fallback) => [fallback.model_id, fallback.fallback_model_id]));
}

function errorText(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Per model: when it refuses, send that request and the rest of its run to another model. */
export function RefusalFallbackGroup() {
  const { models, providers } = useAppStore();
  const { locale } = useI18n();
  const message = useMessage();
  const [saved, setSaved] = useState<Fallbacks | null>(null);
  const [draft, setDraft] = useState<Fallbacks>(() => new Map());
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  const options = useMemo(() => configuredModelOptions(models, providers, locale), [locale, models, providers]);
  const labels = useMemo(() => new Map(options.map((option) => [option.value, option.label])), [options]);

  // Deleting or renaming a model rewrites its fallbacks on the server, so reload with the model list.
  useEffect(() => {
    let active = true;
    void api.refusalFallbacks()
      .then((fallbacks) => { if (active) setSaved(fallbackMap(fallbacks)); })
      .catch((cause: unknown) => { if (active) message(errorText(cause)); });
    return () => {
      active = false;
    };
  }, [message, models]);

  const edit = () => {
    if (!saved) return;
    setDraft(new Map(saved));
    setEditing(true);
  };

  const toggle = (modelId: string, enabled: boolean) => {
    setDraft((current) => {
      const next = new Map(current);
      if (enabled) next.set(modelId, options.find((option) => option.value !== modelId)?.value ?? "");
      else next.delete(modelId);
      return next;
    });
  };

  const choose = (modelId: string, fallbackId: string) => {
    setDraft((current) => new Map(current).set(modelId, fallbackId));
  };

  const save = async () => {
    if (!saved) return;
    if ([...draft.values()].some((fallbackId) => !fallbackId)) {
      message(t("Choose a refusal model for every checked model"));
      return;
    }
    setSaving(true);
    try {
      const changed = [...new Set([...saved.keys(), ...draft.keys()])]
        .filter((modelId) => saved.get(modelId) !== draft.get(modelId));
      for (const modelId of changed) {
        await api.setRefusalFallback({ model_id: modelId, fallback_model_id: draft.get(modelId) ?? null });
      }
      setSaved(fallbackMap(await api.refusalFallbacks()));
      setEditing(false);
      message(t("Refusal fallback saved"));
    } catch (cause) {
      message(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  const action = editing ? (
    <div className={styles.actions}>
      <Button size="small" disabled={saving} onClick={() => setEditing(false)}>{t("Cancel")}</Button>
      <Button variant="primary" size="small" disabled={saving} onClick={() => void save()}>{saving ? t("Saving...") : t("Save")}</Button>
    </div>
  ) : (
    <button type="button" className={styles.textAction} disabled={!saved || options.length < 2} onClick={edit}>{t("Edit")}</button>
  );

  const savedRows = saved ? [...saved] : [];

  return <SectionCard title={t("Refusal fallback")} action={action}>
    <div className={styles.content}>
      <div className={styles.description}>
        <small>{t("When a checked model refuses a request, that request and the rest of its run go to the chosen refusal model. The next request starts with the original model again.")}</small>
      </div>
      {editing
        ? options.map((option) => {
          const fallbackId = draft.get(option.value);
          return <div key={option.value} className={styles.row}>
            <div className={styles.description}>
              <strong>{option.label}</strong>
              <Checkbox
                label={t("Switch on refusal")}
                checked={fallbackId !== undefined}
                disabled={saving}
                onChange={(enabled) => toggle(option.value, enabled)}
              />
            </div>
            {fallbackId !== undefined && <div className={styles.control}>
              <ModelSelect
                mode="single"
                value={fallbackId}
                options={options.filter((candidate) => candidate.value !== option.value)}
                disabled={saving}
                label={t("Refusal model")}
                onChange={(value) => choose(option.value, value)}
              />
            </div>}
          </div>;
        })
        : !saved
          ? <span className={styles.value}>{t("Loading...")}</span>
          : savedRows.length === 0
            ? <div className={styles.row}><strong>{t("Off for every model")}</strong></div>
            : savedRows.map(([modelId, fallbackId]) => <div key={modelId} className={styles.row}>
              <strong>{labels.get(modelId) ?? modelId}</strong>
              <span className={styles.value}>{t("On refusal: {model}", { model: labels.get(fallbackId) ?? fallbackId })}</span>
            </div>)}
    </div>
  </SectionCard>;
}

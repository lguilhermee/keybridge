import { useMemo, useState } from "react";
import type { Combo, ComboInput, ComboStrategy } from "../../shared/api";
import { useI18n } from "../../i18n/store";
import { appStore, useAppStore } from "../../shared/store/appStore";
import { Button } from "../../shared/ui/Button";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { FormField, TextInput } from "../../shared/ui/FormControls";
import { Icon } from "../../shared/ui/Icon";
import { useMessage } from "../../shared/ui/message";
import { ModelSelect } from "../../shared/ui/ModelSelect";
import { Select } from "../../shared/ui/Select";
import { TruncatedButton } from "../../shared/ui/TruncatedButton";
import { configuredModelOptions } from "../../shared/utils/configuredModelOptions";
import { VirtualPage, type VirtualPageSection } from "../../shell/layout/VirtualPage";
import styles from "./ProvidersPage.module.scss";

/** Edits one combo (or creates one when `combo` is null): its Cursor name, start strategy, and ordered fallback members. */
export function ComboDetail({ combo, onSaved }: {
  combo: Combo | null;
  onSaved: (combo: Combo) => void;
}) {
  const { models, providers, cursorBusy } = useAppStore();
  const { locale } = useI18n();
  const message = useMessage();
  const [name, setName] = useState(combo?.display_name ?? "");
  const [strategy, setStrategy] = useState<ComboStrategy>(combo?.strategy ?? "ordered");
  const [members, setMembers] = useState<string[]>(combo?.members ?? []);
  const [deleting, setDeleting] = useState(false);
  const options = useMemo(() => configuredModelOptions(models, providers, locale), [locale, models, providers]);
  const optionByValue = useMemo(() => new Map(options.map((option) => [option.value, option])), [options]);
  const strategies: { value: ComboStrategy; label: string; hint: string }[] = [
    { value: "ordered", label: t("Ordered"), hint: t("Every message starts with the first model; the next models answer only when the previous one fails.") },
    { value: "loop", label: t("Loop"), hint: t("Each new message starts with the next model in the list; the following models are fallbacks.") },
    { value: "random", label: t("Random"), hint: t("Each new message starts with a random model; the other models are fallbacks in list order.") },
  ];
  const input: ComboInput = { display_name: name.trim(), strategy, members };
  const dirty = combo === null
    || input.display_name !== combo.display_name
    || strategy !== combo.strategy
    || members.join("\n") !== combo.members.join("\n");
  const valid = input.display_name.length > 0 && members.length > 0;

  const move = (index: number, step: number) => {
    const target = index + step;
    if (target < 0 || target >= members.length) return;
    const next = [...members];
    [next[index], next[target]] = [next[target], next[index]];
    setMembers(next);
  };
  const save = async () => {
    const saved = await appStore.saveCombo(combo?.combo_id ?? null, input);
    if (!saved) return;
    message(combo ? t("Combo saved") : t("Combo created"));
    onSaved(saved);
  };

  const sections: VirtualPageSection[] = [
    {
      key: "header",
      estimatedHeight: 72,
      content: <div className={styles.detailHeader}>
        <div className={styles.detailIdentity}>
          <div className={styles.detailNameRow}>
            <span className={styles.detailName}>{combo?.display_name || t("New combo")}</span>
            <span className={styles.stateBadge}>{t("Combo")}</span>
          </div>
          <span className={styles.detailMeta}>{t("Pick this name in Cursor's model picker. When a model fails or refuses, the next model in the list answers instead.")}</span>
        </div>
        <div className={styles.detailHeaderActions}>
          <Button variant="primary" size="small" disabled={cursorBusy || !dirty || !valid} onClick={() => void save()}>
            {combo ? t("Save") : t("Create combo")}
          </Button>
          {combo && <Button size="small" className={styles.deleteButton} disabled={cursorBusy} onClick={() => setDeleting(true)}>{t("Delete combo")}</Button>}
        </div>
      </div>,
    },
    {
      key: "settings",
      estimatedHeight: 180,
      content: <section className={styles.detailSection} aria-label={t("Combo settings")}>
        <div className={styles.groupForm}>
          <FormField label={t("Name in Cursor")}>
            <TextInput value={name} placeholder={t("e.g. Red team")} onChange={(event) => setName(event.target.value)} />
          </FormField>
          <FormField label={t("Start strategy")} hint={strategies.find((item) => item.value === strategy)?.hint}>
            <Select
              ariaLabel={t("Start strategy")}
              value={strategy}
              options={strategies.map((item) => ({ value: item.value, label: item.label }))}
              onChange={(value) => setStrategy(value as ComboStrategy)}
            />
          </FormField>
        </div>
      </section>,
    },
    {
      key: "members",
      estimatedHeight: 120 + members.length * 44,
      content: <section className={styles.detailSection} aria-label={t("Fallback order")}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionTitle}>
            <strong>{t("Fallback order")}</strong>
            <span className={styles.sectionMeta}>{t("Models are tried from top to bottom. Each model is tried at most once per call.")}</span>
          </div>
        </div>
        <ModelSelect label={t("Models")} mode="multiple" options={options} value={members} onChange={setMembers} disabled={cursorBusy} />
        <div className={styles.modelList}>
          {members.length === 0 && <span className={styles.sectionMeta}>{t("Select at least one model.")}</span>}
          {members.map((member, index) => {
            const option = optionByValue.get(member);
            return <div key={member} className={styles.modelRow}>
              <span className={styles.stateBadge}>{index + 1}</span>
              {option && (option.icon || option.iconSrc) && <Icon icon={option.icon} src={option.iconSrc} />}
              <div className={styles.modelRowName}>
                <span className={styles.modelRowNameText}>{option?.label ?? member}</span>
                <span className={styles.modelRowModelId}>{option?.group ?? t("Missing model")}</span>
              </div>
              <div className={styles.modelRowActions}>
                <TruncatedButton size="small" disabled={cursorBusy || index === 0} label={t("Move up")} onClick={() => move(index, -1)} />
                <TruncatedButton size="small" disabled={cursorBusy || index === members.length - 1} label={t("Move down")} onClick={() => move(index, 1)} />
                <TruncatedButton size="small" className={styles.deleteButton} disabled={cursorBusy} label={t("Remove")} onClick={() => setMembers(members.filter((item) => item !== member))} />
              </div>
            </div>;
          })}
        </div>
      </section>,
    },
  ];

  return <>
    <VirtualPage sections={sections} />
    <ConfirmDialog
      open={deleting}
      title={t("Delete combo")}
      cancelLabel={t("Cancel")}
      confirmLabel={t("Delete")}
      onCancel={() => setDeleting(false)}
      onConfirm={() => {
        setDeleting(false);
        if (combo) void appStore.deleteCombo(combo.combo_id);
      }}
    >
      <p>{t("Delete the combo {name}? Its models stay configured.", { name: combo?.display_name ?? "" })}</p>
    </ConfirmDialog>
  </>;
}

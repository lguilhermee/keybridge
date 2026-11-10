import { useState } from "react";
import { api, type Model, type ModelInput } from "../../shared/api";
import { appStore, useAppStore } from "../../shared/store/appStore";
import { Button } from "../../shared/ui/Button";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { FormField, SecretTextInput, TextInput } from "../../shared/ui/FormControls";
import { useMessage } from "../../shared/ui/message";
import { Modal } from "../../shared/ui/Modal";
import { TruncatedButton } from "../../shared/ui/TruncatedButton";
import { VirtualPage, type VirtualPageSection } from "../../shell/layout/VirtualPage";
import { ModelTestResult } from "./ModelTestResult";
import { errorText, modelInput, sharedValue } from "./modelEditing";
import type { ModelTests } from "./useModelTests";
import styles from "./ProvidersPage.module.scss";

export function ApiKeyProviderDetail({ groupName, groupModels, tests, onEditModel, onAddModel }: {
  groupName: string;
  groupModels: Model[];
  tests: ModelTests;
  onEditModel: (model: Model) => void;
  onAddModel: () => void;
}) {
  const { models, cursorBusy } = useAppStore();
  const message = useMessage();
  const [deleting, setDeleting] = useState<Model | null>(null);
  const [groupSettingsOpen, setGroupSettingsOpen] = useState(false);
  const [groupNameDraft, setGroupNameDraft] = useState("");
  const [groupBaseUrlDraft, setGroupBaseUrlDraft] = useState("");
  const [groupApiKeyDraft, setGroupApiKeyDraft] = useState("");
  const [groupSettingsBusy, setGroupSettingsBusy] = useState(false);

  const multi = groupModels.length > 1;
  const baseUrl = sharedValue(groupModels.map((model) => model.base_url));
  const typeValue = sharedValue(groupModels.map((model) => model.type));
  const apiKeyValue = sharedValue(groupModels.map((model) => model.api_key));
  const headerNames = [...new Set(groupModels.flatMap((model) => (model.custom_headers_enabled ? Object.keys(model.custom_headers) : [])))];

  const duplicateModel = async (model: Model) => {
    const names = new Set(models.map((item) => item.display_name));
    const baseName = t("{name} Copy", { name: model.display_name });
    let displayName = baseName;
    let suffix = 2;
    while (names.has(displayName)) {
      displayName = `${baseName} ${suffix}`;
      suffix += 1;
    }
    const created = await appStore.createModels([{
      ...modelInput(model),
      sort_order: models.length + 1,
      display_name: displayName,
    }]);
    if (created) message(t("Model duplicated"));
  };

  const openGroupSettings = () => {
    setGroupNameDraft(groupModels.find((model) => model.group_name?.trim())?.group_name?.trim() ?? "");
    setGroupBaseUrlDraft(sharedValue(groupModels.map((model) => model.base_url)) ?? "");
    setGroupApiKeyDraft(sharedValue(groupModels.map((model) => model.api_key)) ?? "");
    setGroupSettingsOpen(true);
  };

  const saveGroupSettings = async () => {
    const group_name = groupNameDraft.trim() || null;
    const base_url = groupBaseUrlDraft.trim();
    const api_key = groupApiKeyDraft.trim();
    setGroupSettingsBusy(true);
    try {
      for (const model of groupModels) {
        const input: ModelInput = {
          ...modelInput(model),
          group_name,
          ...(base_url ? { base_url } : {}),
          ...(api_key ? { api_key } : {}),
        };
        if (input.group_name === (model.group_name ?? null)
          && input.base_url === model.base_url
          && input.api_key === model.api_key) continue;
        await api.updateModel(model.model_hash, input);
      }
      await appStore.refresh();
      setGroupSettingsOpen(false);
    } catch (cause) {
      message(errorText(cause));
    } finally {
      setGroupSettingsBusy(false);
    }
  };

  const sections: VirtualPageSection[] = [
    {
      key: "header",
      estimatedHeight: 96,
      content: <div className={styles.detailHeader}>
        <div className={styles.detailIdentity}>
          <div className={styles.detailNameRow}>
            <span className={styles.detailName}>{groupName}</span>
            {typeValue && <span className={styles.stateBadge}>{typeValue === "anthropic" ? "Anthropic" : "OpenAI"}</span>}
            <span className={styles.stateBadge}>{t("API key")}</span>
          </div>
          <span className={styles.detailMeta}>
            {t("{count} models", { count: groupModels.length })}
            {baseUrl ? ` - ${baseUrl}` : multi ? ` - ${t("Multiple server addresses")}` : ""}
          </span>
        </div>
        <div className={styles.detailHeaderActions}>
          <Button variant="primary" size="small" onClick={onAddModel}>{t("Add model")}</Button>
          <Button size="small" disabled={cursorBusy || tests.batchTesting} onClick={() => void tests.testAllModels(groupModels)}>
            {tests.batchTesting ? t("Testing...") : t("Test all")}
          </Button>
        </div>
      </div>,
    },
    {
      key: "endpoint",
      estimatedHeight: 170,
      content: <section className={styles.detailSection} aria-label={t("Endpoint")}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionTitle}>
            <strong>{t("Endpoint")}</strong>
            <span className={styles.sectionMeta}>{t("Shared connection details for the models in this group")}</span>
          </div>
          <div className={styles.sectionActions}>
            <Button size="small" disabled={cursorBusy} onClick={openGroupSettings}>{t("Group settings")}</Button>
          </div>
        </div>
        <dl className={styles.fieldList}>
          <div className={styles.fieldRow}>
            <dt>{t("Server address")}</dt>
            <dd>{baseUrl ?? t("Multiple server addresses")}</dd>
          </div>
          <div className={styles.fieldRow}>
            <dt>API Key</dt>
            <dd>{apiKeyValue === null ? t("Each model uses its own key") : apiKeyValue ? maskedKey(apiKeyValue) : "--"}</dd>
          </div>
          <div className={styles.fieldRow}>
            <dt>{t("Custom Headers")}</dt>
            <dd>{headerNames.length > 0 ? headerNames.join(", ") : t("Disabled")}</dd>
          </div>
        </dl>
      </section>,
    },
    {
      key: "models",
      estimatedHeight: 60 + groupModels.length * 56,
      content: <section className={styles.detailSection} aria-label={t("Models")}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionTitle}>
            <strong>{t("Models")}</strong>
            <span className={styles.sectionMeta}>{t("{count} models", { count: groupModels.length })}</span>
          </div>
          <div className={styles.sectionActions}>
            <Button size="small" onClick={onAddModel}>{t("Add model")}</Button>
          </div>
        </div>
        <div className={styles.modelList}>
          {groupModels.map((model) => <div key={model.model_hash} className={styles.modelRow}>
            <div className={styles.modelRowName}>
              <span className={styles.modelRowNameText}>{model.display_name}</span>
              <span className={styles.modelRowModelId}>{model.model_id}</span>
            </div>
            <ModelTestResult
              compact
              state={tests.testResults.get(model.model_hash)}
              testing={tests.testingModelHashes.has(model.model_hash)}
            />
            <div className={styles.modelRowActions}>
              <TruncatedButton
                size="small"
                disabled={cursorBusy && !tests.testingModelHashes.has(model.model_hash)}
                label={tests.testingModelHashes.has(model.model_hash) ? t("Cancel test") : t("Test")}
                onClick={() => void tests.testModel(model)}
              />
              <TruncatedButton size="small" disabled={cursorBusy} label={t("Edit")} onClick={() => onEditModel(model)} />
              <TruncatedButton size="small" disabled={cursorBusy} label={t("Duplicate")} onClick={() => void duplicateModel(model)} />
              <TruncatedButton size="small" className={styles.deleteButton} disabled={cursorBusy} label={t("Delete")} onClick={() => setDeleting(model)} />
            </div>
          </div>)}
        </div>
      </section>,
    },
  ];

  return <>
    <VirtualPage sections={sections} />
    <ConfirmDialog
      open={deleting !== null}
      title={t("Delete model")}
      cancelLabel={t("Cancel")}
      confirmLabel={t("Delete")}
      onCancel={() => setDeleting(null)}
      onConfirm={() => {
        if (deleting) void appStore.deleteModel(deleting.model_hash);
        setDeleting(null);
      }}
    >
      <p>{t("Delete this model?")}</p>
    </ConfirmDialog>
    <Modal
      open={groupSettingsOpen}
      title={t("Group settings")}
      busy={groupSettingsBusy || cursorBusy}
      onClose={() => setGroupSettingsOpen(false)}
      onSubmit={() => void saveGroupSettings()}
      submitLabel={t("Save")}
    >
      <div className={styles.groupForm}>
        <FormField label={t("Group name")} hint={t("Applies to every model in this group and is used as the badge label in Cursor's model picker; clear it to fall back to the server domain.")}>
          <TextInput placeholder={groupName} value={groupNameDraft} onChange={(event) => setGroupNameDraft(event.target.value)} />
        </FormField>
        <FormField label={t("Server address")} hint={t("Applies to every model in this group when changed; leave blank to keep each model's current configuration.")}>
          <TextInput placeholder={t("Leave blank to keep unchanged")} value={groupBaseUrlDraft} onChange={(event) => setGroupBaseUrlDraft(event.target.value)} />
        </FormField>
        <FormField label="API Key" hint={t("Applies to every model in this group when changed; leave blank to keep each model's current configuration.")}>
          <SecretTextInput placeholder={t("Leave blank to keep unchanged")} autoComplete="off" value={groupApiKeyDraft} onChange={(event) => setGroupApiKeyDraft(event.target.value)} />
        </FormField>
      </div>
    </Modal>
  </>;
}

function maskedKey(key: string) {
  if (key.length <= 8) return "********";
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

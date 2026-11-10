import { useEffect, useState } from "react";
import { api, type Model } from "../../shared/api";
import { appStore, useAppStore } from "../../shared/store/appStore";
import controls from "../../shared/ui/Controls.module.scss";
import { useMessage } from "../../shared/ui/message";
import { Modal } from "../../shared/ui/Modal";
import { ModelEditor, emptyModelDraft, type ModelDraft, type ModelDraftSeed } from "./ModelEditor";
import { ModelTestResult } from "./ModelTestResult";
import { draftInput, errorText, modelInput, parseHeaders } from "./modelEditing";
import type { ModelTests } from "./useModelTests";

export function ModelEditorModal({ open, editing, seed, tests, onClose }: {
  open: boolean;
  /** The model being edited; null opens the create form. */
  editing: Model | null;
  /** Prefill for new models (used when adding inside an API-key group). */
  seed?: ModelDraftSeed;
  tests: ModelTests;
  onClose: () => void;
}) {
  const { models, cursorBusy } = useAppStore();
  const message = useMessage();
  const [draft, setDraft] = useState<ModelDraft | null>(null);
  /** Set by "Save and test" so a newly created model keeps its test banner and later saves update it. */
  const [saved, setSaved] = useState<Model | null>(null);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [savingAndTesting, setSavingAndTesting] = useState(false);
  const current = editing ?? saved;

  useEffect(() => {
    if (!open) {
      setDraft(null);
      setSaved(null);
      return;
    }
    setSaved(null);
    if (editing) {
      setModelOptions([editing.model_id]);
      setDraft({
        providerId: `builtin/${editing.type}`,
        model: modelInput(editing),
        openAIExtraParamsText: JSON.stringify(editing.openai_extra_params, null, 2),
        customHeadersText: JSON.stringify(editing.custom_headers, null, 2),
        anthropicExtraParamsText: JSON.stringify(editing.anthropic_extra_params, null, 2),
      });
    } else {
      const next = emptyModelDraft(seed);
      next.model.sort_order = models.length + 1;
      setModelOptions(next.model.model_id ? [next.model.model_id] : []);
      setDraft(next);
    }
    // The draft resets each time the modal opens for a different target; seed/model count are read then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing]);

  const discover = async (): Promise<boolean> => {
    if (!draft) return false;
    setDiscovering(true);
    try {
      const custom_headers = parseHeaders(draft.customHeadersText);
      const result = await api.discoverModels({
        type: draft.model.type,
        base_url: draft.model.base_url.trim(),
        api_key: draft.model.api_key.trim(),
        custom_headers_enabled: draft.model.custom_headers_enabled,
        custom_headers,
      });
      setModelOptions([...new Set(result.models)]);
      return true;
    } catch (cause) {
      message(errorText(cause));
      return false;
    } finally {
      setDiscovering(false);
    }
  };

  const persist = async (): Promise<Model | null> => {
    if (!draft) return null;
    const input = draftInput(draft);
    if (current) return appStore.updateCursorModel(current.model_hash, input);
    return (await appStore.createModels([input]))?.[0] ?? null;
  };

  const save = async () => {
    try {
      if (await persist()) {
        setDraft(null);
        setSaved(null);
        onClose();
      }
    } catch (cause) {
      message(errorText(cause));
    }
  };

  const saveAndTest = async () => {
    setSavingAndTesting(true);
    let savedModel: Model | null = null;
    try {
      savedModel = await persist();
    } catch (cause) {
      message(errorText(cause));
    } finally {
      setSavingAndTesting(false);
    }
    if (!savedModel) return;
    setSaved(savedModel);
    await tests.testModel(savedModel);
    await appStore.refresh();
  };

  const editorTestState = current ? tests.testResults.get(current.model_hash) : undefined;
  const editorTesting = Boolean(current && tests.testingModelHashes.has(current.model_hash));
  const close = () => {
    if (current && editorTesting) void tests.cancelTest(current.model_hash);
    setDraft(null);
    setSaved(null);
    onClose();
  };

  return <Modal
    fullHeight
    open={open}
    title={current ? t("Edit model") : t("Add model")}
    banner={draft && (editorTesting || editorTestState) ? <ModelTestResult state={editorTestState} testing={editorTesting} /> : undefined}
    busy={cursorBusy || savingAndTesting}
    onClose={close}
    onSubmit={() => void save()}
    submitLabel={t("Save")}
    secondaryAction={<button type="button" className={controls.secondary} disabled={cursorBusy || savingAndTesting} onClick={() => void (editorTesting && current ? tests.cancelTest(current.model_hash) : saveAndTest())}>{savingAndTesting ? t("Processing...") : editorTesting ? t("Cancel test") : t("Save and test")}</button>}
  >
    {draft && <ModelEditor draft={draft} modelOptions={modelOptions} discovering={discovering} onChange={setDraft} onDiscover={discover} />}
  </Modal>;
}

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import Sortable from "sortablejs";
import { api, type Model } from "../../shared/api";
import { PageContent } from "../../shell/layout/PageContent";
import { PageActions } from "../../shell/PageActions";
import { appStore, useAppStore } from "../../shared/store/appStore";
import { Button } from "../../shared/ui/Button";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import controls from "../../shared/ui/Controls.module.scss";
import { Icon } from "../../shared/ui/Icon";
import { useMessage } from "../../shared/ui/message";
import { Switch } from "../../shared/ui/Switch";
import { TooltipTrigger } from "../../shared/ui/TooltipTrigger";
import { claudeIcon, dragIcon, openAiIcon } from "../../shared/ui/icons";
import { CursorCaGate, CursorCaProvider, CursorModelGate, CursorModelProvider } from "./CursorGates";
import { LegacyModelImport } from "./LegacyModelImport";
import { RemoteSshHelp } from "./RemoteSshHelp";
import styles from "./CursorSettings.module.scss";

export function CursorPage() {
  const { models, cursorHarness, cursorBusy } = useAppStore();
  const navigate = useNavigate();
  const message = useMessage();
  const [caCommand, setCaCommand] = useState<string | null>(null);
  const [waitingForCaRefresh, setWaitingForCaRefresh] = useState(false);
  const [confirmDisableTakeover, setConfirmDisableTakeover] = useState(false);
  const [remoteSshHelpOpen, setRemoteSshHelpOpen] = useState(false);
  const caReady = cursorHarness?.ca === "ready";
  const cursorTakenOver = cursorHarness?.settings_applied ?? false;
  const takeoverLabel = cursorTakenOver ? t("Disable local Cursor integration") : t("Enable local Cursor integration");

  useEffect(() => {
    if (caCommand) void api.copyCursorText(caCommand);
  }, [caCommand]);

  const initializeCa = async () => {
    const status = await appStore.initializeCursorCa();
    if (status?.ca === "untrusted" && status.ca_install_command) setCaCommand(status.ca_install_command);
  };
  const refreshCa = async () => {
    await appStore.refresh();
    if (appStore.getSnapshot().cursorHarness?.ca !== "ready") setWaitingForCaRefresh(false);
  };
  const openCaTerminal = () => {
    if (caCommand) void api.openCursorCaInstallTerminal(caCommand).catch((cause) => message(errorText(cause)));
    setCaCommand(null);
    setWaitingForCaRefresh(true);
  };
  const reorderModels = useCallback(async (modelHashes: string[]) => {
    if (!await appStore.reorderCursorModels(modelHashes)) {
      message(appStore.getSnapshot().error || t("Unable to save model order"));
    }
  }, [message]);

  const content = <CursorCaProvider><CursorCaGate busy={cursorBusy} waitingForRefresh={waitingForCaRefresh} onInitialize={() => void initializeCa()} onRefresh={() => void refreshCa()}>
    <div className={styles.page}>
      <LegacyModelImport>{({ busy: importingLegacyModels, previewing, open }) =>
        <CursorModelProvider><CursorModelGate busy={cursorBusy || importingLegacyModels} previewingImport={previewing} onAdd={() => navigate("/providers")} onImport={open}>
          <ModelOrderList models={models} disabled={cursorBusy} onReorder={reorderModels} onManage={() => navigate("/providers")} />
        </CursorModelGate></CursorModelProvider>
      }</LegacyModelImport>
    </div>
  </CursorCaGate></CursorCaProvider>;

  return <>
    <PageActions position="left">
      <div className={styles.takeoverActions}>
        <TooltipTrigger label={t("Local proxy configuration only; Remote SSH is not verified.")}>
          <span className={styles.takeoverStatus}>{cursorTakenOver ? t("Local: on") : t("Local: off")}</span>
        </TooltipTrigger>
        <TooltipTrigger label={takeoverLabel}>
          <Switch
            checked={cursorTakenOver}
            disabled={cursorBusy || (!cursorTakenOver && !caReady)}
            label={takeoverLabel}
            onChange={(enabled) => {
              if (enabled) void appStore.setCursorEnabled(true);
              else setConfirmDisableTakeover(true);
            }}
          />
        </TooltipTrigger>
      </div>
    </PageActions>
    <PageActions>
      <button type="button" className={controls.secondary} aria-haspopup="dialog" onClick={() => setRemoteSshHelpOpen(true)}>{t("Remote SSH guide")}</button>
    </PageActions>
    {remoteSshHelpOpen && <RemoteSshHelp onClose={() => setRemoteSshHelpOpen(false)} />}
    <PageContent title="Cursor" sections={[{ key: "cursor", estimatedHeight: Math.max(380, models.length * 52 + 180), content }]} />
    <ConfirmDialog
      open={confirmDisableTakeover}
      title={t("Disable Cursor takeover?")}
      cancelLabel={t("Cancel")}
      confirmLabel={t("Disable takeover")}
      onCancel={() => setConfirmDisableTakeover(false)}
      onConfirm={() => {
        setConfirmDisableTakeover(false);
        void appStore.setCursorEnabled(false);
      }}
    >
      <p>{t("Disabling this will remove Cursor's local proxy configuration. If you need to sign in to an official account, you usually do not need to disable it. You can sign in directly because BYOK models and official-account models now work together seamlessly. Do you want to continue disabling and clearing the proxy configuration?")}</p>
    </ConfirmDialog>
    <ConfirmDialog open={caCommand !== null} title={t("Install local CA")} cancelLabel={t("Close")} confirmLabel={t("Open terminal")} onCancel={() => setCaCommand(null)} onConfirm={openCaTerminal}>
      <div className={styles.editor}><strong>{t("Authorization is required to install the certificate")}</strong><span>{t("The install command has been copied. Click 'Open terminal', paste it into the terminal, and enter your password when prompted.")}</span><pre className={styles.command}>{caCommand}</pre></div>
    </ConfirmDialog>
  </>;
}

/** Flat, draggable model order list — the only model UI left on the Cursor page.
 * Model create/edit/delete lives on the Providers page. */
function ModelOrderList({ models, disabled, onReorder, onManage }: {
  models: Model[];
  disabled: boolean;
  onReorder: (modelHashes: string[]) => void;
  onManage: () => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const sortable = useRef<Sortable | null>(null);
  const currentModels = useRef(models);
  const reorder = useRef(onReorder);
  currentModels.current = models;
  reorder.current = onReorder;

  useEffect(() => {
    if (!list.current) return;
    sortable.current = Sortable.create(list.current, {
      animation: 160,
      dataIdAttr: "data-model-hash",
      draggable: `.${styles.modelRow}`,
      handle: `.${styles.sortHandle}`,
      ghostClass: styles.sortGhost,
      chosenClass: styles.sortChosen,
      dragClass: styles.sortDragging,
      forceFallback: true,
      fallbackOnBody: true,
      fallbackTolerance: 3,
      onEnd: (event) => {
        const oldIndex = event.oldDraggableIndex ?? event.oldIndex;
        const newIndex = event.newDraggableIndex ?? event.newIndex;
        if (typeof oldIndex !== "number"
          || typeof newIndex !== "number"
          || oldIndex === newIndex) {
          sortable.current?.sort(currentModels.current.map((model) => model.model_hash), false);
          return;
        }
        const reordered = currentModels.current.slice();
        const [moved] = reordered.splice(oldIndex, 1);
        if (!moved || newIndex < 0 || newIndex > reordered.length) {
          sortable.current?.sort(currentModels.current.map((model) => model.model_hash), false);
          return;
        }
        reordered.splice(newIndex, 0, moved);
        reorder.current(reordered.map((model) => model.model_hash));
      },
    });
    return () => {
      sortable.current?.destroy();
      sortable.current = null;
    };
  }, []);

  useEffect(() => {
    sortable.current?.option("disabled", disabled);
    sortable.current?.sort(models.map((model) => model.model_hash), false);
  }, [disabled, models]);

  return <section aria-label={t("Model order")}>
    <div className={styles.orderHeader}>
      <div className={styles.orderTitle}>
        <strong>{t("Model order")}</strong>
        <span>{t("Drag models to change the order shown in Cursor's model picker.")}</span>
      </div>
      <Button size="small" onClick={onManage}>{t("Manage models")}</Button>
    </div>
    <div ref={list} className={styles.modelList}>
      {models.map((model) => <div className={styles.modelRow} data-model-hash={model.model_hash} key={model.model_hash}>
        <button type="button" className={styles.sortHandle} disabled={disabled} aria-label={t("Drag to reorder")} title={t("Drag to reorder")}>
          <Icon icon={dragIcon} size="1.25em" />
        </button>
        <div className={styles.modelRowName}>
          <span className={styles.modelRowNameText}>{model.display_name}</span>
          <span className={styles.modelRowModelId}>{model.model_id}</span>
        </div>
        <span className={styles.modelTypeBadge}>
          <Icon icon={model.type === "anthropic" ? claudeIcon : openAiIcon} />
          {model.type === "anthropic" ? "Anthropic" : "OpenAI"}
        </span>
      </div>)}
    </div>
  </section>;
}

function errorText(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

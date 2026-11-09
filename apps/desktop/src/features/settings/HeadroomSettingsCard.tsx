import { useEffect, useState } from "react";
import { api, type HeadroomStatus } from "../../shared/api";
import { Button } from "../../shared/ui/Button";
import { Checkbox } from "../../shared/ui/Checkbox";
import { TextInput } from "../../shared/ui/FormControls";
import { TitledCard } from "../../shared/ui/TitledCard";
import { useMessage } from "../../shared/ui/message";
import styles from "./HeadroomSettingsCard.module.scss";

function stateLabel(status: HeadroomStatus): string {
  switch (status.state) {
    case "running": return t("Running");
    case "starting": return t("Starting");
    case "failed": return t("Failed to start");
    case "not_installed": return t("Not installed");
    default: return t("Disabled");
  }
}

export function HeadroomSettingsCard() {
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

  return <TitledCard
    title="Headroom"
    action={editing ? (
      <div className={styles.cardActions}>
        <Button size="small" disabled={busy} onClick={() => { setEditing(false); if (status) setPort(String(status.port)); }}>{t("Cancel")}</Button>
        <Button variant="primary" size="small" disabled={busy} onClick={() => void savePort()}>{saving ? t("Saving...") : t("Save")}</Button>
      </div>
    ) : (
      <button type="button" className={styles.textButton} disabled={!status} onClick={() => setEditing(true)}>{t("Edit")}</button>
    )}
  >
    <div className={styles.settingRow}>
      <div>
        <strong>{t("Enable Headroom")}</strong>
        <small>{t("Compress request context sent to models through the Headroom proxy; requests are sent unchanged when it is not installed or unavailable.")}</small>
      </div>
      <Checkbox
        label={t("Enable Headroom")}
        checked={status?.enabled ?? false}
        disabled={!status || busy}
        onChange={(checked) => void toggle(checked)}
      />
    </div>
    <div className={styles.settingRow}>
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
    <div className={styles.settingRow}>
      <div>
        <strong>{t("Status")}</strong>
        {status?.detail && <small>{status.detail}</small>}
      </div>
      <span className={styles.value} data-state={status?.state}>
        {status ? stateLabel(status) : t("Loading...")}
      </span>
    </div>
    {status?.state === "not_installed" && <div className={styles.settingRow}>
      <div>
        <strong>{t("Install Headroom")}</strong>
        <small>{t("Install the headroom-ai[proxy] CLI via uv or pipx.")}</small>
      </div>
      <Button size="small" disabled={busy} onClick={() => void install()}>
        {busy ? t("Installing...") : t("Install")}
      </Button>
    </div>}
  </TitledCard>;
}

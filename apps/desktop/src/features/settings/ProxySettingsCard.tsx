import type { ProxySettings, ProxySettingsInput } from "../../shared/api";
import { Button } from "../../shared/ui/Button";
import { Checkbox } from "../../shared/ui/Checkbox";
import { TextInput } from "../../shared/ui/FormControls";
import { Select } from "../../shared/ui/Select";
import { TitledCard } from "../../shared/ui/TitledCard";
import styles from "./ProxySettingsCard.module.scss";

export function ProxySettingsCard({
  settings,
  draft,
  editing,
  saving,
  onDraftChange,
  onEdit,
  onCancel,
  onSave,
}: {
  settings: ProxySettings | null;
  draft: ProxySettingsInput;
  editing: boolean;
  saving: boolean;
  onDraftChange: (draft: ProxySettingsInput) => void;
  onEdit: () => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const custom = draft.mode === "custom";
  const modeLabel = (mode: ProxySettingsInput["mode"]) => mode === "default" ? t("Default") : t("Custom");
  const action = editing ? (
    <div className={styles.actionGroup}>
      <Button size="small" disabled={saving} onClick={onCancel}>{t("Cancel")}</Button>
      <Button variant="primary" size="small" disabled={saving} onClick={onSave}>{saving ? t("Saving...") : t("Save")}</Button>
    </div>
  ) : (
    <button type="button" className={styles.headerAction} disabled={!settings} onClick={onEdit}>
      {t("Edit")}
    </button>
  );

  return <TitledCard title={t("Proxy settings")} action={action}>
    <div className={styles.content}>
      {editing ? <>
        <div className={styles.row}>
          <strong>{t("Proxy mode")}</strong>
          <div className={styles.control}><Select ariaLabel={t("Proxy mode")} value={draft.mode} options={[{ value: "default", label: t("Default") }, { value: "custom", label: t("Custom") }]} onChange={(mode) => onDraftChange({ ...draft, mode: mode as ProxySettingsInput["mode"] })} /></div>
        </div>
        {custom && <div className={styles.customFields}>
          <div className={styles.row}>
            <strong>{t("Proxy address")}</strong>
            <div className={styles.control}><TextInput value={draft.address} placeholder="http://127.0.0.1:7890" onChange={(event) => onDraftChange({ ...draft, address: event.target.value })} /></div>
          </div>
          <div className={styles.row}>
            <strong>{t("Authentication")}</strong>
            <Checkbox checked={draft.auth_enabled} label={t("Proxy requires authentication")} onChange={(auth_enabled) => onDraftChange({ ...draft, auth_enabled })} />
          </div>
          {draft.auth_enabled && <div className={styles.customFields}>
            <div className={styles.row}>
              <strong>{t("Username")}</strong>
              <div className={styles.control}><TextInput value={draft.username} autoComplete="off" onChange={(event) => onDraftChange({ ...draft, username: event.target.value })} /></div>
            </div>
            <div className={styles.row}>
              <strong>{t("Password")}</strong>
              <div className={styles.control}><TextInput type="password" value={draft.password ?? ""} autoComplete="new-password" placeholder={settings?.has_password ? t("Leave blank to keep the current password") : ""} onChange={(event) => onDraftChange({ ...draft, password: event.target.value })} /></div>
            </div>
          </div>}
        </div>}
      </> : <>
        <div className={styles.row}><strong>{t("Proxy mode")}</strong><span className={styles.value}>{settings ? modeLabel(settings.mode) : t("Loading...")}</span></div>
        {settings?.mode === "custom" && <div className={styles.customFields}>
          <div className={styles.row}><strong>{t("Proxy address")}</strong><span className={styles.value}>{settings.address}</span></div>
          <div className={styles.row}><strong>{t("Authentication")}</strong><span className={styles.value}>{settings.auth_enabled ? t("Enabled") : t("Disabled")}</span></div>
          {settings.auth_enabled && <>
            <div className={styles.row}><strong>{t("Username")}</strong><span className={styles.value}>{settings.username || "-"}</span></div>
            <div className={styles.row}><strong>{t("Password")}</strong><span className={styles.value}>{settings.has_password ? t("Set") : t("Not set")}</span></div>
          </>}
        </div>}
      </>}
    </div>
  </TitledCard>;
}

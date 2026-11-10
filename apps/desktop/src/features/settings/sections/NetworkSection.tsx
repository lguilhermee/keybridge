import { useEffect, useState } from "react";
import { api, type ExternalApiSettings, type ProxySettings, type ProxySettingsInput } from "../../../shared/api";
import { appStore, useAppStore } from "../../../shared/store/appStore";
import { Button } from "../../../shared/ui/Button";
import { Checkbox } from "../../../shared/ui/Checkbox";
import { FormField, SecretTextInput, TextInput } from "../../../shared/ui/FormControls";
import { useMessage } from "../../../shared/ui/message";
import { Select } from "../../../shared/ui/Select";
import { Switch } from "../../../shared/ui/Switch";
import type { VirtualPageSection } from "../../../shell/layout/VirtualPage";
import { SectionCard } from "../SectionCard";
import styles from "./sections.module.scss";

export function networkGroups(): VirtualPageSection[] {
  return [
    { key: "ports", estimatedHeight: 170, content: <PortsGroup /> },
    { key: "outbound-proxy", estimatedHeight: 160, content: <OutboundProxyGroup /> },
    { key: "external-api", estimatedHeight: 190, content: <ExternalApiGroup /> },
  ];
}

function PortsGroup() {
  const { ports } = useAppStore();
  const message = useMessage();
  const [proxyPort, setProxyPort] = useState(String(ports.proxy_port));
  const [servicePort, setServicePort] = useState(String(ports.service_port));
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setProxyPort(String(ports.proxy_port));
    setServicePort(String(ports.service_port));
  }, [ports.proxy_port, ports.service_port]);

  const parsePort = (value: string, label: string) => {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      throw new Error(`${label}${t(" must be an integer from 0 to 65535")}`);
    }
    return port;
  };

  const save = async () => {
    try {
      const next = {
        proxy_port: parsePort(proxyPort, t("Proxy port")),
        service_port: parsePort(servicePort, t("Service port")),
      };
      setSaving(true);
      if (await appStore.updatePorts(next)) {
        setEditing(false);
        message(t("Port settings saved. Restart the app to apply them."), { duration: 4_000 });
      }
    } catch (cause) {
      message(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const edit = () => {
    setProxyPort(String(ports.proxy_port));
    setServicePort(String(ports.service_port));
    setEditing(true);
  };

  const cancel = () => {
    setProxyPort(String(ports.proxy_port));
    setServicePort(String(ports.service_port));
    setEditing(false);
  };

  return <SectionCard title={t("Port settings")} action={editing ? (
    <div className={styles.actions}>
      <Button size="small" disabled={saving} onClick={cancel}>{t("Cancel")}</Button>
      <Button variant="primary" size="small" disabled={saving} onClick={() => void save()}>{saving ? t("Saving...") : t("Save")}</Button>
    </div>
  ) : (
    <button type="button" className={styles.textAction} onClick={edit}>{t("Edit")}</button>
  )}>
    <div className={styles.content}>
      <div className={styles.portFields}>
        {editing ? <>
          <FormField
            label={t("Proxy port")}
            hint={t("The local proxy port used by Cursor. Enter 0 to select a random port at startup.")}
          >
            <TextInput
              type="number"
              min={0}
              max={65535}
              step={1}
              value={proxyPort}
              onChange={(event) => setProxyPort(event.target.value)}
            />
          </FormField>
          <FormField
            label={t("Service port")}
            hint={t("The local management service port used by the desktop frontend. Enter 0 to select a random port at startup.")}
          >
            <TextInput
              type="number"
              min={0}
              max={65535}
              step={1}
              value={servicePort}
              onChange={(event) => setServicePort(event.target.value)}
            />
          </FormField>
        </> : <>
          <div className={styles.portValue}><strong>{t("Proxy port")}</strong><span>{ports.proxy_port}</span></div>
          <div className={styles.portValue}><strong>{t("Service port")}</strong><span>{ports.service_port}</span></div>
        </>}
      </div>
      <div className={styles.portFooter}>
        <small>
          {t("If a port is occupied, a new random port is selected and saved automatically. Restart the app after changing these settings.")}
        </small>
      </div>
    </div>
  </SectionCard>;
}

function OutboundProxyGroup() {
  const message = useMessage();
  const [settings, setSettings] = useState<ProxySettings | null>(null);
  const [draft, setDraft] = useState<ProxySettingsInput>({ mode: "default", address: "", auth_enabled: false, username: "", password: "" });
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void api.proxySettings().then((next) => {
      setSettings(next);
      setDraft({ mode: next.mode, address: next.address, auth_enabled: next.auth_enabled, username: next.username, password: "" });
    }).catch((cause: unknown) => message(cause instanceof Error ? cause.message : String(cause)));
  }, [message]);

  const edit = () => {
    if (!settings) return;
    setDraft({ mode: settings.mode, address: settings.address, auth_enabled: settings.auth_enabled, username: settings.username, password: "" });
    setEditing(true);
  };

  const cancel = () => {
    if (settings) {
      setDraft({ mode: settings.mode, address: settings.address, auth_enabled: settings.auth_enabled, username: settings.username, password: "" });
    }
    setEditing(false);
  };

  const save = async () => {
    try {
      setSaving(true);
      const saved = await api.setProxySettings({ ...draft, password: draft.password || undefined });
      setSettings(saved);
      setDraft({ mode: saved.mode, address: saved.address, auth_enabled: saved.auth_enabled, username: saved.username, password: "" });
      setEditing(false);
      message(t("Proxy settings saved"));
    } catch (cause) {
      message(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const custom = draft.mode === "custom";
  const modeLabel = (mode: ProxySettingsInput["mode"]) => mode === "default" ? t("Default") : t("Custom");
  const action = editing ? (
    <div className={styles.actions}>
      <Button size="small" disabled={saving} onClick={cancel}>{t("Cancel")}</Button>
      <Button variant="primary" size="small" disabled={saving} onClick={() => void save()}>{saving ? t("Saving...") : t("Save")}</Button>
    </div>
  ) : (
    <button type="button" className={styles.textAction} disabled={!settings} onClick={edit}>
      {t("Edit")}
    </button>
  );

  return <SectionCard title={t("Outbound proxy")} action={action}>
    <div className={styles.content}>
      {editing ? <>
        <div className={styles.row}>
          <strong>{t("Proxy mode")}</strong>
          <div className={styles.control}><Select ariaLabel={t("Proxy mode")} value={draft.mode} options={[{ value: "default", label: t("Default") }, { value: "custom", label: t("Custom") }]} onChange={(mode) => setDraft({ ...draft, mode: mode as ProxySettingsInput["mode"] })} /></div>
        </div>
        {custom && <div className={styles.customFields}>
          <div className={styles.row}>
            <strong>{t("Proxy address")}</strong>
            <div className={styles.control}><TextInput value={draft.address} placeholder="http://127.0.0.1:7890" onChange={(event) => setDraft({ ...draft, address: event.target.value })} /></div>
          </div>
          <div className={styles.row}>
            <strong>{t("Authentication")}</strong>
            <Checkbox checked={draft.auth_enabled} label={t("Proxy requires authentication")} onChange={(auth_enabled) => setDraft({ ...draft, auth_enabled })} />
          </div>
          {draft.auth_enabled && <div className={styles.customFields}>
            <div className={styles.row}>
              <strong>{t("Username")}</strong>
              <div className={styles.control}><TextInput value={draft.username} autoComplete="off" onChange={(event) => setDraft({ ...draft, username: event.target.value })} /></div>
            </div>
            <div className={styles.row}>
              <strong>{t("Password")}</strong>
              <div className={styles.control}><TextInput type="password" value={draft.password ?? ""} autoComplete="new-password" placeholder={settings?.has_password ? t("Leave blank to keep the current password") : ""} onChange={(event) => setDraft({ ...draft, password: event.target.value })} /></div>
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
  </SectionCard>;
}

function ExternalApiGroup() {
  const { ports } = useAppStore();
  const message = useMessage();
  const [saved, setSaved] = useState<ExternalApiSettings | null>(null);
  const [draft, setDraft] = useState<ExternalApiSettings>({ enabled: false, api_key: "" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void api.externalApiSettings().then((settings) => {
      setSaved(settings);
      setDraft(settings);
    }).catch((cause: unknown) => message(cause instanceof Error ? cause.message : String(cause)));
  }, [message]);

  const save = async () => {
    try {
      setSaving(true);
      const settings = await api.setExternalApiSettings(draft);
      setSaved(settings);
      setDraft(settings);
      message(t("External API settings saved"));
    } catch (cause) {
      message(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const address = `http://127.0.0.1:${ports.service_port}/byok/v1`;
  const changed = saved && (saved.enabled !== draft.enabled || saved.api_key !== draft.api_key);

  return <SectionCard title={t("External API")} action={<Button size="small" variant="primary" disabled={!changed || saving} onClick={() => void save()}>
    {saving ? t("Saving...") : t("Save")}
  </Button>}>
    <div className={styles.content}>
      <div className={styles.row}>
        <div className={styles.description}>
          <strong>{t("Enable external API")}</strong>
          <small>{t("Allow local apps to call configured models, including provider models, with an API key.")}</small>
        </div>
        <Switch label={t("Enable external API")} checked={draft.enabled} disabled={!saved || saving}
          onChange={(enabled) => setDraft((current) => ({ ...current, enabled }))} />
      </div>
      <FormField label={t("API key")} hint={t("All external requests must provide this key when enabled.")}>
        <SecretTextInput value={draft.api_key} autoComplete="off" disabled={!saved || saving}
          onChange={(event) => setDraft((current) => ({ ...current, api_key: event.target.value }))} />
      </FormField>
      <div className={styles.address}>
        <strong>{t("Base URL")}</strong>
        <code>{address}</code>
      </div>
    </div>
  </SectionCard>;
}

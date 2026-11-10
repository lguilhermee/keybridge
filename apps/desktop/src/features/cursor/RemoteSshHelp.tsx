import { useState } from "react";
import { api } from "../../shared/api";
import controls from "../../shared/ui/Controls.module.scss";
import { Modal } from "../../shared/ui/Modal";
import styles from "./CursorSettings.module.scss";
import helpStyles from "./RemoteSshHelp.module.scss";

const remoteSettings = '{\n  "cursorAgentHost.remoteInferenceRoute": "always"\n}';

export function RemoteSshHelp({ onClose }: { onClose: () => void }) {
  const [copyState, setCopyState] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  const copySettings = async () => {
    setCopyState("copying");
    try {
      await api.copyCursorText(remoteSettings);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return <Modal open title={t("Remote SSH setup guide")} onClose={onClose} closeLabel={t("Close")}>
    <div className={`${styles.editor} ${helpStyles.content}`}>
      <p>{t("Requires Cursor 3.21.16 or newer. Keep Keybridge running on your local machine and complete local CA and model setup first.")}</p>
      <ol className={styles.editor}>
        <li>{t("Connect to your SSH host. In Cursor Settings, select Remote [SSH: host] and open that host's remote settings JSON. Configure each SSH host separately.")}</li>
        <li>
          <p>{t("Merge this setting, preserving your existing configuration. Changing only local User or workspace settings is not enough.")}</p>
          <pre className={styles.command}><code>{remoteSettings}</code></pre>
        </li>
        <li>{t("Save, then run Developer: Reload Window from the command palette.")}</li>
        <li>{t("Start a new chat, explicitly select a configured BYOK model, and send a request. Do not continue an old chat or select Auto.")}</li>
      </ol>
      <div>
        <button type="button" className={controls.secondary} disabled={copyState === "copying"} aria-busy={copyState === "copying"} onClick={() => void copySettings()}>
          {copyState === "copying" ? t("Copying...") : t("Copy remote settings")}
        </button>
        <p role="status" aria-live="polite">
          {copyState === "copied" && t("Settings copied. Paste them into this SSH host's remote settings; they have not been applied automatically.")}
          {copyState === "failed" && t("Copy failed. Select and copy the JSON above manually, or retry in the desktop app.")}
        </p>
      </div>
      <p>{t("This routes remote inference through the Cursor client to local Keybridge. No SSH tunnel or local CA installation on the remote host is needed. Tools still run in the SSH workspace.")}</p>
      <p>{t("Local integration status describes only the local proxy configuration, not SSH readiness. Test Agent, tool calls, MCP, Skills, Tab, and commit generation separately.")}</p>
      <p>{t("If a connection to 127.0.0.1 fails, localhost in a remote process refers to the remote host, not your desktop. Check that the remote setting took effect. Diagnose certificate errors separately using the failing process and destination; keep TLS verification enabled and never copy CA private keys.")}</p>
    </div>
  </Modal>;
}

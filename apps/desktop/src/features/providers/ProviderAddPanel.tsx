import { useEffect, useRef, useState } from "react";
import {
  api,
  providerText,
  type ProviderAddMethod,
  type ProviderDescriptor,
  type ProviderImportDescriptor,
  type ProviderImportFile,
  type ProviderOAuthBegin,
  type ProviderResourceDescriptor,
} from "../../shared/api";
import { useI18n } from "../../i18n/store";
import { appStore } from "../../shared/store/appStore";
import { Button } from "../../shared/ui/Button";
import { Card } from "../../shared/ui/Card";
import { TextInput } from "../../shared/ui/FormControls";
import { useMessage } from "../../shared/ui/message";
import styles from "./ProviderResourcePanels.module.scss";

export function ProviderAddPanel({ provider, onConfigured }: { provider: ProviderDescriptor; onConfigured: () => void }) {
  const hasAddOptions = provider.resources.some((resource) => resource.add.length > 0 || resource.import !== null);
  return <div className={styles.panel}>
    {provider.resources.map((resource) => <ResourceAddSection
      key={resource.type}
      provider={provider}
      resource={resource}
      onConfigured={onConfigured}
    />)}
    {!hasAddOptions && <span className={styles.empty}>{t("This provider does not need any resources.")}</span>}
  </div>;
}

function ResourceAddSection({ provider, resource, onConfigured }: {
  provider: ProviderDescriptor;
  resource: ProviderResourceDescriptor;
  onConfigured: () => void;
}) {
  return <>
    {resource.add.map((method) => <OAuthMethodCard
      key={method.id}
      providerId={provider.id}
      resourceType={resource.type}
      method={method}
      onConfigured={onConfigured}
    />)}
    {resource.import && <ImportMethodCard
      providerId={provider.id}
      resourceType={resource.type}
      descriptor={resource.import}
      onConfigured={onConfigured}
    />}
  </>;
}

function ImportMethodCard({ providerId, resourceType, descriptor, onConfigured }: {
  providerId: string;
  resourceType: string;
  descriptor: ProviderImportDescriptor;
  onConfigured: () => void;
}) {
  const { locale } = useI18n();
  const message = useMessage();
  const input = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [pasted, setPasted] = useState("");
  const [error, setError] = useState<string | null>(null);

  const finishImport = async (entries: ProviderImportFile[]) => {
    const result = await api.importProviderResources(providerId, resourceType, entries);
    await appStore.refreshProviders();
    const summary = t("Import finished: {added} added, {updated} updated", { added: result.added, updated: result.updated });
    if (result.modelSyncError) {
      message(t("The account was saved, but model sync failed: {error}", { error: result.modelSyncError }), { duration: 5000 });
    } else if (result.warnings.length > 0) {
      message(`${summary} - ${result.warnings.join("; ")}`, { duration: 5000 });
    } else {
      message(summary);
    }
    onConfigured();
  };

  const importFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setImporting(true);
    setError(null);
    try {
      const entries: ProviderImportFile[] = await Promise.all(
        [...files].map(async (file) => ({ name: file.name, content: await file.text() })),
      );
      await finishImport(entries);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setImporting(false);
      if (input.current) input.current.value = "";
    }
  };

  const importPasted = async () => {
    const content = pasted.trim();
    if (!content) return;
    setImporting(true);
    setError(null);
    try {
      await finishImport([{ name: "pasted.txt", content }]);
      setPasted("");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setImporting(false);
    }
  };

  return <Card className={styles.methodCard}>
    <strong>{providerText(descriptor.displayName, locale)}</strong>
    {descriptor.description && <span>{providerText(descriptor.description, locale)}</span>}
    <div className={styles.actions}>
      <TextInput
        aria-label={t("Paste credential")}
        placeholder={t("Paste a key or credential...")}
        value={pasted}
        disabled={importing}
        onChange={(event) => setPasted(event.target.value)}
      />
      <Button variant="primary" disabled={importing || !pasted.trim()} onClick={() => void importPasted()}>
        {t("Add")}
      </Button>
      {descriptor.helpUrl && <Button disabled={importing} onClick={() => void api.openExternalUrl(descriptor.helpUrl!)}>
        {t("Get key")}
      </Button>}
      <Button disabled={importing} onClick={() => input.current?.click()}>
        {importing ? t("Importing...") : t("Bulk import")}
      </Button>
      <input
        ref={input}
        type="file"
        hidden
        accept={descriptor.accept.join(",")}
        multiple={descriptor.multiple}
        onChange={(event) => void importFiles(event.target.files)}
      />
    </div>
    {error && <span className={styles.error} role="alert">{error}</span>}
  </Card>;
}

function OAuthMethodCard({ providerId, resourceType, method, onConfigured }: {
  providerId: string;
  resourceType: string;
  method: ProviderAddMethod;
  onConfigured: () => void;
}) {
  const { locale } = useI18n();
  const [status, setStatus] = useState<"idle" | "starting" | "polling" | "success" | "error">("idle");
  const [begun, setBegun] = useState<ProviderOAuthBegin | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const stopped = useRef(false);

  const copyCode = async (code: string) => {
    await api.copyCursorText(code).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  useEffect(() => () => { stopped.current = true; }, []);

  useEffect(() => {
    if (!begun || status !== "polling") return;
    let timer = 0;
    const poll = async (intervalMs: number) => {
      if (stopped.current) return;
      try {
        const result = await api.providerOAuthPoll(begun.sessionId);
        if (stopped.current) return;
        if (result.status === "pending") {
          timer = window.setTimeout(() => void poll(result.pollIntervalMs), Math.max(1000, result.pollIntervalMs));
          return;
        }
        if (result.status === "completed") {
          await appStore.refreshProviders();
          if (result.modelSyncError) {
            setStatus("error");
            setError(t("The account was saved, but model sync failed: {error}", { error: result.modelSyncError }));
            return;
          }
          setStatus("success");
          onConfigured();
          return;
        }
        setStatus("error");
        setError(result.message || t("Authorization was denied or failed."));
      } catch (cause) {
        if (stopped.current) return;
        setError(errorText(cause));
        timer = window.setTimeout(() => void poll(intervalMs), Math.max(1000, intervalMs));
      }
    };
    timer = window.setTimeout(() => void poll(begun.pollIntervalMs), Math.max(1000, begun.pollIntervalMs));
    return () => window.clearTimeout(timer);
  }, [begun, onConfigured, status]);

  const start = async () => {
    setStatus("starting");
    setError(null);
    try {
      const next = await api.providerOAuthBegin(providerId, resourceType, method.id);
      setBegun(next);
      setStatus("polling");
      if (next.userCode) await api.copyCursorText(next.userCode).catch(() => undefined);
      await api.openExternalUrl(next.verificationUrlComplete || next.verificationUrl);
    } catch (cause) {
      setStatus("error");
      setError(errorText(cause));
    }
  };

  const userCode = begun?.userCode;
  return <Card className={styles.methodCard}>
    <strong>{providerText(method.displayName, locale)}</strong>
    {method.description && <span>{providerText(method.description, locale)}</span>}
    {userCode && status === "polling" && <div className={styles.deviceCode}>
      <small>{t("Device code")}</small>
      <button type="button" onClick={() => void copyCode(userCode)}>{userCode}</button>
      <button type="button" className={styles.copy} onClick={() => void copyCode(userCode)}>
        {copied ? t("Copied") : t("Duplicate")}
      </button>
    </div>}
    <div className={styles.actions}>
      <Button variant="primary" disabled={status === "starting" || status === "polling"} onClick={() => void start()}>
        {status === "starting" ? t("Requesting an authorization code...") : status === "polling" ? t("Waiting for browser authorization...") : t("Start sign-in")}
      </Button>
      {begun && status === "polling" && <Button onClick={() => void api.openExternalUrl(begun.verificationUrlComplete || begun.verificationUrl)}>{t("Open authorization page")}</Button>}
    </div>
    {status === "success" && <span className={styles.success}>{t("Account saved and the model catalog is synced.")}</span>}
    {error && <span className={styles.error} role="alert">{error}</span>}
  </Card>;
}

function errorText(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

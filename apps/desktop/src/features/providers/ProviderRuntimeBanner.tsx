import type { ProviderRuntimePhase, ProviderRuntimeStatus } from "../../shared/api";
import { Button } from "../../shared/ui/Button";
import styles from "./ProvidersPage.module.scss";

/** Top-of-page banner for the provider runtime: download progress with cancel,
 * or the initialize / retry call to action. Never blocks the page. */
export function ProviderRuntimeBanner({ status, starting, onInitialize, onCancel }: {
  status: ProviderRuntimeStatus | null;
  starting: boolean;
  onInitialize: () => void;
  onCancel: () => void;
}) {
  if (status?.state === "ready") return null;

  const initializing = starting || status?.state === "initializing";
  const checking = status === null;
  const failed = status?.state === "failed";
  const unsupported = status?.state === "unsupported";
  const downloaded = status?.downloaded_bytes ?? 0;
  const total = status?.total_bytes ?? null;
  const percent = total && total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : null;

  const stage = failed
    ? t("Provider runtime initialization failed")
    : unsupported
      ? t("Provider runtime is not supported on this system")
      : initializing
        ? phaseText(status?.phase ?? null)
        : checking
          ? t("Checking the provider runtime")
          : t("Provider runtime is not initialized");
  const detail = failed
    ? status.error ?? t("Try initializing again")
    : unsupported
      ? status.error ?? t("This operating system or CPU architecture is not currently supported")
      : status?.phase === "downloading"
        ? total
          ? t("Downloaded {downloaded} / {total}", { downloaded: formatBytes(downloaded), total: formatBytes(total) })
          : t("Downloaded {downloaded}", { downloaded: formatBytes(downloaded) })
        : checking || initializing
          ? null
          : t("Initialization downloads and installs the provider runtime.");

  return <div className={styles.runtimeBanner} role="status">
    <div className={styles.runtimeBannerText}>
      <strong>{stage}</strong>
      {detail && <span>{detail}</span>}
      {status?.phase === "downloading" && <div
        className={styles.progressBar}
        role="progressbar"
        aria-label={t("Download progress")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
      >
        <div className={styles.progressFill} style={{ width: `${percent ?? 100}%` }} />
      </div>}
    </div>
    <div className={styles.runtimeBannerActions}>
      {initializing && <Button size="small" onClick={onCancel}>{t("Cancel")}</Button>}
      {!initializing && !unsupported && <Button
        size="small"
        variant="primary"
        disabled={checking}
        onClick={onInitialize}
      >{checking ? t("Checking...") : failed ? t("Reinitialize providers") : t("Initialize providers")}</Button>}
    </div>
  </div>;
}

function phaseText(phase: ProviderRuntimePhase | null) {
  switch (phase) {
    case "checking": return t("Checking the provider runtime");
    case "downloading": return t("Downloading the provider runtime");
    case "verifying": return t("Verifying the provider runtime download");
    case "installing": return t("Installing the provider runtime");
    case "validating": return t("Validating the provider runtime");
    default: return t("Preparing the provider runtime");
  }
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : value.toFixed(0)} ${units[unit]}`;
}

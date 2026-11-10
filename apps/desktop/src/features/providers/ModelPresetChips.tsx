import type { ModelType } from "../../shared/api";
import { modelPresets, presetEndpoint, trimTrailingSlash, type ModelPreset } from "../../shared/utils/modelPresets";
import styles from "./ModelPresetChips.module.scss";

/** Common provider presets: clicking fills the endpoint for the current protocol type and the default model. */
export function ModelPresetChips({ type, baseUrl, onPick }: { type: ModelType; baseUrl: string; onPick: (preset: ModelPreset) => void }) {
  return <div className={styles.wrap}>
    <span className={styles.label}>{t("Presets")}</span>
    <div className={styles.chips}>
      {modelPresets.map((preset) => {
        const active = trimTrailingSlash(baseUrl) === trimTrailingSlash(presetEndpoint(preset, type).baseUrl);
        return <button
          type="button"
          key={preset.key}
          className={active ? `${styles.chip} ${styles.active}` : styles.chip}
          title={preset.keyHint}
          onClick={() => onPick(preset)}
        >
          <img className={styles.icon} src={preset.icon} alt="" />
          {preset.name}
        </button>;
      })}
    </div>
  </div>;
}

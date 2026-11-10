export const settingsSectionIds = ["general", "network", "cursor", "usage", "about"] as const;
export type SettingsSectionId = (typeof settingsSectionIds)[number];
export const defaultSettingsSection: SettingsSectionId = "general";

export function settingsSectionLabel(id: SettingsSectionId): string {
  switch (id) {
    case "general": return t("General");
    case "network": return t("Network");
    case "cursor": return "Cursor";
    case "usage": return t("Usage & data");
    case "about": return t("About");
  }
}

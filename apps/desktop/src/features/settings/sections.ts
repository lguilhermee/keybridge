export const settingsSectionIds = ["general", "network", "cursor", "usage", "about"] as const;
export type SettingsSectionId = (typeof settingsSectionIds)[number];
export const defaultSettingsSection: SettingsSectionId = "general";

export function isSettingsSectionId(value: string | undefined | null): value is SettingsSectionId {
  return value !== undefined && value !== null && (settingsSectionIds as readonly string[]).includes(value);
}

export function settingsSectionLabel(id: SettingsSectionId): string {
  switch (id) {
    case "general": return t("General");
    case "network": return t("Network");
    case "cursor": return "Cursor";
    case "usage": return t("Usage & data");
    case "about": return t("About");
  }
}

export type SettingsSearchEntry = {
  /** Unique result id. */
  id: string;
  /** Section route segment the setting lives in. */
  section: SettingsSectionId;
  /** Group (card) key inside the section pane; the jump scrolls to it. */
  group: string;
  label: string;
  description?: string;
  /** Extra English-only match terms; never rendered. */
  keywords?: string;
};

/** Every searchable setting row, in display order. Labels and descriptions reuse the same source strings as the setting rows. */
export function settingsSearchEntries(): SettingsSearchEntry[] {
  return [
    // General
    {
      id: "language",
      section: "general",
      group: "language",
      label: t("Display language"),
      description: t("Uses the operating system language by default; unsupported languages fall back to English."),
    },
    {
      id: "theme",
      section: "general",
      group: "theme",
      label: t("Theme"),
      description: t("Choose the dark or light theme."),
    },
    {
      id: "autostart",
      section: "general",
      group: "startup",
      label: t("Launch at login"),
      description: t("Start Cursor BYOK automatically after signing in."),
    },
    {
      id: "silent-start",
      section: "general",
      group: "startup",
      label: t("Silent start"),
      description: t("Hide the main window on startup and keep only the tray icon."),
      keywords: "tray",
    },
    {
      id: "dock-icon",
      section: "general",
      group: "startup",
      label: t("Show in Dock"),
      description: t("Hide the Dock icon when disabled. You can still open the app from the menu bar icon."),
      keywords: "macos tray",
    },
    // Network
    {
      id: "proxy-port",
      section: "network",
      group: "ports",
      label: t("Proxy port"),
      description: t("The local proxy port used by Cursor. Enter 0 to select a random port at startup."),
    },
    {
      id: "service-port",
      section: "network",
      group: "ports",
      label: t("Service port"),
      description: t("The local management service port used by the desktop frontend. Enter 0 to select a random port at startup."),
    },
    {
      id: "outbound-proxy",
      section: "network",
      group: "outbound-proxy",
      label: t("Outbound proxy"),
      description: t("Route outbound requests through a custom HTTP proxy."),
      keywords: "authentication username password",
    },
    {
      id: "external-api",
      section: "network",
      group: "external-api",
      label: t("External API"),
      description: t("Allow local apps to call configured models, including provider models, with an API key."),
    },
    // Cursor
    {
      id: "tab",
      section: "cursor",
      group: "tab",
      label: t("TAB settings"),
      description: t("Choose how Cursor connects to TAB endpoints."),
      keywords: "completion service",
    },
    {
      id: "commit-model",
      section: "cursor",
      group: "commit",
      label: t("Commit Message Model Settings"),
      description: t("Generation model"),
      keywords: "prompt commit message",
    },
    {
      id: "headroom",
      section: "cursor",
      group: "headroom",
      label: "Headroom",
      description: t("Compress request context sent to models through the Headroom proxy; requests are sent unchanged when it is not installed or unavailable."),
      keywords: "compress context",
    },
    // Usage & data
    {
      id: "detailed-mode",
      section: "usage",
      group: "observability",
      label: t("Detailed mode"),
      description: t("Also store complete requests and streamed responses; by default only timing, status, and usage are stored."),
      keywords: "recording",
    },
    {
      id: "pricing",
      section: "usage",
      group: "pricing",
      label: t("Token pricing"),
      description: t("Token unit prices used for the home page estimated value. Unit: USD per million tokens."),
      keywords: "cost price",
    },
    {
      id: "storage",
      section: "usage",
      group: "storage",
      label: t("Storage management"),
      description: t("View call and trace record counts and clear stored statistics."),
      keywords: "clear statistics",
    },
    {
      id: "legacy-import",
      section: "usage",
      group: "import",
      label: t("Import"),
      description: t("Read models from the local legacy configuration. New and existing models are shown before confirmation."),
      keywords: "legacy v0049",
    },
    // About
    {
      id: "version",
      section: "about",
      group: "about",
      label: t("Version"),
      description: t("Current app version."),
    },
    {
      id: "updates",
      section: "about",
      group: "about",
      label: t("Software updates"),
      description: t("Check for updates and install the latest version."),
      keywords: "install upgrade",
    },
  ];
}

/** Lowercase-insensitive AND match over label, description, keywords, and the section label. */
export function filterSettingsSearchEntries(entries: SettingsSearchEntry[], query: string): SettingsSearchEntry[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return entries.filter((entry) => {
    const haystack = `${entry.label} ${entry.description ?? ""} ${entry.keywords ?? ""} ${settingsSectionLabel(entry.section)}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

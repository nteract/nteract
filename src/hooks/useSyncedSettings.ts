import {
  useNotebookHost,
  type HostSyncedSettings,
  type NotebookHost,
} from "@nteract/notebook-host";
import { useCallback, useEffect, useState } from "react";
import type { ColorTheme, PythonEnvType, Runtime, ThemeMode } from "@/bindings";

// Re-export generated types so consumers can import from this module.
export type { ColorTheme, ThemeMode, Runtime, PythonEnvType };

function isValidColorTheme(value: unknown): value is ColorTheme {
  return value === "classic" || value === "cream";
}

function getStoredColorTheme(): ColorTheme {
  try {
    const stored = localStorage.getItem("notebook-color-theme");
    if (stored && isValidColorTheme(stored)) return stored;
  } catch {
    // ignore
  }
  return "classic";
}

function setStoredColorTheme(value: ColorTheme) {
  try {
    localStorage.setItem("notebook-color-theme", value);
  } catch {
    // ignore
  }
}

function resolveTheme(theme: ThemeMode): "light" | "dark" {
  if (theme === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return theme;
}

function applyThemeToDOM(resolved: "light" | "dark") {
  const html = document.documentElement;
  if (resolved === "dark") {
    html.classList.add("dark");
    html.classList.remove("light");
  } else {
    html.classList.remove("dark");
    html.classList.add("light");
  }
}

async function syncNativeWindowTheme(host: NotebookHost, theme: ThemeMode): Promise<void> {
  try {
    await host.window.setTheme(theme === "system" ? null : theme);
  } catch {
    // Silently fail if host chrome is unavailable.
  }
}

function persistSyncedSetting(
  host: NotebookHost,
  key: string,
  value: unknown,
  warning: string,
): void {
  host.settings.setSynced(key, value).catch((e) => {
    console.warn(warning, e);
  });
}

function isValidTheme(value: unknown): value is ThemeMode {
  return value === "light" || value === "dark" || value === "system";
}

/** Known runtime values for UI buttons; unknown values are preserved. */
export function isKnownRuntime(value: string): value is "python" | "deno" {
  return value === "python" || value === "deno";
}

/** Known env type values for UI buttons; unknown values are preserved. */
export function isKnownPythonEnv(value: string): value is "uv" | "conda" | "pixi" {
  return value === "uv" || value === "conda" || value === "pixi";
}

/**
 * Feature flags exposed to the settings UI.
 *
 * Mirrors feature-flag settings exposed by `SyncedSettings`. The TS source of
 * truth is intentionally flat (each flag is a top-level boolean on
 * `SyncedSettings`) so that adding a new flag is one field here, one struct
 * field in Rust, and one entry in the settings UI — no schema migration.
 *
 * Adding a flag:
 *  1. Add `flag_id: boolean` to `SyncedSettings`.
 *  2. Add `flag_id: { label, description }` below.
 *  3. Done — the settings UI renders a toggle automatically.
 */
export const FEATURE_FLAG_METADATA = {
  disable_nteract_launcher: {
    label: "Use Legacy IPython Launcher",
    description: "Launch Python kernels with ipykernel_launcher instead of the nteract launcher.",
  },
} as const satisfies Record<string, { label: string; description: string }>;

export type FeatureFlagId = keyof typeof FEATURE_FLAG_METADATA;
export type FeatureFlagValues = Record<FeatureFlagId, boolean>;

const FEATURE_FLAG_DEFAULTS: FeatureFlagValues = {
  disable_nteract_launcher: false,
};

export const FEATURE_FLAGS: ReadonlyArray<{
  id: FeatureFlagId;
  label: string;
  description: string;
}> = (Object.keys(FEATURE_FLAG_METADATA) as FeatureFlagId[]).map((id) => ({
  id,
  ...FEATURE_FLAG_METADATA[id],
}));

/**
 * Read a theme value from localStorage.
 *
 * localStorage is ONLY used for the theme setting to avoid a flash of
 * unstyled content (FOUC) on startup. All other settings initialize from
 * defaults and wait for the daemon to provide the authoritative value.
 */
function getStoredTheme(): ThemeMode {
  try {
    const stored = localStorage.getItem("notebook-theme");
    if (stored && isValidTheme(stored)) return stored;
  } catch {
    // ignore
  }
  return "system";
}

function setStoredTheme(value: ThemeMode) {
  try {
    localStorage.setItem("notebook-theme", value);
  } catch {
    // ignore
  }
}

/**
 * Hook for all synced settings across notebook windows via runtimed.
 *
 * The daemon (Automerge doc) is the source of truth. On mount, we fetch
 * the current settings from the daemon and listen for cross-window changes.
 *
 * localStorage is only used for theme to avoid FOUC. All other settings
 * initialize from defaults and are overwritten once the daemon responds.
 */
export function useSyncedSettings() {
  const host = useNotebookHost();
  // Theme uses localStorage to avoid flash of wrong theme on startup
  const [theme, setThemeState] = useState<ThemeMode>(getStoredTheme);
  const [colorTheme, setColorThemeState] = useState<ColorTheme>(getStoredColorTheme);
  // All other settings use defaults — daemon is the source of truth.
  // State is `string` (not just the known union) to preserve unknown values
  // from other branches without silently dropping them.
  const [defaultRuntime, setDefaultRuntimeState] = useState<string>("python");
  const [defaultPythonEnv, setDefaultPythonEnvState] = useState<string>("uv");
  const [defaultUvPackages, setDefaultUvPackagesState] = useState<string[]>([]);
  const [defaultCondaPackages, setDefaultCondaPackagesState] = useState<string[]>([]);
  const [defaultPixiPackages, setDefaultPixiPackagesState] = useState<string[]>([]);
  const [installDefaultDataPackages, setInstallDefaultDataPackagesState] = useState<boolean>(true);
  // Keep-alive duration in seconds (5s to 7 days)
  const [keepAliveSecs, setKeepAliveSecsState] = useState<number>(30);
  // Feature flags (auto-derived from FEATURE_FLAG_METADATA)
  const [featureFlags, setFeatureFlagsState] = useState<FeatureFlagValues>(FEATURE_FLAG_DEFAULTS);
  // Telemetry state — surfaced to Settings → Privacy and the onboarding flow.
  const [telemetryEnabled, setTelemetryEnabledState] = useState<boolean>(true);
  const [telemetryConsentRecorded, setTelemetryConsentRecordedState] = useState<boolean>(false);
  const [redactEnvValuesInOutputs, setRedactEnvValuesInOutputsState] = useState<boolean>(true);
  const [importShellEnvironment, setImportShellEnvironmentState] = useState<boolean>(true);
  const [installId, setInstallIdState] = useState<string>("");
  const [lastDaemonPingAt, setLastDaemonPingAtState] = useState<number | null>(null);
  const [lastAppPingAt, setLastAppPingAtState] = useState<number | null>(null);
  const [lastMcpPingAt, setLastMcpPingAtState] = useState<number | null>(null);

  const applySettingsSnapshot = useCallback((settings: HostSyncedSettings) => {
    if (isValidTheme(settings.theme)) {
      setThemeState(settings.theme);
      setStoredTheme(settings.theme);
    }
    if (isValidColorTheme(settings.color_theme)) {
      setColorThemeState(settings.color_theme);
      setStoredColorTheme(settings.color_theme);
    }
    if (typeof settings.default_runtime === "string") {
      setDefaultRuntimeState(settings.default_runtime);
    }
    if (typeof settings.default_python_env === "string") {
      setDefaultPythonEnvState(settings.default_python_env);
    }
    if (Array.isArray(settings.uv?.default_packages)) {
      setDefaultUvPackagesState(settings.uv.default_packages);
    }
    if (Array.isArray(settings.conda?.default_packages)) {
      setDefaultCondaPackagesState(settings.conda.default_packages);
    }
    if (Array.isArray(settings.pixi?.default_packages)) {
      setDefaultPixiPackagesState(settings.pixi.default_packages);
    }
    if (typeof settings.install_default_data_packages === "boolean") {
      setInstallDefaultDataPackagesState(settings.install_default_data_packages);
    }
    // Handle keep_alive_secs: bigint from backend, convert to number.
    if (typeof settings.keep_alive_secs === "bigint") {
      setKeepAliveSecsState(Number(settings.keep_alive_secs));
    } else if (typeof settings.keep_alive_secs === "number") {
      setKeepAliveSecsState(settings.keep_alive_secs);
    }
    setFeatureFlagsState((prev) => readFeatureFlags(settings, prev));
    if (typeof settings.telemetry_enabled === "boolean") {
      setTelemetryEnabledState(settings.telemetry_enabled);
    }
    if (typeof settings.telemetry_consent_recorded === "boolean") {
      setTelemetryConsentRecordedState(settings.telemetry_consent_recorded);
    }
    if (typeof settings.redact_env_values_in_outputs === "boolean") {
      setRedactEnvValuesInOutputsState(settings.redact_env_values_in_outputs);
    }
    if (typeof settings.import_shell_environment === "boolean") {
      setImportShellEnvironmentState(settings.import_shell_environment);
    }
    if (typeof settings.install_id === "string") {
      setInstallIdState(settings.install_id);
    }
    setLastDaemonPingAtState(numOrBigint(settings.telemetry_last_daemon_ping_at));
    setLastAppPingAtState(numOrBigint(settings.telemetry_last_app_ping_at));
    setLastMcpPingAtState(numOrBigint(settings.telemetry_last_mcp_ping_at));
  }, []);

  // Load initial settings from daemon
  useEffect(() => {
    let active = true;

    host.settings
      .getSynced()
      .then((settings) => {
        if (!active) return;
        applySettingsSnapshot(settings);
      })
      .catch(() => {
        // Host settings unavailable — defaults are fine.
      });

    return () => {
      active = false;
    };
  }, [applySettingsSnapshot, host]);

  // Listen for cross-window settings changes via Tauri events
  useEffect(() => {
    let active = true;

    const unlisten = host.settings.onChanged((settings) => {
      if (!active) return;
      applySettingsSnapshot(settings);
    });
    return () => {
      active = false;
      unlisten();
    };
  }, [applySettingsSnapshot, host]);

  const setTheme = useCallback(
    (newTheme: ThemeMode) => {
      setThemeState(newTheme);
      setStoredTheme(newTheme);
      persistSyncedSetting(host, "theme", newTheme, "[settings] Failed to persist theme:");
    },
    [host],
  );

  const setColorTheme = useCallback(
    (newColorTheme: ColorTheme) => {
      setColorThemeState(newColorTheme);
      setStoredColorTheme(newColorTheme);
      persistSyncedSetting(
        host,
        "color_theme",
        newColorTheme,
        "[settings] Failed to persist color theme:",
      );
    },
    [host],
  );

  const setDefaultRuntime = useCallback(
    (newRuntime: string) => {
      setDefaultRuntimeState(newRuntime);
      persistSyncedSetting(
        host,
        "default_runtime",
        newRuntime,
        "[settings] Failed to persist runtime:",
      );
    },
    [host],
  );

  const setDefaultPythonEnv = useCallback(
    (newEnv: string) => {
      setDefaultPythonEnvState(newEnv);
      persistSyncedSetting(
        host,
        "default_python_env",
        newEnv,
        "[settings] Failed to persist python env:",
      );
    },
    [host],
  );

  const setDefaultUvPackages = useCallback(
    (packages: string[]) => {
      setDefaultUvPackagesState(packages);
      persistSyncedSetting(
        host,
        "uv.default_packages",
        packages,
        "[settings] Failed to persist uv packages:",
      );
    },
    [host],
  );

  const setDefaultCondaPackages = useCallback(
    (packages: string[]) => {
      setDefaultCondaPackagesState(packages);
      persistSyncedSetting(
        host,
        "conda.default_packages",
        packages,
        "[settings] Failed to persist conda packages:",
      );
    },
    [host],
  );

  const setDefaultPixiPackages = useCallback(
    (packages: string[]) => {
      setDefaultPixiPackagesState(packages);
      persistSyncedSetting(
        host,
        "pixi.default_packages",
        packages,
        "[settings] Failed to persist pixi packages:",
      );
    },
    [host],
  );

  const setInstallDefaultDataPackages = useCallback(
    (enabled: boolean) => {
      setInstallDefaultDataPackagesState(enabled);
      persistSyncedSetting(
        host,
        "install_default_data_packages",
        enabled,
        "[settings] Failed to persist install_default_data_packages:",
      );
    },
    [host],
  );

  const setKeepAliveSecs = useCallback(
    (secs: number) => {
      setKeepAliveSecsState(secs);
      persistSyncedSetting(
        host,
        "keep_alive_secs",
        secs,
        "[settings] Failed to persist keep_alive_secs:",
      );
    },
    [host],
  );

  const setFeatureFlag = useCallback(
    (id: FeatureFlagId, enabled: boolean) => {
      setFeatureFlagsState((prev) => ({ ...prev, [id]: enabled }));
      persistSyncedSetting(host, id, enabled, `[settings] Failed to persist ${id}:`);
    },
    [host],
  );

  const setTelemetryEnabled = useCallback(
    (value: boolean) => {
      setTelemetryEnabledState(value);
      persistSyncedSetting(
        host,
        "telemetry_enabled",
        value,
        "[settings] Failed to persist telemetry_enabled:",
      );
    },
    [host],
  );

  const setTelemetryConsentRecorded = useCallback(
    (value: boolean) => {
      setTelemetryConsentRecordedState(value);
      persistSyncedSetting(
        host,
        "telemetry_consent_recorded",
        value,
        "[settings] Failed to persist telemetry_consent_recorded:",
      );
    },
    [host],
  );

  const setRedactEnvValuesInOutputs = useCallback(
    (value: boolean) => {
      setRedactEnvValuesInOutputsState(value);
      persistSyncedSetting(
        host,
        "redact_env_values_in_outputs",
        value,
        "[settings] Failed to persist redact_env_values_in_outputs:",
      );
    },
    [host],
  );

  const setImportShellEnvironment = useCallback(
    (value: boolean) => {
      setImportShellEnvironmentState(value);
      persistSyncedSetting(
        host,
        "import_shell_environment",
        value,
        "[settings] Failed to persist import_shell_environment:",
      );
    },
    [host],
  );

  const rotateInstallId = useCallback(async (): Promise<string | null> => {
    try {
      const newId = await host.settings.rotateInstallId();
      setInstallIdState(newId);
      setLastDaemonPingAtState(null);
      setLastAppPingAtState(null);
      setLastMcpPingAtState(null);
      return newId;
    } catch (e) {
      console.warn("[settings] Failed to rotate install_id:", e);
      return null;
    }
  }, [host]);

  return {
    theme,
    setTheme,
    colorTheme,
    setColorTheme,
    defaultRuntime,
    setDefaultRuntime,
    defaultPythonEnv,
    setDefaultPythonEnv,
    defaultUvPackages,
    setDefaultUvPackages,
    defaultCondaPackages,
    setDefaultCondaPackages,
    defaultPixiPackages,
    setDefaultPixiPackages,
    installDefaultDataPackages,
    setInstallDefaultDataPackages,
    keepAliveSecs,
    setKeepAliveSecs,
    featureFlags,
    setFeatureFlag,
    telemetryEnabled,
    setTelemetryEnabled,
    telemetryConsentRecorded,
    setTelemetryConsentRecorded,
    redactEnvValuesInOutputs,
    setRedactEnvValuesInOutputs,
    importShellEnvironment,
    setImportShellEnvironment,
    installId,
    rotateInstallId,
    lastDaemonPingAt,
    lastAppPingAt,
    lastMcpPingAt,
  };
}

/**
 * Read feature flag values from a settings snapshot, falling back to the
 * current known values when a flag is missing or malformed.
 */
function readFeatureFlags(
  settings: Partial<Record<FeatureFlagId, unknown>>,
  prev: FeatureFlagValues,
): FeatureFlagValues {
  const next: FeatureFlagValues = { ...prev };
  for (const id of Object.keys(FEATURE_FLAG_METADATA) as FeatureFlagId[]) {
    const value = settings[id];
    if (typeof value === "boolean") {
      next[id] = value;
    }
  }
  return next;
}

function numOrBigint(v: unknown): number | null {
  // Pings are Option<u64> in Rust — bigint over the wire for large values.
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  return null;
}

/**
 * Hook for theme that syncs across all notebook windows via runtimed.
 *
 * Wraps useSyncedSettings() and adds DOM/native window theme application.
 * Falls back to localStorage if the daemon is unavailable.
 */
export function useSyncedTheme() {
  const host = useNotebookHost();
  const { theme, setTheme, colorTheme, setColorTheme, defaultPythonEnv } = useSyncedSettings();

  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">(() => resolveTheme(theme));

  // Apply theme to DOM and native window
  useEffect(() => {
    const resolved = resolveTheme(theme);
    setResolvedTheme(resolved);
    applyThemeToDOM(resolved);
    syncNativeWindowTheme(host, theme);

    if (theme !== "system") return;

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      const newResolved = resolveTheme("system");
      setResolvedTheme(newResolved);
      applyThemeToDOM(newResolved);
    };
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [host, theme]);

  // Apply color theme to DOM so iframes can read it
  useEffect(() => {
    const html = document.documentElement;
    if (colorTheme === "classic") {
      html.removeAttribute("data-color-theme");
    } else {
      html.setAttribute("data-color-theme", colorTheme);
    }
  }, [colorTheme]);

  return { theme, setTheme, colorTheme, setColorTheme, resolvedTheme, defaultPythonEnv };
}

import { useCallback, useEffect, useState } from "react";
import type { ColorTheme, PythonEnvType, Runtime, SyncedSettings, ThemeMode } from "@/bindings";

// Re-export generated types so consumers can import from this module.
export type { ColorTheme, ThemeMode, Runtime, PythonEnvType };

type NativeTheme = "light" | "dark" | null;
type Unlisten = () => void;

function isTauriRuntime(): boolean {
  const globalWindow = window as Window & {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
  };
  return "__TAURI_INTERNALS__" in globalWindow || "__TAURI__" in globalWindow;
}

async function invokeTauri<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriRuntime()) {
    throw new Error("Tauri runtime unavailable");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

async function listenTauri<T>(
  eventName: string,
  handler: (event: { payload: T }) => void,
): Promise<Unlisten> {
  if (!isTauriRuntime()) {
    return () => {};
  }
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(eventName, handler);
}

function isValidColorTheme(value: string): value is ColorTheme {
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

async function syncNativeWindowTheme(theme: ThemeMode): Promise<void> {
  try {
    if (!isTauriRuntime()) return;
    const tauriTheme: NativeTheme = theme === "system" ? null : theme;
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setTheme(tauriTheme);
  } catch {
    // Silently fail if not in Tauri context
  }
}

function persistSyncedSetting(key: string, value: unknown, warning: string): void {
  invokeTauri("set_synced_setting", { key, value }).catch((e) => {
    if (isTauriRuntime()) {
      console.warn(warning, e);
    }
  });
}

function isValidTheme(value: string): value is ThemeMode {
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
 * Mirrors the `FeatureFlags` struct on the Rust side. The TS source of truth
 * is intentionally flat (each flag is a top-level boolean on `SyncedSettings`)
 * so that adding a new flag is one field here, one struct field in Rust, and
 * one entry in the settings UI — no schema migration.
 *
 * Adding a flag:
 *  1. Add `flag_id: boolean` to `FeatureFlags` in Rust + the matching field
 *     on `SyncedSettings`.
 *  2. Add `flag_id: { label, description }` below.
 *  3. Done — the settings UI renders a toggle automatically.
 */
export const FEATURE_FLAG_METADATA = {
  bootstrap_dx: {
    label: "Rich DataFrames and Exceptions",
    description: "Enable the nteract kernel launcher into Python runtimes.",
  },
} as const satisfies Record<string, { label: string; description: string }>;

export type FeatureFlagId = keyof typeof FEATURE_FLAG_METADATA;
export type FeatureFlagValues = Record<FeatureFlagId, boolean>;

const FEATURE_FLAG_DEFAULTS: FeatureFlagValues = {
  bootstrap_dx: false,
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
  const [installId, setInstallIdState] = useState<string>("");
  const [lastDaemonPingAt, setLastDaemonPingAtState] = useState<number | null>(null);
  const [lastAppPingAt, setLastAppPingAtState] = useState<number | null>(null);
  const [lastMcpPingAt, setLastMcpPingAtState] = useState<number | null>(null);

  // Load initial settings from daemon
  useEffect(() => {
    invokeTauri<SyncedSettings>("get_synced_settings")
      .then((settings) => {
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
        // Handle keep_alive_secs: bigint from backend, convert to number
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
        if (typeof settings.install_id === "string") {
          setInstallIdState(settings.install_id);
        }
        // Pings are Option<u64> in Rust — bigint over the wire for large values.
        const numOrBigint = (v: unknown): number | null => {
          if (typeof v === "number") return v;
          if (typeof v === "bigint") return Number(v);
          return null;
        };
        setLastDaemonPingAtState(numOrBigint(settings.telemetry_last_daemon_ping_at));
        setLastAppPingAtState(numOrBigint(settings.telemetry_last_app_ping_at));
        setLastMcpPingAtState(numOrBigint(settings.telemetry_last_mcp_ping_at));
      })
      .catch(() => {
        // Daemon unavailable — defaults are fine
      });
  }, []);

  // Listen for cross-window settings changes via Tauri events
  useEffect(() => {
    const unlisten = listenTauri<SyncedSettings>("settings:changed", (event) => {
      const {
        theme: newTheme,
        color_theme: newColorTheme,
        default_runtime,
        default_python_env,
        keep_alive_secs,
      } = event.payload;
      if (isValidTheme(newTheme)) {
        setThemeState(newTheme);
        setStoredTheme(newTheme);
      }
      if (isValidColorTheme(newColorTheme)) {
        setColorThemeState(newColorTheme);
        setStoredColorTheme(newColorTheme);
      }
      if (typeof default_runtime === "string") {
        setDefaultRuntimeState(default_runtime);
      }
      if (typeof default_python_env === "string") {
        setDefaultPythonEnvState(default_python_env);
      }
      if (Array.isArray(event.payload.uv?.default_packages)) {
        setDefaultUvPackagesState(event.payload.uv.default_packages);
      }
      if (Array.isArray(event.payload.conda?.default_packages)) {
        setDefaultCondaPackagesState(event.payload.conda.default_packages);
      }
      if (Array.isArray(event.payload.pixi?.default_packages)) {
        setDefaultPixiPackagesState(event.payload.pixi.default_packages);
      }
      if (typeof event.payload.install_default_data_packages === "boolean") {
        setInstallDefaultDataPackagesState(event.payload.install_default_data_packages);
      }
      // Handle keep_alive_secs: bigint from backend, convert to number
      if (typeof keep_alive_secs === "bigint") {
        setKeepAliveSecsState(Number(keep_alive_secs));
      } else if (typeof keep_alive_secs === "number") {
        setKeepAliveSecsState(keep_alive_secs);
      }
      setFeatureFlagsState((prev) => readFeatureFlags(event.payload, prev));
      if (typeof event.payload.telemetry_enabled === "boolean") {
        setTelemetryEnabledState(event.payload.telemetry_enabled);
      }
      if (typeof event.payload.telemetry_consent_recorded === "boolean") {
        setTelemetryConsentRecordedState(event.payload.telemetry_consent_recorded);
      }
      if (typeof event.payload.install_id === "string") {
        setInstallIdState(event.payload.install_id);
      }
      // Last-ping timestamps change rarely; we only refresh them on mount.
    });
    return () => {
      unlisten.then((u) => u());
    };
  }, []);

  const setTheme = useCallback((newTheme: ThemeMode) => {
    setThemeState(newTheme);
    setStoredTheme(newTheme);
    persistSyncedSetting("theme", newTheme, "[settings] Failed to persist theme:");
  }, []);

  const setColorTheme = useCallback((newColorTheme: ColorTheme) => {
    setColorThemeState(newColorTheme);
    setStoredColorTheme(newColorTheme);
    persistSyncedSetting("color_theme", newColorTheme, "[settings] Failed to persist color theme:");
  }, []);

  const setDefaultRuntime = useCallback((newRuntime: string) => {
    setDefaultRuntimeState(newRuntime);
    persistSyncedSetting("default_runtime", newRuntime, "[settings] Failed to persist runtime:");
  }, []);

  const setDefaultPythonEnv = useCallback((newEnv: string) => {
    setDefaultPythonEnvState(newEnv);
    persistSyncedSetting("default_python_env", newEnv, "[settings] Failed to persist python env:");
  }, []);

  const setDefaultUvPackages = useCallback((packages: string[]) => {
    setDefaultUvPackagesState(packages);
    persistSyncedSetting(
      "uv.default_packages",
      packages,
      "[settings] Failed to persist uv packages:",
    );
  }, []);

  const setDefaultCondaPackages = useCallback((packages: string[]) => {
    setDefaultCondaPackagesState(packages);
    persistSyncedSetting(
      "conda.default_packages",
      packages,
      "[settings] Failed to persist conda packages:",
    );
  }, []);

  const setDefaultPixiPackages = useCallback((packages: string[]) => {
    setDefaultPixiPackagesState(packages);
    persistSyncedSetting(
      "pixi.default_packages",
      packages,
      "[settings] Failed to persist pixi packages:",
    );
  }, []);

  const setInstallDefaultDataPackages = useCallback((enabled: boolean) => {
    setInstallDefaultDataPackagesState(enabled);
    persistSyncedSetting(
      "install_default_data_packages",
      enabled,
      "[settings] Failed to persist install_default_data_packages:",
    );
  }, []);

  const setKeepAliveSecs = useCallback((secs: number) => {
    setKeepAliveSecsState(secs);
    persistSyncedSetting("keep_alive_secs", secs, "[settings] Failed to persist keep_alive_secs:");
  }, []);

  const setFeatureFlag = useCallback((id: FeatureFlagId, enabled: boolean) => {
    setFeatureFlagsState((prev) => ({ ...prev, [id]: enabled }));
    persistSyncedSetting(id, enabled, `[settings] Failed to persist ${id}:`);
  }, []);

  const setTelemetryEnabled = useCallback((value: boolean) => {
    setTelemetryEnabledState(value);
    persistSyncedSetting(
      "telemetry_enabled",
      value,
      "[settings] Failed to persist telemetry_enabled:",
    );
  }, []);

  const setTelemetryConsentRecorded = useCallback((value: boolean) => {
    setTelemetryConsentRecordedState(value);
    persistSyncedSetting(
      "telemetry_consent_recorded",
      value,
      "[settings] Failed to persist telemetry_consent_recorded:",
    );
  }, []);

  const rotateInstallId = useCallback(async (): Promise<string | null> => {
    try {
      const newId = await invokeTauri<string>("rotate_install_id");
      setInstallIdState(newId);
      setLastDaemonPingAtState(null);
      setLastAppPingAtState(null);
      setLastMcpPingAtState(null);
      return newId;
    } catch (e) {
      console.warn("[settings] Failed to rotate install_id:", e);
      return null;
    }
  }, []);

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

/**
 * Hook for theme that syncs across all notebook windows via runtimed.
 *
 * Wraps useSyncedSettings() and adds DOM/native window theme application.
 * Falls back to localStorage if the daemon is unavailable.
 */
export function useSyncedTheme() {
  const { theme, setTheme, colorTheme, setColorTheme, defaultPythonEnv } = useSyncedSettings();

  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">(() => resolveTheme(theme));

  // Apply theme to DOM and native window
  useEffect(() => {
    const resolved = resolveTheme(theme);
    setResolvedTheme(resolved);
    applyThemeToDOM(resolved);
    syncNativeWindowTheme(theme);

    if (theme !== "system") return;

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      const newResolved = resolveTheme("system");
      setResolvedTheme(newResolved);
      applyThemeToDOM(newResolved);
    };
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [theme]);

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

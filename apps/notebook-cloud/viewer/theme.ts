import { CLOUD_VIEWER_THEME_STORAGE_KEY } from "../src/viewer-theme-bootstrap.ts";
export { CLOUD_VIEWER_THEME_STORAGE_KEY } from "../src/viewer-theme-bootstrap.ts";

export type CloudViewerThemeMode = "light" | "dark" | "system";
export type ResolvedCloudViewerTheme = "light" | "dark";

export function storedCloudViewerTheme(
  storage: Pick<Storage, "getItem"> | undefined = browserLocalStorage(),
): CloudViewerThemeMode {
  try {
    const stored = storage?.getItem(CLOUD_VIEWER_THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
  } catch {
    // localStorage may be unavailable in private or embedded contexts.
  }
  return "system";
}

export function resolveCloudViewerTheme(
  theme: CloudViewerThemeMode,
  systemPrefersDark = prefersDarkTheme(),
): ResolvedCloudViewerTheme {
  if (theme === "system") return systemPrefersDark ? "dark" : "light";
  return theme;
}

export function applyDocumentTheme(theme: ResolvedCloudViewerTheme): void {
  if (typeof document === "undefined") return;

  const isDark = theme === "dark";
  document.documentElement.classList.toggle("dark", isDark);
  document.documentElement.classList.toggle("light", !isDark);
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

export function installDocumentThemeSync(): void {
  applyDocumentTheme(resolveCloudViewerTheme(storedCloudViewerTheme()));
}

function prefersDarkTheme(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function browserLocalStorage(): Pick<Storage, "getItem"> | undefined {
  if (typeof window === "undefined") return undefined;
  return window.localStorage;
}

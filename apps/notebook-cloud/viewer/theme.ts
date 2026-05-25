import { useCallback, useEffect, useState } from "react";
import type { ThemeMode } from "@/hooks/useTheme";

export const CLOUD_THEME_STORAGE_KEY = "nteract:notebook-cloud:theme";

type ThemeStorage = Pick<Storage, "getItem" | "setItem">;

export function isCloudThemeMode(value: string | null | undefined): value is ThemeMode {
  return value === "light" || value === "dark" || value === "system";
}

export function storedCloudThemeMode(storage: Pick<Storage, "getItem"> | undefined): ThemeMode {
  if (!storage) return "system";
  try {
    const stored = storage.getItem(CLOUD_THEME_STORAGE_KEY);
    if (isCloudThemeMode(stored)) return stored;
  } catch {
    // localStorage can be unavailable in private or locked-down contexts.
  }
  return "system";
}

export function resolveCloudThemeMode(
  theme: ThemeMode,
  systemPrefersDark = systemPrefersDarkMode(),
): "light" | "dark" {
  if (theme === "system") {
    return systemPrefersDark ? "dark" : "light";
  }
  return theme;
}

export function applyCloudTheme(theme: ThemeMode): "light" | "dark" {
  const resolved = resolveCloudThemeMode(theme);
  if (typeof document === "undefined") return resolved;

  const html = document.documentElement;
  html.classList.toggle("dark", resolved === "dark");
  html.classList.toggle("light", resolved === "light");
  html.dataset.theme = resolved;
  html.style.colorScheme = resolved;
  return resolved;
}

export function setStoredCloudThemeMode(theme: ThemeMode, storage: ThemeStorage | undefined): void {
  if (!storage) return;
  try {
    storage.setItem(CLOUD_THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore localStorage failures; the in-memory React state still applies.
  }
}

export function installDocumentThemeSync(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  applyCloudTheme(storedCloudThemeMode(window.localStorage));
}

export function useCloudTheme() {
  const [theme, setThemeState] = useState<ThemeMode>(() =>
    typeof window === "undefined" ? "system" : storedCloudThemeMode(window.localStorage),
  );
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">(() =>
    resolveCloudThemeMode(theme),
  );

  const setTheme = useCallback((nextTheme: ThemeMode) => {
    setThemeState(nextTheme);
    setStoredCloudThemeMode(
      nextTheme,
      typeof window === "undefined" ? undefined : window.localStorage,
    );
  }, []);

  useEffect(() => {
    setResolvedTheme(applyCloudTheme(theme));
    if (theme !== "system") return;

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemThemeChange = () => setResolvedTheme(applyCloudTheme("system"));
    mediaQuery.addEventListener("change", onSystemThemeChange);
    return () => mediaQuery.removeEventListener("change", onSystemThemeChange);
  }, [theme]);

  return { theme, setTheme, resolvedTheme };
}

function systemPrefersDarkMode(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

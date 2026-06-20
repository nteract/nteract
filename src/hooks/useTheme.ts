import { useCallback, useEffect, useState } from "react";

export type ThemeMode = "light" | "dark" | "system";

function getStoredTheme(storageKey: string): ThemeMode {
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
  } catch {
    // localStorage may not be available
  }
  return "system";
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

export function useTheme(storageKey = "theme") {
  const [theme, setThemeState] = useState<ThemeMode>(() => getStoredTheme(storageKey));
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">(() =>
    resolveTheme(getStoredTheme(storageKey)),
  );

  const setTheme = useCallback(
    (newTheme: ThemeMode) => {
      setThemeState(newTheme);
      try {
        localStorage.setItem(storageKey, newTheme);
      } catch {
        // ignore
      }
    },
    [storageKey],
  );

  useEffect(() => {
    const resolved = resolveTheme(theme);
    setResolvedTheme(resolved);
    applyThemeToDOM(resolved);

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

  return { theme, setTheme, resolvedTheme };
}

import { useCallback, useEffect, useState } from "react";
import type { ColorTheme } from "@/bindings";

export function isValidColorTheme(value: string): value is ColorTheme {
  return value === "classic" || value === "cream";
}

function getStoredColorTheme(storageKey: string): ColorTheme {
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored && isValidColorTheme(stored)) {
      return stored;
    }
  } catch {
    // ignore
  }
  return "classic";
}

function applyColorThemeToDOM(colorTheme: ColorTheme) {
  const html = document.documentElement;
  if (colorTheme === "classic") {
    html.removeAttribute("data-color-theme");
  } else {
    html.setAttribute("data-color-theme", colorTheme);
  }
}

export function useColorThemePreference(storageKey: string) {
  const [colorTheme, setColorThemeState] = useState<ColorTheme>(() =>
    getStoredColorTheme(storageKey),
  );

  const setColorTheme = useCallback(
    (next: ColorTheme) => {
      setColorThemeState(next);
      try {
        localStorage.setItem(storageKey, next);
      } catch {
        // ignore
      }
    },
    [storageKey],
  );

  useEffect(() => {
    applyColorThemeToDOM(colorTheme);
  }, [colorTheme]);

  return { colorTheme, setColorTheme };
}

// The same light/dark/system contract as nteract's useTheme.
// Preferences belong to this browser, never the Page.
export const MODE_KEY = "nteract.pages.theme";
export const THEME_MODES = ["system", "light", "dark"];

export function readThemePreferences(browser) {
  function read(key) {
    try {
      return browser?.localStorage?.getItem(key);
    } catch {
      return null;
    }
  }
  const mode = read(MODE_KEY);
  return {
    mode: THEME_MODES.includes(mode) ? mode : "system",
  };
}

export function applyTheme(preferences, browser) {
  const resolved =
    preferences.mode === "system"
      ? browser?.matchMedia?.("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : preferences.mode;
  const root = browser?.document?.documentElement;
  if (root) {
    root.classList.toggle("dark", resolved === "dark");
    root.classList.toggle("light", resolved === "light");
    root.dataset.theme = resolved;
    root.style.colorScheme = resolved;
  }
  return { ...preferences, resolved };
}

export function createThemeStore(browser) {
  let state = applyTheme(readThemePreferences(browser), browser);
  const listeners = new Set();
  const media = browser?.matchMedia?.("(prefers-color-scheme: dark)");
  function update(preferences) {
    const next = applyTheme(preferences, browser);
    if (next.mode === state.mode && next.resolved === state.resolved) return;
    state = next;
    for (const listener of listeners) listener();
  }
  const systemChanged = () => update(state);
  const storageChanged = (event) => {
    if (event.key === null || event.key === MODE_KEY) update(readThemePreferences(browser));
  };
  return {
    getSnapshot: () => state,
    subscribe(listener) {
      if (!listeners.size) {
        media?.addEventListener("change", systemChanged);
        browser?.addEventListener("storage", storageChanged);
        // Catch a system/storage change between first paint and subscription.
        update(readThemePreferences(browser));
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          media?.removeEventListener("change", systemChanged);
          browser?.removeEventListener("storage", storageChanged);
        }
      };
    },
    setMode(value) {
      if (!THEME_MODES.includes(value)) return;
      try {
        browser?.localStorage?.setItem(MODE_KEY, value);
      } catch {
        // Embedded/private browsers can still change appearance for this visit.
      }
      update({ mode: value });
    },
  };
}

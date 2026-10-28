import { applyTheme, readThemePreferences } from "./theme.mjs";

// Small synchronous head script; no editor, React or WASM on the first-paint path.
applyTheme(readThemePreferences(window), window);

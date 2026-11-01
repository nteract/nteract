import { startEarlySession } from "./early-session.mjs";
import { applyTheme, readThemePreferences } from "./theme.mjs";

// Small synchronous head script; no editor, React or WASM on the first-paint path.
applyTheme(readThemePreferences(window), window);
// Leaves the session request on window for the viewer's first refresh to take
// (early-session.mjs); it runs while app.js and the WASM files download.
startEarlySession(window);

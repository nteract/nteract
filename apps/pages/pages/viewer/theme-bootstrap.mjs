import { startEarlyConnect, startEarlySession } from "./early-session.mjs";
import { applyTheme, readThemePreferences } from "./theme.mjs";

// Small synchronous head script; no editor, React or WASM on the first-paint path.
applyTheme(readThemePreferences(window), window);
// Leaves the session request, and on a Page route its connection discovery,
// on window for the viewer to take (early-session.mjs). They run while app.js
// and the WASM files download.
startEarlySession(window);
startEarlyConnect(window);

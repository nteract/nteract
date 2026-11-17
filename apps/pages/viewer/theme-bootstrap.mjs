import { startEarlyConnect, startEarlySession } from "./early-session.mjs";
import { applyTheme, readThemePreferences } from "./theme.mjs";
import { readPageRoute } from "../shared/routes.mjs";
import { editorBoot, preloadWasm } from "./wasm-preload.mjs";

// Small synchronous head script; no editor, React or WASM on the first-paint path.
applyTheme(readThemePreferences(window), window);
// Where the editor starts at boot it waits for Automerge's WASM: start that
// download now, beside app.js, at the route's priority. This blocking script
// is the earliest code that sees the address (the shell is one static file
// for every route, and the CSP admits no inline script).
{
  const { start, priority } = editorBoot(readPageRoute(window.location.href));
  if (start) preloadWasm(window.document, { priority });
}
// Leaves the session request, and on a Page route its connection discovery,
// on window for the viewer to take (early-session.mjs). They run while app.js
// and the WASM files download.
startEarlySession(window);
startEarlyConnect(window);

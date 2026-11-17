import { startEarlyConnect, startEarlySession } from "./early-session.mjs";
import { applyTheme, readThemePreferences } from "./theme.mjs";
import { readPageRoute } from "../shared/routes.mjs";
import { opensDocument, preloadWasm } from "./wasm-preload.mjs";

// Small synchronous head script; no editor, React or WASM on the first-paint path.
applyTheme(readThemePreferences(window), window);
// On a route that opens a document, the editor starts at boot and waits for
// Automerge's WASM: start that download now, beside app.js. This blocking
// script is the earliest code that sees the address (the shell is one static
// file for every route, and the CSP admits no inline script). A listing
// route leaves it to the editor's start (editor-start-machine.mjs).
if (opensDocument(readPageRoute(window.location.href))) preloadWasm(window.document);
// Leaves the session request, and on a Page route its connection discovery,
// on window for the viewer to take (early-session.mjs). They run while app.js
// and the WASM files download.
startEarlySession(window);
startEarlyConnect(window);

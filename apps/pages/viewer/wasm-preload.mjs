// The preload for Automerge's WASM, which the editor chunk awaits before a
// Page opens (scripts/browser-wasm.mjs). The shell doesn't name it: theme.js
// adds it in <head> on a route that opens a document, and the editor loader
// adds it when it starts the import anywhere else, so the download overlaps
// the editor chunk's instead of following it.
//
// The preload must match the chunk's fetch(url): same URL, and crossorigin,
// so the preload is a CORS same-origin-credentials request like fetch(url).
// Otherwise the browser downloads the file twice.

/* global __PAGES_AUTOMERGE_WASM_URL__ */
/** scripts/build.mjs defines the content-hashed URL in theme.js and app.js.
 * Unbundled code (tests) gets the source name. */
export const AUTOMERGE_WASM_URL =
  typeof __PAGES_AUTOMERGE_WASM_URL__ === "string"
    ? __PAGES_AUTOMERGE_WASM_URL__
    : "/automerge.wasm";

/** Route kinds (shared/routes.mjs) whose first screen is a document. */
const DOCUMENT_ROUTES = Object.freeze(["page", "project"]);
export const opensDocument = (route) => DOCUMENT_ROUTES.includes(route?.kind);

/** Add the WASM preload to `page`'s head unless it has one. Returns whether
 * it added one. */
export function preloadWasm(page, url = AUTOMERGE_WASM_URL) {
  const head = page?.head;
  if (!head) return false;
  for (const link of head.querySelectorAll('link[rel="preload"]'))
    if (link.getAttribute("href") === url) return false;
  const link = page.createElement("link");
  link.setAttribute("rel", "preload");
  link.setAttribute("as", "fetch");
  link.setAttribute("crossorigin", "anonymous");
  link.setAttribute("href", url);
  head.append(link);
  return true;
}

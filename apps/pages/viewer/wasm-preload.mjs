// When the Page editor starts, and the preload for Automerge's WASM, which
// the editor chunk awaits before a Page opens (scripts/browser-wasm.mjs).
// The shell doesn't name the WASM: theme.js adds the preload in <head>, beside
// app.js, on a route whose editor starts at boot, so the download overlaps
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

/**
 * Whether the editor starts at boot on `route` (shared/routes.mjs), and the
 * fetch priority of its downloads.
 *
 * - A Page or Project content opens a document, which waits on the editor:
 *   it starts at boot at the default priority (null).
 * - Home (/) lists, but a Page usually opens next: the editor starts at boot
 *   at low priority, so the first screen's card images keep the link.
 * - Anything else waits until a Page opens: the index routes (/pages,
 *   /projects), which only list, and a missing route, which also covers the
 *   Worker's own pages that load theme.js (/connect, OAuth).
 */
export function editorBoot(route) {
  if (route?.kind === "page" || route?.kind === "project") return { start: true, priority: null };
  if (route?.kind === "home") return { start: true, priority: "low" };
  return { start: false, priority: null };
}

/** Add the WASM preload to `page`'s head unless it has one. Returns whether
 * it added one. `priority` sets `fetchpriority`; the chunk's fetch(url) still
 * reuses the preload, since priority isn't part of the match. */
export function preloadWasm(page, { url = AUTOMERGE_WASM_URL, priority = null } = {}) {
  const head = page?.head;
  if (!head) return false;
  for (const link of head.querySelectorAll('link[rel="preload"]'))
    if (link.getAttribute("href") === url) return false;
  const link = page.createElement("link");
  link.setAttribute("rel", "preload");
  link.setAttribute("as", "fetch");
  link.setAttribute("crossorigin", "anonymous");
  if (priority) link.setAttribute("fetchpriority", priority);
  link.setAttribute("href", url);
  head.append(link);
  return true;
}

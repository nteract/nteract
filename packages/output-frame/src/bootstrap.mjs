// The output frame's document: a fixed bootstrap that runs the runtime its
// embedding parent sends. The runtime travels with the page, so the host and
// the runtime always come from one build, and this document has no reason to
// change when they do. It knows nothing about protocol versions, ports, views,
// data or catalogs.
//
// BOOTSTRAP_SCRIPT, the document's one script, in full:
// - It accepts one message, of type BOOT_MESSAGE, from window.parent only,
//   whose `runtime` is a string. Every other message is ignored, and so is
//   every message after the first boot.
// - It runs `runtime` once, as an inline classic script. The frame's CSP
//   allows inline scripts and not eval.
// - The runtime defines window[RUNTIME_ENTRY]. The bootstrap removes it and
//   calls it once with the boot MessageEvent, untouched: its data and its
//   transferred ports are the runtime's to read (runtime.mjs).
// - If running the runtime throws, it defines no entry, or the entry throws,
//   the bootstrap posts {type: BOOT_FAILED_MESSAGE} to the parent and stops.
//
// It is a classic script, not a module, so the import map a catalog server
// places before it, and the one the runtime appends at mount, still apply in
// Firefox. A change to this text or to BOOTSTRAP_HTML needs a new frame path
// (apps/pages/shared/output-frame-paths.mjs).
//
// The names it shares with the host and the runtime live in lifecycle.mjs, so
// neither of them bundles this text.
import { BOOT_FAILED_MESSAGE, BOOT_MESSAGE, RUNTIME_ENTRY } from "./lifecycle.mjs";
export { BOOT_FAILED_MESSAGE, BOOT_MESSAGE, RUNTIME_ENTRY };

export const BOOTSTRAP_SCRIPT = `"use strict";
addEventListener("message", function boot(event) {
  var data = event.data;
  if (event.source !== parent || !data || data.type !== "${BOOT_MESSAGE}" || typeof data.runtime !== "string") return;
  removeEventListener("message", boot);
  try {
    var script = document.createElement("script");
    script.textContent = data.runtime;
    document.body.append(script);
    var start = window.${RUNTIME_ENTRY};
    delete window.${RUNTIME_ENTRY};
    start(event);
  } catch {
    parent.postMessage({ type: "${BOOT_FAILED_MESSAGE}" }, "*");
  }
});
`;

// The frame document. The runtime's stylesheet travels with the runtime.
export const BOOTSTRAP_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main></main><script>${BOOTSTRAP_SCRIPT}</script></body></html>`;

// A view's library map: what the viewer sends the frame for a view that pins a
// library catalog (view.catalog_revision). The catalog lives on this origin at
// /catalog/<revision>/ (worker/library-catalog.mjs); its manifest.json maps
// each library to a file, and the revision is the sha256 of the manifest's
// text.
import { Observable, of } from "rxjs";
import { LIBRARY_REVISION, libraryPath } from "../shared/library-catalog.mjs";

export const LIBRARIES_MISSING =
  "This view's libraries are no longer on this host. Save the view again to use the current ones.";
export const LIBRARIES_UNREACHABLE = "This view's libraries didn't load. Retry to try again.";

const FILE = /^[\w-]+\.js$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;

/**
 * What one manifest answer means for the view, decided from the response
 * alone: `status` (an HTTP status, or 0 when the request failed), `text`,
 * the manifest's text, and `digest`, the sha256 hex of that text.
 * - {kind: "ready", libraries, integrity}: the map of name → absolute URL on
 *   `origin`, and each catalog module's URL → its integrity value from the
 *   manifest's sha256, so the frame refuses a module whose bytes differ;
 * - {kind: "missing"}: this host does not have that catalog (404), or it
 *   serves other bytes under its name;
 * - {kind: "failed"}: the request failed or the host answered otherwise, which
 *   a retry may fix.
 */
export function libraryManifestOutcome({ revision, origin, status, text, digest }) {
  if (status === 404) return { kind: "missing", message: LIBRARIES_MISSING };
  if (status !== 200) return { kind: "failed", message: LIBRARIES_UNREACHABLE };
  if (digest !== revision) return { kind: "missing", message: LIBRARIES_MISSING };
  let imports, files;
  try {
    ({ imports, files } = JSON.parse(text));
  } catch {
    return { kind: "missing", message: LIBRARIES_MISSING };
  }
  const isRecord = (value) => value && typeof value === "object" && !Array.isArray(value);
  if (!isRecord(imports) || !isRecord(files))
    return { kind: "missing", message: LIBRARIES_MISSING };
  const libraries = {};
  for (const [name, file] of Object.entries(imports)) {
    if (typeof file !== "string" || !FILE.test(file))
      return { kind: "missing", message: LIBRARIES_MISSING };
    libraries[name] = origin + libraryPath(revision, file);
  }
  // Every module of the catalog, the libraries and the chunks they share,
  // with the sha256 the manifest gives it.
  const integrity = {};
  for (const [file, digest] of Object.entries(files)) {
    if (!FILE.test(file)) continue;
    if (typeof digest !== "string" || !SHA256_HEX.test(digest))
      return { kind: "missing", message: LIBRARIES_MISSING };
    integrity[origin + libraryPath(revision, file)] = sha256Integrity(digest);
  }
  if (Object.values(libraries).some((url) => !Object.hasOwn(integrity, url)))
    return { kind: "missing", message: LIBRARIES_MISSING };
  return { kind: "ready", libraries, integrity };
}

/** An import map integrity value from a sha256 in hex. */
export function sha256Integrity(hex) {
  let binary = "";
  for (let i = 0; i < hex.length; i += 2)
    binary += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return "sha256-" + btoa(binary);
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Ready maps by origin and revision. A revision names its bytes, so a map
// once read never changes. Only a ready map is kept: a missing or failed
// manifest is asked for again on the next load, such as Retry.
const ready = new Map();

/**
 * The manifest step of a mount: one outcome (libraryManifestOutcome) for
 * `revision` on `origin`. A view with no revision has no libraries:
 * {kind: "ready", libraries: undefined}. Unsubscribing aborts the request.
 */
export function libraryMap$(revision, { origin, fetch = globalThis.fetch } = {}) {
  if (revision === undefined || revision === null)
    return of({ kind: "ready", libraries: undefined });
  if (!LIBRARY_REVISION.test(revision)) return of({ kind: "missing", message: LIBRARIES_MISSING });
  const key = `${origin} ${revision}`;
  if (ready.has(key)) return of(ready.get(key));
  return new Observable((subscriber) => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(origin + libraryPath(revision, "manifest.json"), {
          signal: controller.signal,
          credentials: "omit",
        });
        if (response.status !== 200) {
          void response.body?.cancel?.().catch(() => {});
          return { status: response.status };
        }
        const text = await response.text();
        return { status: 200, text, digest: await sha256Hex(text) };
      } catch {
        return { status: 0 };
      }
    })().then((answer) => {
      if (controller.signal.aborted) return;
      const outcome = libraryManifestOutcome({ revision, origin, ...answer });
      if (outcome.kind === "ready") ready.set(key, outcome);
      subscriber.next(outcome);
      subscriber.complete();
    });
    return () => controller.abort();
  });
}

/** Forget every ready map; for tests. */
export function forgetLibraryMaps() {
  ready.clear();
}

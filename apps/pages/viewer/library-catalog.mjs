// An executable view's library map: what the viewer sends the frame so the
// view can import the host's libraries. A catalog lives on this origin at
// /catalog/<revision>/ (worker/library-catalog.mjs); its manifest.json maps
// each library to a file, and the revision is the sha256 of the manifest's
// text.
//
// A view's catalog_revision is the catalog it was last saved against. The
// viewer uses that catalog while this host still serves it, and otherwise the
// host's current one: the catalog its own build carries
// (shared/library-catalog.mjs). A host that serves neither has no libraries:
// the view mounts without a map.
import { Observable, of, switchMap } from "rxjs";
import {
  LIBRARY_CATALOG_REVISION,
  LIBRARY_REVISION,
  UNBUILT_LIBRARY_CATALOG,
  libraryPath,
} from "../shared/library-catalog.mjs";

export const LIBRARIES_UNREACHABLE = "This view's libraries didn't load. Retry to try again.";

const FILE = /^[\w-]+\.js$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;

/** The host's current catalog revision: `revision`, which defaults to the
 * one this build carries, or null when it is not a revision or is the unbuilt
 * one that a run from source reports and no host serves. */
export function hostLibraryRevision(revision = LIBRARY_CATALOG_REVISION) {
  return typeof revision === "string" &&
    LIBRARY_REVISION.test(revision) &&
    revision !== UNBUILT_LIBRARY_CATALOG
    ? revision
    : null;
}

/**
 * What one manifest answer means, decided from the response alone: `status`
 * (an HTTP status, or 0 when the request failed), `text`, the manifest's
 * text, and `digest`, the sha256 hex of that text.
 * - {kind: "ready", libraries, integrity}: the map of name → absolute URL on
 *   `origin`, and each catalog module's URL → its integrity value from the
 *   manifest's sha256, so the frame refuses a module whose bytes differ;
 * - {kind: "missing"}: this host does not have that catalog (404), or it
 *   serves other bytes under its name;
 * - {kind: "failed"}: the request failed or the host answered otherwise, which
 *   a retry may fix.
 */
export function libraryManifestOutcome({ revision, origin, status, text, digest }) {
  const missing = { kind: "missing" };
  if (status === 404) return missing;
  if (status !== 200) return { kind: "failed" };
  if (digest !== revision) return missing;
  let imports, files;
  try {
    ({ imports, files } = JSON.parse(text));
  } catch {
    return missing;
  }
  const isRecord = (value) => value && typeof value === "object" && !Array.isArray(value);
  if (!isRecord(imports) || !isRecord(files)) return missing;
  const libraries = {};
  for (const [name, file] of Object.entries(imports)) {
    if (typeof file !== "string" || !FILE.test(file)) return missing;
    libraries[name] = origin + libraryPath(revision, file);
  }
  // Every module of the catalog, the libraries and the chunks they share,
  // with the sha256 the manifest gives it.
  const integrity = {};
  for (const [file, digest] of Object.entries(files)) {
    if (!FILE.test(file)) continue;
    if (typeof digest !== "string" || !SHA256_HEX.test(digest)) return missing;
    integrity[origin + libraryPath(revision, file)] = sha256Integrity(digest);
  }
  if (Object.values(libraries).some((url) => !Object.hasOwn(integrity, url))) return missing;
  return { kind: "ready", libraries, integrity };
}

/**
 * Which library map a view mounts with, from its pin, the host's current
 * revision, and the manifest outcomes known so far (undefined: not asked yet).
 * Each argument that is not a 64-hex revision counts as absent.
 * - {kind: "fetch", revision}: ask for this revision's manifest, then decide
 *   again with its outcome;
 * - {kind: "ready", revision, libraries, integrity}: mount with this map;
 * - {kind: "none"}: this host has no libraries; mount without a map;
 * - {kind: "failed", message}: a manifest the view needs didn't load; show
 *   the message and Retry.
 * The pin comes first. Only a pin this host doesn't serve falls through to the
 * current revision, and a current revision equal to the pin is not asked for
 * twice.
 */
export function libraryDecision({ pin, current, pinned, latest }) {
  const valid = (revision) => typeof revision === "string" && LIBRARY_REVISION.test(revision);
  const use = (revision, outcome) =>
    outcome === undefined
      ? { kind: "fetch", revision }
      : outcome.kind === "ready"
        ? { kind: "ready", revision, libraries: outcome.libraries, integrity: outcome.integrity }
        : outcome.kind === "failed"
          ? { kind: "failed", message: LIBRARIES_UNREACHABLE }
          : undefined;
  if (valid(pin)) {
    const decided = use(pin, pinned);
    if (decided) return decided;
    if (current === pin) return { kind: "none" };
  }
  if (!valid(current)) return { kind: "none" };
  return use(current, latest) ?? { kind: "none" };
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

/** One manifest outcome (libraryManifestOutcome) for `revision` on `origin`.
 * Unsubscribing aborts the request. */
export function libraryManifest$(revision, { origin, fetch = globalThis.fetch }) {
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

/**
 * The library step of a mount: one libraryDecision that is not "fetch", for a
 * view pinned to `pin` (or null) on a host whose current revision is
 * `current` (or null). It asks for each manifest the decision names, in turn.
 * Unsubscribing aborts the request in flight.
 */
export function libraryMap$(pin, { origin, current = null, fetch = globalThis.fetch } = {}) {
  const step = (known) => {
    const decision = libraryDecision({ pin, current, ...known });
    if (decision.kind !== "fetch") return of(decision);
    const slot = decision.revision === pin ? "pinned" : "latest";
    return libraryManifest$(decision.revision, { origin, fetch }).pipe(
      switchMap((outcome) => step({ ...known, [slot]: outcome })),
    );
  };
  return step({});
}

/** Forget every ready map; for tests. */
export function forgetLibraryMaps() {
  ready.clear();
}

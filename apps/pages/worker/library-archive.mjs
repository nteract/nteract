// The bucket archive of view library catalog revisions.
//
// A build's static assets carry only its own catalog revision
// (scripts/library-catalog.mjs). The archive keeps every revision a reader
// has used readable in the Pages asset bucket (`env.PAGES_ASSETS`) under
// catalog/<revision>/<file>, so a view pinned to an older revision keeps its
// exact libraries after a later build drops them (worker/library-catalog.mjs
// reads it on an asset miss). Page assets live under pages/<pageId>/, and
// page deletion lists only that prefix, so it never removes these keys.
//
// manifest.json is written last. A reader fetches the manifest first and
// checks its sha256 against the revision, so a revision with no manifest in
// the bucket is absent: a copy that stopped part way is invisible, and a
// retry puts the same bytes again. Nothing deletes an archived revision.
import { LIBRARY_PATH, LIBRARY_REVISION, libraryPath } from "../shared/library-catalog.mjs";

export const LIBRARY_MANIFEST = "manifest.json";

/** The bucket key of one catalog file: catalog/<revision>/<name>. */
export const archiveKey = (revision, name) => libraryPath(revision, name).slice(1);

/** The wait after the nth consecutive failure before a request starts the
 * archive again: one minute, doubling, at most an hour. */
export const retryDelayMs = (attempts) => Math.min(60_000 * 2 ** (attempts - 1), 3_600_000);

/**
 * One revision's archive lifecycle in this isolate.
 *
 * States:
 * - {kind: "unknown"}: nothing has been asked yet;
 * - {kind: "checking", attempts}: a head of the bucket's manifest is in
 *   flight;
 * - {kind: "copying", attempts}: the bucket lacks the manifest and the copy
 *   is in flight;
 * - {kind: "archived"}: the bucket holds the revision; terminal;
 * - {kind: "failed", attempts, retryAt}: the last check or copy failed;
 *   a request at or after `retryAt` checks again.
 *
 * Events:
 * - {type: "request", now}: the route served the revision's manifest;
 * - {type: "present"}: the bucket holds the manifest;
 * - {type: "absent"}: the bucket lacks the manifest;
 * - {type: "copied"}: every file and then the manifest are in the bucket;
 * - {type: "failed", now}: the check or copy threw or refused.
 *
 * An event a state does not expect leaves it unchanged. `attempts` counts
 * consecutive failures and sets the next wait (retryDelayMs).
 */
export function archiveTransition(state, event) {
  switch (event.type) {
    case "request":
      if (state.kind === "unknown") return { kind: "checking", attempts: 0 };
      if (state.kind === "failed" && event.now >= state.retryAt)
        return { kind: "checking", attempts: state.attempts };
      return state;
    case "present":
      return state.kind === "checking" ? { kind: "archived" } : state;
    case "absent":
      return state.kind === "checking" ? { kind: "copying", attempts: state.attempts } : state;
    case "copied":
      return state.kind === "copying" ? { kind: "archived" } : state;
    case "failed": {
      if (state.kind !== "checking" && state.kind !== "copying") return state;
      const attempts = state.attempts + 1;
      return { kind: "failed", attempts, retryAt: event.now + retryDelayMs(attempts) };
    }
    default:
      return state;
  }
}

/** The effect a transition into `next` starts, or null. */
const effectOf = (previous, next) =>
  previous.kind !== next.kind && (next.kind === "checking" || next.kind === "copying")
    ? next.kind
    : null;

/** Why the copy refused a revision. Its message is a fixed reason that names
 * nothing but what the log line carries. */
class ArchiveRefusal extends Error {}

const sha256Hex = async (bytes) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/** The bytes of one catalog file from the build's assets. The asset binding
 * answers a missing path with the app's HTML shell, so that answer refuses. */
async function readAsset(assets, origin, revision, name) {
  const found = await assets.fetch(
    new Request(new URL(libraryPath(revision, name), origin), { method: "GET" }),
  );
  if (found.status !== 200 || /^text\/html\b/i.test(found.headers.get("content-type") ?? "")) {
    await found.body?.cancel();
    throw new ArchiveRefusal("asset_missing");
  }
  return new Uint8Array(await found.arrayBuffer());
}

/**
 * Copy `revision` from the build's assets into the bucket: every file the
 * manifest lists, each checked against its sha256 there, then the manifest,
 * checked against the revision. Throws ArchiveRefusal on a mismatch or a
 * missing file, before the manifest is written.
 */
export async function copyRevision({ assets, bucket, origin, revision }) {
  const manifestBytes = await readAsset(assets, origin, revision, LIBRARY_MANIFEST);
  if ((await sha256Hex(manifestBytes)) !== revision) throw new ArchiveRefusal("manifest_digest");
  let files;
  try {
    ({ files } = JSON.parse(new TextDecoder().decode(manifestBytes)));
  } catch {
    throw new ArchiveRefusal("manifest_shape");
  }
  if (!files || typeof files !== "object" || Array.isArray(files))
    throw new ArchiveRefusal("manifest_shape");
  for (const [name, digest] of Object.entries(files)) {
    if (name === LIBRARY_MANIFEST || !LIBRARY_PATH.test(libraryPath(revision, name)))
      throw new ArchiveRefusal("file_name");
    if (typeof digest !== "string" || !LIBRARY_REVISION.test(digest))
      throw new ArchiveRefusal("manifest_shape");
    const bytes = await readAsset(assets, origin, revision, name);
    if ((await sha256Hex(bytes)) !== digest) throw new ArchiveRefusal("file_digest");
    await bucket.put(archiveKey(revision, name), bytes);
  }
  await bucket.put(archiveKey(revision, LIBRARY_MANIFEST), manifestBytes);
}

function logArchiveFailure(revision, error) {
  console.warn(
    JSON.stringify({
      service: "nteract-pages-native",
      event: "library_catalog.archive_failed",
      revision,
      reason: error instanceof ArchiveRefusal ? error.message : "bucket_or_asset_error",
      timestamp: new Date().toISOString(),
    }),
  );
}

/**
 * The isolate's archive: one lifecycle (archiveTransition) per revision.
 * `archive.request({revision, assets, bucket, origin})` steps the revision's
 * lifecycle and returns a promise that settles when the effect it started,
 * if any, has run; it never rejects. `archive.state(revision)` reads the
 * current state. `now` is the clock the failure waits use.
 */
export function libraryArchive({ now = Date.now } = {}) {
  const states = new Map();
  const state = (revision) => states.get(revision) ?? { kind: "unknown" };

  async function run(revision, effect, io) {
    let event;
    try {
      if (effect === "checking") {
        event = (await io.bucket.head(archiveKey(revision, LIBRARY_MANIFEST)))
          ? { type: "present" }
          : { type: "absent" };
      } else {
        await copyRevision({ ...io, revision });
        event = { type: "copied" };
      }
    } catch (error) {
      logArchiveFailure(revision, error);
      event = { type: "failed", now: now() };
    }
    await step(revision, event, io);
  }

  function step(revision, event, io) {
    const previous = state(revision);
    const next = archiveTransition(previous, event);
    states.set(revision, next);
    const effect = effectOf(previous, next);
    return effect ? run(revision, effect, io) : Promise.resolve();
  }

  return {
    state,
    request: (io) => step(io.revision, { type: "request", now: now() }, io),
  };
}

/** This isolate's archive. */
export const catalogArchive = libraryArchive();

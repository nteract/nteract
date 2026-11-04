import { defineMachine, reject } from "../shared/machine.mjs";
import { pageState } from "./access.mjs";
import { validTime } from "./content-activity.mjs";
import { RECORD_STORAGE_MODES } from "../shared/record-storage.mjs";

/**
 * How a Page host starts: from its stored record to a loaded document.
 *
 * Booting a host (the native repo, then the lifecycle's boot effects, which
 * load the document and its comments) costs about 130 ms cold. A shared-Page
 * check needs none of it: owner, ACL, revisions and lifecycle state are in the
 * host record (`host/document`), and the listing title is the one the host
 * last projected (`host/title-projection`). So a host whose record allows it
 * starts in `metadata` and boots only when a request needs the document.
 *
 * States:
 * - loading: the constructor is reading the record. Requests wait (`ready`).
 * - metadata: the record is read and the repo isn't booted. A shared-Page
 *   check may answer from the record; any other request starts the boot.
 * - booting: one boot is running. Every request that needs the document,
 *   and every check, waits for it.
 * - ready: booted, or nothing to boot (no record and no creation intent;
 *   creation boots its own repo). Requests use the loaded host.
 * - failed: the boot threw. The runtime is replacing this object:
 *   both boots run inside `blockConcurrencyWhile`, and a throw there resets
 *   it, so the next request reaches a new object that starts from storage
 *   again. Until then a check still answers from the record, and a request
 *   that needs the document gets the boot's error.
 *
 * Events: `loaded` (the record was read; `start` says how to start),
 * `catalog` (a shared-Page check asks how to answer), `document` (a request
 * needs the document), and `booted` / `bootFailed` (the boot ended).
 * `catalog` and `document` answer with `response.serve`: `record` (answer from
 * the host record), `wait` (await the running boot, then ask again),
 * `document` (use the loaded host) or `failed`.
 *
 * The one `boot` effect starts the boot; the interpreter keeps its promise, so
 * a second request that needs the document waits on the same boot. The repo
 * boots at most once per object. `within` says where it runs: `constructor`
 * inside the constructor's own `blockConcurrencyWhile`, `request` in a new
 * one the request opens. Machine state is JSON, so the boot's promise and
 * its error stay with the interpreter as the effect's handles.
 */
export const PAGE_STARTUP_STATES = Object.freeze([
  "loading",
  "metadata",
  "booting",
  "ready",
  "failed",
]);
export const PAGE_STARTUP_EVENTS = Object.freeze([
  "loaded",
  "catalog",
  "document",
  "booted",
  "bootFailed",
]);
const STARTS = ["missing", "lazy", "eager"];

const unreachable = [
  ...["catalog", "document"].map((event) => [
    "loading",
    event,
    "requests wait for the constructor's read (`ready`) before they ask",
  ]),
  ...["metadata", "booting", "ready", "failed"].map((state) => [
    state,
    "loaded",
    "the host record is read once, in the constructor",
  ]),
  ...["loading", "metadata", "ready", "failed"].flatMap((state) =>
    ["booted", "bootFailed"].map((event) => [state, event, "only a running boot reports its end"]),
  ),
];

const serve = (state, how) => ({ state, effects: [], response: { serve: how } });
const failed = (state) =>
  reject(state, "the host failed to start", { response: { serve: "failed" } });

export const pageStartup = defineMachine({
  name: "page-startup",
  states: PAGE_STARTUP_STATES,
  events: PAGE_STARTUP_EVENTS,
  unreachable,
  cases: { "loading/loaded": STARTS },
  validate: {
    events: {
      loaded: (event) => {
        if (!STARTS.includes(event.start)) throw Error(`start must be one of ${STARTS}`);
      },
    },
    effects: {
      boot: (effect) => {
        if (!["constructor", "request"].includes(effect.within))
          throw Error("a boot runs within the constructor or a request");
      },
    },
  },
  initial: { name: "loading" },
  transition(state, event) {
    switch (event.type) {
      case "loaded":
        if (event.start === "missing") return { state: { name: "ready" }, effects: [] };
        if (event.start === "lazy") return { state: { name: "metadata" }, effects: [] };
        return { state: { name: "booting" }, effects: [{ type: "boot", within: "constructor" }] };
      case "catalog":
        // The record needs nothing the failed boot left behind.
        if (state.name === "metadata" || state.name === "failed") return serve(state, "record");
        if (state.name === "booting") return serve(state, "wait");
        return serve(state, "document");
      case "document":
        if (state.name === "metadata")
          return {
            state: { name: "booting" },
            effects: [{ type: "boot", within: "request" }],
            response: { serve: "wait" },
          };
        if (state.name === "booting") return serve(state, "wait");
        if (state.name === "ready") return serve(state, "document");
        return failed(state);
      case "booted":
        return { state: { name: "ready" }, effects: [] };
      case "bootFailed":
        return { state: { name: "failed" }, effects: [] };
    }
  },
});

/** Whether the host record is one this build answers checks from without
 * booting. Records an earlier build wrote without a comments document name
 * (the boot writes it) or with a storage mode the boot refuses boot at once,
 * as every host did before. */
export function recordAnswerable(record) {
  return (
    !!record &&
    typeof record === "object" &&
    typeof record.pageId === "string" &&
    typeof record.documentId === "string" &&
    typeof record.comments_doc === "string" &&
    (record.recordStorage === undefined || RECORD_STORAGE_MODES.includes(record.recordStorage))
  );
}

/** How the constructor starts the host from what it read. A creation intent
 * boots at once: the boot commits or replays it. */
export function startupOf(record, creation) {
  if (!record && !creation) return "missing";
  if (creation || !recordAnswerable(record)) return "eager";
  return "lazy";
}

/** The stored title projection when it can stand in for the document's
 * title: a string title and the time it was observed. The loaded host
 * (`restoreTitleProjection`) reads it with the same test. */
export function storedTitleProjection(value) {
  return typeof value?.title === "string" && validTime(value.observed_at) ? value : null;
}

/**
 * Why a shared-Page check in `metadata` can't answer from what storage holds,
 * before it authenticates the caller, or null when it may go on.
 *
 * - creation_intent: a recorded creation the boot must commit or replay.
 * - no_record: nothing to answer from.
 * - legacy_record: a record this build boots before it serves (see
 *   recordAnswerable).
 * - index_report_pending: an active Page's index report failed earlier. The
 *   loaded host's check repeats it (`repairIndex`), so this check boots.
 * - projection_pending: an active Page's stored title may not have reached
 *   every Catalog. The loaded host's first check sends it again
 *   (`cacheTitle`), so this check boots.
 * - no_stored_title: an active Page with no usable stored title, such as one
 *   no host of this build has projected yet.
 *
 * Trashed and deleted records need no title: a check of one either refuses
 * (it is hidden or deleted) or boots (a grant holder's check of a trashed
 * Page loads its document, as before). The caller decides those after it
 * authenticates.
 */
export function recordFallback({ record, creation, projection, reportPending, projectionPending }) {
  if (creation) return "creation_intent";
  if (!record) return "no_record";
  if (!recordAnswerable(record)) return "legacy_record";
  if (pageState(record) !== "active") return null;
  if (reportPending === true) return "index_report_pending";
  if (projectionPending === true) return "projection_pending";
  if (!storedTitleProjection(projection)) return "no_stored_title";
  return null;
}

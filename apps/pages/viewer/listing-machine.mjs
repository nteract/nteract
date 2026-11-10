/**
 * One paged listing (list_pages or list_projects) as a state machine.
 *
 * The Pages library and /projects each run one. The rows themselves live
 * beside this state in Listing (listing.mjs); the machine owns which request
 * is in flight, the cursor for the next page, and whether a failure lost the
 * first page or only the next one.
 *
 * `params` is what one listing lists: `{ query, access, sort, projectId }`,
 * already normalized by the caller (libraryRequest in shared/routes.mjs). The
 * machine compares nothing inside it; every `load` starts over.
 *
 * States:
 * - idle: nothing requested yet.
 * - loading: the first page for `params` is in flight under `key`.
 * - ready: rows are shown. `cursor` continues the listing, or is null at its
 *   end.
 * - refreshing: rows this tab showed for `params` earlier paint from memory
 *   (listing-cache.mjs) while the first page for `params` is in flight under
 *   `key`. It settles like loading.
 * - more: the page after `cursor` is in flight under `key`; rows stay shown.
 * - failed: the first page for `params` failed with the server's error
 *   `code` (or null). Nothing is listed, even after a refresh painted rows
 *   from memory: those rows were never confirmed, and the failure may be the
 *   server refusing them (listing-cache.mjs explains). The screen reads
 *   `code` to tell a Project it can't open from an outage.
 * - stalled: the page after `cursor` failed. The rows already shown stay.
 *
 * Events:
 * - load: list `params` from its first page. It supersedes any request in
 *   flight, so a search typed during a load, a tab or sort change, or a
 *   retry always wins.
 * - restore: like load, for `params` whose first page this tab has shown
 *   before. The remembered rows paint at once, and the first page replaces
 *   them when it lands.
 * - more: list the next page (Load more), or retry the one that stalled.
 * - loaded / failed: the request for `key` settled. A key that no longer
 *   matches belongs to a superseded request, so its result is ignored.
 *   `failed` carries the server's error `code`, or null.
 *
 * list_pages answers `invalid_cursor` when a cursor expired (after a day) or
 * when the source that issued it can't serve the next page (a walk that
 * began on D1 while D1 is failing). Either way a next page that fails that
 * way can't succeed with that cursor. The listing starts over from the first
 * page instead of stalling; the failed request has settled, so its key names
 * the restart. Other failures stall and retry the same cursor.
 *
 * Effects: `fetch` requests one page; `paint` puts the remembered rows for
 * `params` on screen; `show` puts the settled request's rows on screen,
 * replacing them for a first page and appending otherwise; `report` hands the
 * failure to the screen's banner (alerts.mjs).
 */
import { defineMachine, reject } from "../shared/machine.mjs";

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const only = (value, keys) => {
  for (const key of Object.keys(value)) check(keys.includes(key), `unexpected field ${key}`);
};
const isKey = (value) => typeof value === "string" && value !== "";
const PARAMS = ["query", "access", "sort", "projectId"];
const nullableText = (value) => value === null || (typeof value === "string" && value !== "");
function checkParams(params) {
  check(params !== null && typeof params === "object", "params must be an object");
  only(params, PARAMS);
  for (const key of PARAMS) check(key in params, `params.${key} is required`);
  check(typeof params.query === "string", "params.query must be a string");
  check(nullableText(params.access), "params.access must be a string or null");
  check(isKey(params.sort), "params.sort must be a string");
  check(nullableText(params.projectId), "params.projectId must be a string or null");
}
const fields = (head, keys) => (value) => {
  only(value, [head, ...keys]);
  if (keys.includes("key")) check(isKey(value.key), "key is required");
  if (keys.includes("params")) checkParams(value.params);
  if (keys.includes("cursor"))
    check(
      value.cursor === null || (typeof value.cursor === "string" && value.cursor !== ""),
      "cursor must be a string or null",
    );
  if (keys.includes("message"))
    check(typeof value.message === "string", "message must be a string");
  if (keys.includes("append")) check(typeof value.append === "boolean", "append is a boolean");
  if (keys.includes("code"))
    check(
      value.code === null || (typeof value.code === "string" && value.code !== ""),
      "code must be a string or null",
    );
};
const state = (...keys) => fields("name", keys);
const event = (...keys) => fields("type", keys);

export const listingSpec = Object.freeze({
  name: "listing",
  states: ["idle", "loading", "refreshing", "ready", "more", "failed", "stalled"],
  events: ["load", "restore", "more", "loaded", "failed"],
  unreachable: [
    ["idle", "loaded", "Nothing is requested before the first load"],
    ["idle", "failed", "Nothing is requested before the first load"],
  ],
  cases: {
    "loading/loaded": ["current", "stale"],
    "loading/failed": ["current", "stale"],
    "refreshing/loaded": ["current", "stale"],
    "refreshing/failed": ["current", "stale"],
    "more/loaded": ["current", "stale"],
    "more/failed": ["current", "stale", "expired"],
    "ready/more": ["cursor", "end"],
  },
  validate: {
    states: {
      idle: state(),
      loading: state("key", "params"),
      refreshing: state("key", "params"),
      ready: state("params", "cursor"),
      more: state("key", "params", "cursor"),
      failed: state("params", "message", "code"),
      stalled: state("params", "cursor", "message"),
    },
    events: {
      load: event("key", "params"),
      restore: event("key", "params"),
      more: event("key"),
      loaded: event("key", "cursor"),
      failed: event("key", "message", "code"),
    },
    effects: {
      fetch: event("key", "params", "cursor"),
      paint: event("params"),
      show: event("key", "append"),
      report: event("message"),
    },
  },
});

/** list_pages' answer for a cursor that expired or was never valid. */
export const INVALID_CURSOR = "invalid_cursor";

export const REJECT = Object.freeze({
  nothingListed: "Nothing is listed yet",
  firstPage: "The first page is still loading",
  loadingMore: "The next page is already loading",
  end: "The listing has no more pages",
  reload: "The first page failed; load it again",
  stale: "A newer request superseded this one",
  idle: "No request is in flight",
});

function transition(current, input) {
  if (input.type === "load")
    return {
      state: { name: "loading", key: input.key, params: input.params },
      effects: [{ type: "fetch", key: input.key, params: input.params, cursor: null }],
    };
  if (input.type === "restore")
    return {
      state: { name: "refreshing", key: input.key, params: input.params },
      effects: [
        { type: "paint", params: input.params },
        { type: "fetch", key: input.key, params: input.params, cursor: null },
      ],
    };
  if (input.type === "more") {
    if (current.name === "idle") return reject(current, REJECT.nothingListed);
    if (current.name === "loading" || current.name === "refreshing")
      return reject(current, REJECT.firstPage);
    if (current.name === "more") return reject(current, REJECT.loadingMore);
    if (current.name === "failed") return reject(current, REJECT.reload);
    if (current.cursor === null) return reject(current, REJECT.end);
    const { params, cursor } = current;
    return {
      state: { name: "more", key: input.key, params, cursor },
      effects: [{ type: "fetch", key: input.key, params, cursor }],
    };
  }
  if (current.name !== "loading" && current.name !== "refreshing" && current.name !== "more")
    return reject(current, REJECT.idle);
  if (input.key !== current.key) return reject(current, REJECT.stale);
  const append = current.name === "more";
  if (append && input.type === "failed" && input.code === INVALID_CURSOR)
    return {
      state: { name: "loading", key: input.key, params: current.params },
      effects: [{ type: "fetch", key: input.key, params: current.params, cursor: null }],
    };
  if (input.type === "loaded")
    return {
      state: { name: "ready", params: current.params, cursor: input.cursor },
      effects: [{ type: "show", key: input.key, append }],
    };
  return {
    state: append
      ? { name: "stalled", params: current.params, cursor: current.cursor, message: input.message }
      : { name: "failed", params: current.params, message: input.message, code: input.code },
    effects: [{ type: "report", message: input.message }],
  };
}

export const listingMachine = defineMachine({
  ...listingSpec,
  initial: { name: "idle" },
  transition,
});

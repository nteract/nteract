/**
 * One paged listing (list_pages or list_projects) as a state machine.
 *
 * The index routes, /pages and /projects, each run one. The rows themselves
 * live beside this state in Listing (listing.mjs); the machine owns which
 * request is in flight, the cursor for the next page, and whether a failure
 * lost the first page or only the next one.
 *
 * States:
 * - idle: nothing requested yet.
 * - loading: the first page for `query` is in flight under `key`.
 * - ready: rows are shown. `cursor` continues the listing, or is null at its
 *   end.
 * - more: the page after `cursor` is in flight under `key`; rows stay shown.
 * - failed: the first page for `query` failed. Nothing is listed.
 * - stalled: the page after `cursor` failed. The rows already shown stay.
 *
 * Events:
 * - load: list `query` from its first page. It supersedes any request in
 *   flight, so a search typed during a load, or a retry, always wins.
 * - more: list the next page (Load more), or retry the one that stalled.
 * - loaded / failed: the request for `key` settled. A key that no longer
 *   matches belongs to a superseded request, so its result is ignored.
 *
 * Effects: `fetch` requests one page; `show` puts the settled request's rows
 * on screen, replacing them for a first page and appending otherwise;
 * `report` hands the failure to the screen's banner (alerts.mjs).
 */
import { defineMachine, reject } from "../shared/machine.mjs";

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const only = (value, keys) => {
  for (const key of Object.keys(value)) check(keys.includes(key), `unexpected field ${key}`);
};
const isKey = (value) => typeof value === "string" && value !== "";
const fields = (head, keys) => (value) => {
  only(value, [head, ...keys]);
  if (keys.includes("key")) check(isKey(value.key), "key is required");
  if (keys.includes("query")) check(typeof value.query === "string", "query must be a string");
  if (keys.includes("cursor"))
    check(
      value.cursor === null || (typeof value.cursor === "string" && value.cursor !== ""),
      "cursor must be a string or null",
    );
  if (keys.includes("message"))
    check(typeof value.message === "string", "message must be a string");
  if (keys.includes("append")) check(typeof value.append === "boolean", "append is a boolean");
};
const state = (...keys) => fields("name", keys);
const event = (...keys) => fields("type", keys);

export const listingSpec = Object.freeze({
  name: "listing",
  states: ["idle", "loading", "ready", "more", "failed", "stalled"],
  events: ["load", "more", "loaded", "failed"],
  unreachable: [
    ["idle", "loaded", "Nothing is requested before the first load"],
    ["idle", "failed", "Nothing is requested before the first load"],
  ],
  cases: {
    "loading/loaded": ["current", "stale"],
    "loading/failed": ["current", "stale"],
    "more/loaded": ["current", "stale"],
    "more/failed": ["current", "stale"],
    "ready/more": ["cursor", "end"],
  },
  validate: {
    states: {
      idle: state(),
      loading: state("key", "query"),
      ready: state("query", "cursor"),
      more: state("key", "query", "cursor"),
      failed: state("query", "message"),
      stalled: state("query", "cursor", "message"),
    },
    events: {
      load: event("key", "query"),
      more: event("key"),
      loaded: event("key", "cursor"),
      failed: event("key", "message"),
    },
    effects: {
      fetch: event("key", "query", "cursor"),
      show: event("key", "append"),
      report: event("message"),
    },
  },
});

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
      state: { name: "loading", key: input.key, query: input.query },
      effects: [{ type: "fetch", key: input.key, query: input.query, cursor: null }],
    };
  if (input.type === "more") {
    if (current.name === "idle") return reject(current, REJECT.nothingListed);
    if (current.name === "loading") return reject(current, REJECT.firstPage);
    if (current.name === "more") return reject(current, REJECT.loadingMore);
    if (current.name === "failed") return reject(current, REJECT.reload);
    if (current.cursor === null) return reject(current, REJECT.end);
    const { query, cursor } = current;
    return {
      state: { name: "more", key: input.key, query, cursor },
      effects: [{ type: "fetch", key: input.key, query, cursor }],
    };
  }
  if (current.name !== "loading" && current.name !== "more") return reject(current, REJECT.idle);
  if (input.key !== current.key) return reject(current, REJECT.stale);
  const append = current.name === "more";
  if (input.type === "loaded")
    return {
      state: { name: "ready", query: current.query, cursor: input.cursor },
      effects: [{ type: "show", key: input.key, append }],
    };
  return {
    state: append
      ? { name: "stalled", query: current.query, cursor: current.cursor, message: input.message }
      : { name: "failed", query: current.query, message: input.message },
    effects: [{ type: "report", message: input.message }],
  };
}

export const listingMachine = defineMachine({
  ...listingSpec,
  initial: { name: "idle" },
  transition,
});

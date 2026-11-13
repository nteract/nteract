/**
 * A Page's sources document on a replica, as a state machine.
 *
 * The sources document (model/sources-doc.mjs) is host-written and read-only
 * here: this replica syncs it and never changes it. Most Pages have none; the
 * host creates it on the first source write. Each connection the host admits
 * comes with its discovery (/api/connect), which names the document in
 * `documents.sources` once it exists, so discovery is what moves this
 * machine.
 *
 * States:
 * - closed: no replica, or no connection admitted since it opened.
 * - absent: the host's discovery names no sources document. The Page has no
 *   sources yet.
 * - unserved: the host doesn't serve the document to this build: its
 *   discovery has no document map, or its socket answered the named document
 *   as unknown. Both are an older host that doesn't know the type. `id` is
 *   the document it named, if any.
 * - unreadable: discovery names the document at a format this build doesn't
 *   read. Nothing is looked up; the Page draws no source.
 * - opening: lookup `attempt` for document `id` is running.
 * - retrying: lookup `attempt` failed; the next one waits on a timer.
 * - failed: lookups kept failing. The next admitted connection starts over.
 * - ready: the document is open, as `id`.
 * - retired: the replica was retired (access revoked, Page deleted). Nothing
 *   opens again in this session; a reopened Page is a new session.
 *
 * Events:
 * - discovered: a connection was admitted, and its discovery's answer about
 *   the document: `named` with `id`, `none`, `unaware` (no document map) or
 *   `unreadable` (a format this build doesn't read). A reconnect is a new
 *   discovery: anything not open starts over, and a running lookup restarts
 *   on the new connection.
 * - opened / lookupFailed / unknown: lookup `attempt` found the document,
 *   failed, or the host answered it holds no such document. An attempt that
 *   isn't the current one was cancelled, so its result is ignored.
 * - timer: the retry timer for `attempt` fired.
 * - retire: the replica is being retired with the Page's other documents.
 *   It drops the sources document from memory; its synced bytes stay in the
 *   tab's replica database, the same as the Page's and comments' synced
 *   bytes.
 * - close: the replica closed or was replaced; everything stops.
 *
 * Effects:
 * - lookup: find document `id` as `attempt`, with a timeout.
 * - cancel: abort lookup `attempt` (its late result is ignored anyway).
 * - schedule: arm the retry timer for `attempt` after `delay` ms.
 * - clearTimer: disarm the retry timer.
 * - install: adopt the handle lookup `attempt` found.
 * - uninstall: drop the installed handle; readers see no document.
 *
 * No effect writes the document. It has no local change to queue, retry or
 * resend.
 */
import { defineMachine, reject } from "../shared/machine.mjs";
import { OPEN_ATTEMPTS, retryDelay } from "./comments-open-machine.mjs";

export { OPEN_ATTEMPTS, retryDelay };

const ANSWERS = ["named", "none", "unaware", "unreadable"];

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const only = (value, keys) => {
  for (const key of Object.keys(value)) check(keys.includes(key), `unexpected field ${key}`);
};
const attempt = (value) =>
  check(
    Number.isSafeInteger(value.attempt) && value.attempt > 0,
    "attempt must be a positive integer",
  );
const id = (value) => check(typeof value.id === "string" && value.id !== "", "id is required");
const optionalId = (value) => value.id === undefined || id(value);
const delay = (value) =>
  check(Number.isSafeInteger(value.delay) && value.delay > 0, "delay must be positive");
const answer = (value) => {
  check(ANSWERS.includes(value.answer), "answer is named, none, unaware or unreadable");
  check((value.answer === "named") === (value.id !== undefined), "only a named answer has an id");
  optionalId(value);
};
const shape =
  (head, keys, ...checks) =>
  (value) => {
    only(value, [head, ...keys]);
    for (const fn of checks) fn(value);
  };
const bare = shape("name", []);
const lookupState = shape("name", ["attempt", "id"], attempt, id);
const settled = shape("type", ["attempt"], attempt);

export const STATES = Object.freeze([
  "closed",
  "absent",
  "unserved",
  "unreadable",
  "opening",
  "retrying",
  "failed",
  "ready",
  "retired",
]);

export const sourcesOpenSpec = Object.freeze({
  name: "sources-open",
  states: STATES,
  events: ["discovered", "opened", "lookupFailed", "unknown", "timer", "retire", "close"],
  cases: {
    ...Object.fromEntries(
      ["closed", "absent", "unserved", "unreadable", "failed"].map((name) => [
        `${name}/discovered`,
        ANSWERS,
      ]),
    ),
    "opening/discovered": ["same", "other", "none", "unaware", "unreadable"],
    "retrying/discovered": ["same", "other", "none", "unaware", "unreadable"],
    "ready/discovered": ["same", "other", "none", "unaware", "unreadable"],
    "opening/opened": ["current", "stale"],
    "opening/lookupFailed": ["retry", "exhausted", "stale"],
    "opening/unknown": ["current", "stale"],
    "retrying/timer": ["current", "stale"],
  },
  validate: {
    states: {
      closed: bare,
      absent: bare,
      unserved: shape("name", ["id"], optionalId),
      unreadable: bare,
      opening: lookupState,
      retrying: lookupState,
      failed: lookupState,
      ready: shape("name", ["id"], id),
      retired: bare,
    },
    events: {
      discovered: shape("type", ["answer", "id"], answer),
      opened: settled,
      lookupFailed: settled,
      unknown: settled,
      timer: settled,
      retire: shape("type", []),
      close: shape("type", []),
    },
    effects: {
      lookup: shape("type", ["attempt", "id"], attempt, id),
      cancel: shape("type", ["attempt"], attempt),
      schedule: shape("type", ["attempt", "delay"], attempt, delay),
      clearTimer: shape("type", []),
      install: shape("type", ["attempt"], attempt),
      uninstall: shape("type", []),
    },
  },
});

export const REJECT = Object.freeze({
  stale: "That lookup was cancelled",
  ready: "Already open",
  same: "Already in that state",
  retired: "The replica was retired",
  closed: "Nothing is open",
});

const ok = (state, effects = []) => ({ state, effects });

/** What leaving `state` needs: stop its lookup, its timer, or its handle. */
function leave(state) {
  if (state.name === "opening") return [{ type: "cancel", attempt: state.attempt }];
  if (state.name === "retrying") return [{ type: "clearTimer" }];
  if (state.name === "ready") return [{ type: "uninstall" }];
  return [];
}

const start = (from, documentId) =>
  ok({ name: "opening", attempt: 1, id: documentId }, [
    ...leave(from),
    { type: "lookup", attempt: 1, id: documentId },
  ]);

/** The state a discovery that names no readable document moves to. */
const quietState = (event) =>
  event.answer === "none"
    ? { name: "absent" }
    : event.answer === "unaware"
      ? { name: "unserved" }
      : { name: "unreadable" };

function discovered(state, event) {
  if (state.name === "retired") return reject(state, REJECT.retired);
  if (event.answer === "named") {
    // An open document stays open on a new connection: sync resumes on it.
    if (state.name === "ready" && state.id === event.id) return reject(state, REJECT.ready);
    // Anything else starts over, a running lookup included: it ran on a
    // connection that is gone.
    return start(state, event.id);
  }
  const next = quietState(event);
  if (state.name === next.name && state.id === undefined) return reject(state, REJECT.same);
  return ok(next, leave(state));
}

function transition(state, event) {
  const current = (name) => state.name === name && state.attempt === event.attempt;
  switch (event.type) {
    case "discovered":
      return discovered(state, event);
    case "opened":
      if (!current("opening")) return reject(state, REJECT.stale);
      return ok({ name: "ready", id: state.id }, [{ type: "install", attempt: event.attempt }]);
    case "lookupFailed":
      if (!current("opening")) return reject(state, REJECT.stale);
      if (state.attempt >= OPEN_ATTEMPTS)
        return ok({ name: "failed", attempt: state.attempt, id: state.id });
      return ok({ name: "retrying", attempt: state.attempt, id: state.id }, [
        { type: "schedule", attempt: state.attempt, delay: retryDelay(state.attempt) },
      ]);
    case "unknown":
      // The host answered while connected that it holds no such document.
      if (!current("opening")) return reject(state, REJECT.stale);
      return ok({ name: "unserved", id: state.id });
    case "timer":
      if (!current("retrying")) return reject(state, REJECT.stale);
      return ok({ name: "opening", attempt: state.attempt + 1, id: state.id }, [
        { type: "lookup", attempt: state.attempt + 1, id: state.id },
      ]);
    case "retire":
      if (state.name === "retired") return reject(state, REJECT.retired);
      return ok({ name: "retired" }, leave(state));
    case "close":
      if (state.name === "retired") return reject(state, REJECT.retired);
      if (state.name === "closed") return reject(state, REJECT.closed);
      return ok({ name: "closed" }, leave(state));
  }
  throw new Error(`unknown event ${event.type}`);
}

export const sourcesOpenMachine = defineMachine({
  ...sourcesOpenSpec,
  initial: { name: "closed" },
  transition,
});

/**
 * The `discovered` event for a discovery answer (/api/connect): what it says
 * about the sources document. `parse` reads a descriptor at a registered
 * format (model/document-types.mjs parseDocumentDescriptor).
 */
export function discoveryEvent(connection, parse) {
  const documents = connection?.documents;
  if (!documents || typeof documents !== "object" || Array.isArray(documents))
    return { type: "discovered", answer: "unaware" };
  if (!Object.hasOwn(documents, "sources")) return { type: "discovered", answer: "none" };
  const descriptor = parse(documents.sources);
  if (!descriptor || descriptor.type !== "pages.sources")
    return { type: "discovered", answer: "unreadable" };
  return { type: "discovered", answer: "named", id: descriptor.id };
}

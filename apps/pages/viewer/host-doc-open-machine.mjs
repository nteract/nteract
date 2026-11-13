/**
 * One host-written document a Page holds, on a replica, as a state machine:
 * the Page's sources document (model/sources-doc.mjs) and each view document
 * (`pages.view`). Both are read-only here: this replica syncs them and never
 * changes them.
 *
 * A document is found one of two ways. The host's discovery (/api/connect)
 * names the sources document in `documents.sources` once it exists. Either
 * document's id is also derived from the Page id (and the view id), so the
 * replica can look one up by that id on the live connection when something
 * on the Page asks for it: a view embed names its view, and a table or a
 * chart asks for a source. A lookup carries how it was started (`via`),
 * because the host's "no such document" answer means different things:
 *
 * - `named`: discovery named the document, so a host that answers it holds
 *   no such document doesn't serve the type. That is an older host.
 * - `derived`: the replica derived the id, so the answer means the document
 *   doesn't exist yet (or isn't on this Page). The lookup retries on a short
 *   backoff, then the replica rests in `absent`. A later ask looks again, at
 *   most once per LOOK_AGAIN_MS.
 *
 * States:
 * - closed: no replica, or no connection admitted since it opened.
 * - absent: there is no such document. Discovery named none, or a derived
 *   lookup was answered "none". After a derived miss it holds the `id` it
 *   looked up, and `cooling` while the look-again timer is armed; an ask in
 *   that window sets `asked`, and the lookup runs when the timer fires.
 * - unserved: the host doesn't serve the document to this build: its
 *   discovery has no document map, or its socket answered a named document
 *   as unknown. Both are an older host that doesn't know the type. `id` is
 *   the document it named, if any.
 * - unreadable: discovery names the document at a format this build doesn't
 *   read. Nothing is looked up.
 * - opening: lookup `attempt` for document `id` is running, started `via`.
 * - retrying: lookup `attempt` failed or missed; the next one waits on a
 *   timer.
 * - failed: lookups kept failing. The next admitted connection starts over.
 * - ready: the document is open, as `id`.
 * - retired: the replica was retired (access revoked, Page deleted). Nothing
 *   opens again in this session; a reopened Page is a new session.
 *
 * Events:
 * - discovered: a connection was admitted, and what it says about the
 *   document: `named` with `id` (discovery names it), `derived` with `id`
 *   (the document is found only by its derived id, as a view is), `none`,
 *   `unaware` (no document map) or `unreadable` (a format this build doesn't
 *   read). A reconnect is a new discovery: anything not open starts over,
 *   and a running lookup restarts on the new connection.
 * - wanted: something on the Page asks for the document, whose derived id is
 *   `id`. Only an absent document is looked up again.
 * - opened / lookupFailed / unknown: lookup `attempt` found the document,
 *   failed, or the host answered it holds no such document. An attempt that
 *   isn't the current one was cancelled, so its result is ignored.
 * - timer: the retry timer for `attempt` fired.
 * - cooled: the look-again timer fired.
 * - retire: the replica is being retired with the Page's other documents.
 *   It drops the document from memory; its synced bytes stay in the tab's
 *   replica database, the same as the Page's and comments' synced bytes.
 * - close: the replica closed or was replaced; everything stops.
 *
 * Effects:
 * - lookup: find document `id` as `attempt`, with a timeout.
 * - cancel: abort lookup `attempt` (its late result is ignored anyway).
 * - schedule: arm the retry timer for `attempt` after `delay` ms.
 * - cool: arm the look-again timer after `delay` ms.
 * - clearTimer: disarm the retry or look-again timer (one is armed at most).
 * - forget: drop the repo's record that document `id` is unavailable, so
 *   the next lookup asks the host again instead of repeating that answer.
 * - install: adopt the handle lookup `attempt` found.
 * - uninstall: drop the installed handle; readers see no document.
 *
 * No effect writes the document. It has no local change to queue, retry or
 * resend.
 */
import { defineMachine, reject } from "../shared/machine.mjs";
import { OPEN_ATTEMPTS, retryDelay } from "./comments-open-machine.mjs";

export { OPEN_ATTEMPTS, retryDelay };

/** Derived lookups the host answers "none" before the replica rests: the
 * first and two retries, 1 s and 2 s apart. */
export const MISSING_ATTEMPTS = 3;
/** The shortest wait between derived lookups after the replica rests. */
export const LOOK_AGAIN_MS = 10_000;

const ANSWERS = ["named", "derived", "none", "unaware", "unreadable"];
const VIA = ["named", "derived"];

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
const via = (value) => check(VIA.includes(value.via), "via is named or derived");
const delay = (value) =>
  check(Number.isSafeInteger(value.delay) && value.delay > 0, "delay must be positive");
const answer = (value) => {
  check(ANSWERS.includes(value.answer), `answer is one of ${ANSWERS.join(", ")}`);
  const carriesId = value.answer === "named" || value.answer === "derived";
  check(carriesId === (value.id !== undefined), "only a named or derived answer has an id");
  optionalId(value);
};
const absentShape = (value) => {
  optionalId(value);
  check(value.cooling === undefined || value.cooling === true, "cooling is true or absent");
  check(value.asked === undefined || value.asked === true, "asked is true or absent");
  check(value.cooling === undefined || value.id !== undefined, "only a missed lookup cools");
  check(value.asked === undefined || value.cooling === true, "only a cooling state is asked");
};
const shape =
  (head, keys, ...checks) =>
  (value) => {
    only(value, [head, ...keys]);
    for (const fn of checks) fn(value);
  };
const bare = shape("name", []);
const lookupState = shape("name", ["attempt", "id", "via"], attempt, id, via);
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

const QUIET = ["none", "unaware", "unreadable"];

export const hostDocOpenSpec = Object.freeze({
  name: "host-doc-open",
  states: STATES,
  events: [
    "discovered",
    "wanted",
    "opened",
    "lookupFailed",
    "unknown",
    "timer",
    "cooled",
    "retire",
    "close",
  ],
  cases: {
    ...Object.fromEntries(
      ["closed", "unserved", "unreadable", "failed"].map((name) => [
        `${name}/discovered`,
        ["named", "derived", ...QUIET],
      ]),
    ),
    "absent/discovered": ["named", "derived", ...QUIET, "cooling"],
    "opening/discovered": ["lookup", ...QUIET],
    "retrying/discovered": ["lookup", ...QUIET],
    "ready/discovered": ["same", "other", ...QUIET],
    "absent/wanted": ["look", "ask", "asked"],
    "opening/opened": ["current", "stale"],
    "opening/lookupFailed": ["retry", "exhausted", "stale"],
    "opening/unknown": ["unserved", "retry", "missing", "stale"],
    "retrying/timer": ["current", "stale"],
    "absent/cooled": ["look", "rest", "stale"],
  },
  validate: {
    states: {
      closed: bare,
      absent: shape("name", ["id", "cooling", "asked"], absentShape),
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
      wanted: shape("type", ["id"], id),
      opened: settled,
      lookupFailed: settled,
      unknown: settled,
      timer: settled,
      cooled: shape("type", []),
      retire: shape("type", []),
      close: shape("type", []),
    },
    effects: {
      lookup: shape("type", ["attempt", "id"], attempt, id),
      cancel: shape("type", ["attempt"], attempt),
      schedule: shape("type", ["attempt", "delay"], attempt, delay),
      cool: shape("type", ["delay"], delay),
      clearTimer: shape("type", []),
      forget: shape("type", ["id"], id),
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
  looking: "Already looking",
  asked: "Already asked",
  answered: "The host's answer stands until the next connection",
});

const ok = (state, effects = []) => ({ state, effects });

/** What leaving `state` needs: stop its lookup, its timer, or its handle. */
function leave(state) {
  if (state.name === "opening") return [{ type: "cancel", attempt: state.attempt }];
  if (state.name === "retrying") return [{ type: "clearTimer" }];
  if (state.name === "absent" && state.cooling) return [{ type: "clearTimer" }];
  if (state.name === "ready") return [{ type: "uninstall" }];
  return [];
}

const start = (from, documentId, how, stop = leave(from)) =>
  ok({ name: "opening", attempt: 1, id: documentId, via: how }, [
    ...stop,
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
  if (event.answer === "named" || event.answer === "derived") {
    // An open document stays open on a new connection: sync resumes on it.
    if (state.name === "ready" && state.id === event.id) return reject(state, REJECT.ready);
    // Anything else starts over, a running lookup included: it ran on a
    // connection that is gone.
    return start(state, event.id, event.answer);
  }
  const next = quietState(event);
  if (state.name === next.name && state.id === undefined) return reject(state, REJECT.same);
  return ok(next, leave(state));
}

function wanted(state, event) {
  switch (state.name) {
    case "retired":
      return reject(state, REJECT.retired);
    case "closed":
      return reject(state, REJECT.closed);
    case "ready":
      return reject(state, REJECT.ready);
    case "opening":
    case "retrying":
      return reject(state, REJECT.looking);
    case "absent":
      if (!state.cooling) return start(state, event.id, "derived");
      if (state.asked) return reject(state, REJECT.asked);
      return ok({ ...state, asked: true });
  }
  // unserved, unreadable, failed: the host answered on this connection.
  return reject(state, REJECT.answered);
}

/** The host answered lookup `state` that it holds no such document. */
function missing(state) {
  if (state.via === "named") return ok({ name: "unserved", id: state.id });
  const forget = { type: "forget", id: state.id };
  if (state.attempt < MISSING_ATTEMPTS)
    return ok({ name: "retrying", attempt: state.attempt, id: state.id, via: state.via }, [
      forget,
      { type: "schedule", attempt: state.attempt, delay: retryDelay(state.attempt) },
    ]);
  return ok({ name: "absent", id: state.id, cooling: true }, [
    forget,
    { type: "cool", delay: LOOK_AGAIN_MS },
  ]);
}

function transition(state, event) {
  const current = (name) => state.name === name && state.attempt === event.attempt;
  switch (event.type) {
    case "discovered":
      return discovered(state, event);
    case "wanted":
      return wanted(state, event);
    case "opened":
      if (!current("opening")) return reject(state, REJECT.stale);
      return ok({ name: "ready", id: state.id }, [{ type: "install", attempt: event.attempt }]);
    case "lookupFailed":
      if (!current("opening")) return reject(state, REJECT.stale);
      if (state.attempt >= OPEN_ATTEMPTS)
        return ok({ name: "failed", attempt: state.attempt, id: state.id, via: state.via });
      return ok({ name: "retrying", attempt: state.attempt, id: state.id, via: state.via }, [
        { type: "schedule", attempt: state.attempt, delay: retryDelay(state.attempt) },
      ]);
    case "unknown":
      if (!current("opening")) return reject(state, REJECT.stale);
      return missing(state);
    case "timer":
      if (!current("retrying")) return reject(state, REJECT.stale);
      return ok({ name: "opening", attempt: state.attempt + 1, id: state.id, via: state.via }, [
        { type: "lookup", attempt: state.attempt + 1, id: state.id },
      ]);
    case "cooled":
      if (state.name !== "absent" || !state.cooling) return reject(state, REJECT.stale);
      // The timer already fired: nothing is left to clear.
      if (state.asked) return start(state, state.id, "derived", []);
      return ok({ name: "absent", id: state.id });
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

export const hostDocOpenMachine = defineMachine({
  ...hostDocOpenSpec,
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

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
 * chart asks for a source. Before any connection is admitted, the same ask
 * reads the document from this tab's replica database, when the Page itself
 * is open from there. A lookup carries how it was started (`via`), because a
 * "no such document" answer means different things:
 *
 * - `named`: discovery named the document, so a host that answers it holds
 *   no such document doesn't serve the type. That is an older host.
 * - `derived`: the replica derived the id, so the answer means the document
 *   doesn't exist yet (or isn't on this Page). The lookup retries on a short
 *   backoff, then the replica rests in `absent`, counting `misses`. From
 *   there an ask runs one lookup per look-again window, and each miss
 *   widens the window (lookAgainDelay: 10 s, 30 s, then 60 s). Something
 *   that keeps asking (a view embed on the Page, a table waiting for a
 *   source) is standing demand: one lookup runs at the end of each window
 *   for as long as it asks. The misses outlast a close and a new
 *   connection: a derived discovery of a document that missed runs no new
 *   burst, but waits out what is left of its window (`wait`) and then looks
 *   once.
 * - `stored`: no connection is admitted, so the answer comes from this tab's
 *   stored bytes alone. A hit opens the document from its last-known-good
 *   copy, and sync resumes on it when a connection is admitted, as it does
 *   for any open document across a reconnect. A miss is not a verdict: only
 *   the host can say a document is missing. The replica returns to `closed`,
 *   marked `checked`, retries nothing, and waits for the next connection.
 *
 * States:
 * - closed: no replica, or no connection admitted since it opened. A
 *   replica closed after derived misses keeps the `id` and `misses`. One
 *   whose stored lookup found nothing is `checked`: this tab's copy was
 *   read once, and only a connection looks again.
 * - absent: there is no such document. Discovery named none, or a derived
 *   lookup was answered "none". After derived misses it holds the `id` it
 *   looked up and how many times it rested (`misses`), and `cooling` while
 *   the look-again timer is armed; an ask in that window sets `asked`, and
 *   one lookup runs when the timer fires.
 * - unserved: the host doesn't serve the document to this build: its
 *   discovery has no document map, or its socket answered a named document
 *   as unknown. Both are an older host that doesn't know the type. `id` is
 *   the document it named, if any.
 * - unreadable: discovery names the document at a format this build doesn't
 *   read. Nothing is looked up.
 * - opening: lookup `attempt` for document `id` is running, started `via`.
 *   A lookup after the replica rested carries its `misses`; it doesn't
 *   retry a "none" answer.
 * - retrying: lookup `attempt` failed or missed; the next one waits on a
 *   timer. A stored lookup never retries.
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
 *   and a running lookup restarts on the new connection, except that a
 *   derived document that missed keeps its misses. `wait` is the time left
 *   in the look-again window the interpreter last armed for it. A running
 *   stored lookup is cancelled, and the repo's answer to it forgotten: it
 *   may hold an "unavailable" answer no event has reported yet, which a
 *   lookup on the live connection would read as the host's.
 * - wanted: something on the Page asks for the document, whose derived id is
 *   `id`. Only an absent document is looked up again.
 * - stored: something on the Page asks for the document, whose derived id is
 *   `id`, while no connection is admitted and the Page is open from this
 *   tab's stored copy. Only a fresh `closed` replica (no misses, not
 *   `checked`) looks it up, in this tab's stored bytes.
 * - opened / lookupFailed / unknown: lookup `attempt` found the document,
 *   failed, or the host answered it holds no such document. An attempt that
 *   isn't the current one was cancelled, so its result is ignored. A stored
 *   lookup that fails or finds nothing closes the replica as `checked`.
 * - timer: the retry timer for `attempt` fired.
 * - cooled: the look-again timer fired; `demanded` while something on the
 *   Page still asks for the document.
 * - retire: the replica is being retired with the Page's other documents.
 *   It drops the document from memory; its synced bytes stay in the tab's
 *   replica database, the same as the Page's and comments' synced bytes.
 * - close: the replica closed or was replaced; everything stops. A `checked`
 *   replica closes to a fresh `closed`: a replaced backend holds other bytes.
 *   A running stored lookup is cancelled and its answer forgotten, as for a
 *   discovery: a view replica closes and reopens on the same repo.
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
/** The look-again windows after each rest, widening; the last one holds. */
export const LOOK_AGAIN_MS = Object.freeze([10_000, 30_000, 60_000]);
/** The look-again window after the replica rested `misses` times. */
export const lookAgainDelay = (misses) => LOOK_AGAIN_MS[Math.min(misses, LOOK_AGAIN_MS.length) - 1];

const ANSWERS = ["named", "derived", "none", "unaware", "unreadable"];
const VIA = ["named", "derived", "stored"];

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
const via = (value) => check(VIA.includes(value.via), `via is one of ${VIA.join(", ")}`);
/** Only a lookup on a connection waits to retry or gives up. */
const connectedVia = (value) =>
  check(value.via !== "stored", "a stored lookup neither retries nor fails");
const delay = (value) =>
  check(Number.isSafeInteger(value.delay) && value.delay > 0, "delay must be positive");
const answer = (value) => {
  check(ANSWERS.includes(value.answer), `answer is one of ${ANSWERS.join(", ")}`);
  const carriesId = value.answer === "named" || value.answer === "derived";
  check(carriesId === (value.id !== undefined), "only a named or derived answer has an id");
  optionalId(value);
  check(
    value.wait === undefined ||
      (value.answer === "derived" && Number.isSafeInteger(value.wait) && value.wait > 0),
    "only a derived answer waits, a positive number of ms",
  );
};
const optionalMisses = (value) =>
  check(
    value.misses === undefined || (Number.isSafeInteger(value.misses) && value.misses > 0),
    "misses is a positive integer or absent",
  );
const closedShape = (value) => {
  optionalId(value);
  optionalMisses(value);
  check((value.id === undefined) === (value.misses === undefined), "a closed miss keeps its id");
  check(value.checked === undefined || value.checked === true, "checked is true or absent");
  check(
    value.checked === undefined || value.misses === undefined,
    "only a fresh closed replica reads this tab's copy",
  );
};
const absentShape = (value) => {
  optionalId(value);
  optionalMisses(value);
  check(value.cooling === undefined || value.cooling === true, "cooling is true or absent");
  check(value.asked === undefined || value.asked === true, "asked is true or absent");
  check(value.misses === undefined || value.id !== undefined, "only a missed lookup counts");
  check(value.cooling === undefined || value.misses !== undefined, "only a rested lookup cools");
  check(value.asked === undefined || value.cooling === true, "only a cooling state is asked");
};
const lookupMisses = (value) => {
  optionalMisses(value);
  check(value.misses === undefined || value.via === "derived", "only a derived lookup misses");
};
const shape =
  (head, keys, ...checks) =>
  (value) => {
    only(value, [head, ...keys]);
    for (const fn of checks) fn(value);
  };
const bare = shape("name", []);
const lookupState = shape(
  "name",
  ["attempt", "id", "via", "misses"],
  attempt,
  id,
  via,
  lookupMisses,
);
const connectedLookup = shape(
  "name",
  ["attempt", "id", "via", "misses"],
  attempt,
  id,
  via,
  lookupMisses,
  connectedVia,
);
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
    "stored",
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
      ["unserved", "unreadable", "failed"].map((name) => [
        `${name}/discovered`,
        ["named", "derived", ...QUIET],
      ]),
    ),
    "closed/discovered": ["named", "derived", ...QUIET, "missed", "waits"],
    "absent/discovered": ["named", "derived", ...QUIET, "cooling", "waits"],
    "opening/discovered": ["lookup", "missed", "stored", ...QUIET],
    "retrying/discovered": ["lookup", ...QUIET],
    "ready/discovered": ["same", "other", ...QUIET],
    "absent/wanted": ["look", "again", "ask", "asked"],
    "closed/stored": ["look", "missed", "checked"],
    "opening/opened": ["current", "stale"],
    "opening/lookupFailed": ["retry", "exhausted", "stored", "stale"],
    "opening/unknown": ["unserved", "retry", "missing", "again", "stored", "stale"],
    "retrying/timer": ["current", "stale"],
    "absent/cooled": ["look", "demanded", "rest", "stale"],
    "closed/close": ["closed", "checked"],
    "opening/close": ["lookup", "stored"],
  },
  validate: {
    states: {
      closed: shape("name", ["id", "misses", "checked"], closedShape),
      absent: shape("name", ["id", "misses", "cooling", "asked"], absentShape),
      unserved: shape("name", ["id"], optionalId),
      unreadable: bare,
      opening: lookupState,
      retrying: connectedLookup,
      failed: connectedLookup,
      ready: shape("name", ["id"], id),
      retired: bare,
    },
    events: {
      discovered: shape("type", ["answer", "id", "wait"], answer),
      wanted: shape("type", ["id"], id),
      stored: shape("type", ["id"], id),
      opened: settled,
      lookupFailed: settled,
      unknown: settled,
      timer: settled,
      cooled: shape("type", ["demanded"], (value) =>
        check(
          value.demanded === undefined || value.demanded === true,
          "demanded is true or absent",
        ),
      ),
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
  missed: "The host answered it holds none; only a connection looks again",
  checked: "This tab's copy was read; only a connection looks again",
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

/** A lookup's state fields: `misses` stays with a derived lookup after the
 * replica rested, so its answer doesn't start another burst. */
const lookup = (name, attempt, documentId, how, misses) => ({
  name,
  attempt,
  id: documentId,
  via: how,
  ...(misses !== undefined && { misses }),
});

const start = (from, documentId, how, stop = leave(from), misses) =>
  ok(lookup("opening", 1, documentId, how, misses), [
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

/** The misses `state` carries for derived document `id`, if any. */
const missesFor = (state, id) => (state.id === id ? state.misses : undefined);

/** What leaving `state` for a connection's answer or a close needs: a
 * running stored lookup is cancelled and the repo's answer to it forgotten,
 * because an "unavailable" answer it left there would read as the host's on
 * a live link. */
const leaveLookup = (state) =>
  state.name === "opening" && state.via === "stored"
    ? [...leave(state), { type: "forget", id: state.id }]
    : leave(state);

function discovered(state, event) {
  if (state.name === "retired") return reject(state, REJECT.retired);
  const misses = event.answer === "derived" ? missesFor(state, event.id) : undefined;
  if (misses !== undefined) {
    // A document that missed keeps its misses: what is left of its window
    // passes first, then one lookup runs.
    if (event.wait)
      return ok({ name: "absent", id: event.id, misses, cooling: true }, [
        ...leave(state),
        { type: "cool", delay: event.wait },
      ]);
    return start(state, event.id, "derived", leave(state), misses);
  }
  const stop = leaveLookup(state);
  if (event.answer === "named" || event.answer === "derived") {
    // An open document stays open on a new connection: sync resumes on it.
    if (state.name === "ready" && state.id === event.id) return reject(state, REJECT.ready);
    // Anything else starts over, a running lookup included: it ran on a
    // connection that is gone, or on none.
    return start(state, event.id, event.answer, stop);
  }
  const next = quietState(event);
  if (state.name === next.name && state.id === undefined) return reject(state, REJECT.same);
  return ok(next, stop);
}

/** Something asks for the document while no connection is admitted: a
 * fresh closed replica reads this tab's stored bytes, once. */
function stored(state, event) {
  switch (state.name) {
    case "retired":
      return reject(state, REJECT.retired);
    case "ready":
      return reject(state, REJECT.ready);
    case "opening":
    case "retrying":
      return reject(state, REJECT.looking);
    case "closed":
      if (state.misses !== undefined) return reject(state, REJECT.missed);
      if (state.checked) return reject(state, REJECT.checked);
      return start(state, event.id, "stored", []);
  }
  // absent, unserved, unreadable, failed: the host answered.
  return reject(state, REJECT.answered);
}

/** A stored lookup opened nothing: this tab's copy was read, and the next
 * connection decides. The repo's "unavailable" answer is forgotten before
 * the next lookup of the id. */
const storedMiss = (state) =>
  ok({ name: "closed", checked: true }, [{ type: "forget", id: state.id }]);

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
      // After a rest, one lookup; the window it opens paces the next.
      if (!state.cooling) return start(state, event.id, "derived", [], state.misses);
      if (state.asked) return reject(state, REJECT.asked);
      return ok({ ...state, asked: true });
  }
  // unserved, unreadable, failed: the host answered on this connection.
  return reject(state, REJECT.answered);
}

/** The host answered lookup `state` that it holds no such document. A
 * first burst retries; after that, each miss rests the replica again behind
 * a wider window. */
function missing(state) {
  if (state.via === "named") return ok({ name: "unserved", id: state.id });
  const forget = { type: "forget", id: state.id };
  if (state.misses === undefined && state.attempt < MISSING_ATTEMPTS)
    return ok(lookup("retrying", state.attempt, state.id, state.via), [
      forget,
      { type: "schedule", attempt: state.attempt, delay: retryDelay(state.attempt) },
    ]);
  const misses = (state.misses ?? 0) + 1;
  return ok({ name: "absent", id: state.id, misses, cooling: true }, [
    forget,
    { type: "cool", delay: lookAgainDelay(misses) },
  ]);
}

/** The closed state after `state`: a derived document that missed keeps its
 * id and misses. */
const closedAfter = (state) =>
  state.misses === undefined
    ? { name: "closed" }
    : { name: "closed", id: state.id, misses: state.misses };

function transition(state, event) {
  const current = (name) => state.name === name && state.attempt === event.attempt;
  switch (event.type) {
    case "discovered":
      return discovered(state, event);
    case "wanted":
      return wanted(state, event);
    case "stored":
      return stored(state, event);
    case "opened":
      if (!current("opening")) return reject(state, REJECT.stale);
      return ok({ name: "ready", id: state.id }, [{ type: "install", attempt: event.attempt }]);
    case "lookupFailed":
      if (!current("opening")) return reject(state, REJECT.stale);
      if (state.via === "stored") return storedMiss(state);
      if (state.attempt >= OPEN_ATTEMPTS)
        return ok(lookup("failed", state.attempt, state.id, state.via, state.misses));
      return ok(lookup("retrying", state.attempt, state.id, state.via, state.misses), [
        { type: "schedule", attempt: state.attempt, delay: retryDelay(state.attempt) },
      ]);
    case "unknown":
      if (!current("opening")) return reject(state, REJECT.stale);
      if (state.via === "stored") return storedMiss(state);
      return missing(state);
    case "timer":
      if (!current("retrying")) return reject(state, REJECT.stale);
      return ok(lookup("opening", state.attempt + 1, state.id, state.via, state.misses), [
        { type: "lookup", attempt: state.attempt + 1, id: state.id },
      ]);
    case "cooled":
      if (state.name !== "absent" || !state.cooling) return reject(state, REJECT.stale);
      // The timer already fired: nothing is left to clear.
      if (state.asked || event.demanded) return start(state, state.id, "derived", [], state.misses);
      return ok({ name: "absent", id: state.id, misses: state.misses });
    case "retire":
      if (state.name === "retired") return reject(state, REJECT.retired);
      return ok({ name: "retired" }, leave(state));
    case "close":
      if (state.name === "retired") return reject(state, REJECT.retired);
      // A replaced backend holds other bytes: its copy is read afresh.
      if (state.name === "closed")
        return state.checked ? ok({ name: "closed" }) : reject(state, REJECT.closed);
      return ok(closedAfter(state), leaveLookup(state));
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

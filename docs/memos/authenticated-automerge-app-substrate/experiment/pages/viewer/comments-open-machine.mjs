/**
 * Opening a Page's comments document on a replica, as a state machine.
 *
 * The comments document is found in this replica's repo by its document ID,
 * which discovery names (or the local record, once a discovery has). The
 * lookup can time out or fail while the Page itself is connected, so it gets
 * its own lifecycle with retries and a visible failure.
 *
 * States:
 * - closed: nothing to open; no replica, or no document ID yet.
 * - opening: lookup `attempt` for document `id` is running.
 * - ready: the comments document is open.
 * - retrying: lookup `attempt` failed; the next one waits on a timer.
 * - failed: lookups kept failing. Comments stay read-only and the Page says
 *   so, until a reconnect or an explicit retry starts over.
 *
 * Events:
 * - open: the replica knows document `id` (discovery, or the local record).
 * - opened / lookupFailed: lookup `attempt` settled. An attempt that isn't
 *   the current one was cancelled, so its result is ignored.
 * - timer: the retry timer for `attempt` fired.
 * - reconnected: the Page's connection was (re)admitted; a failed or waiting
 *   lookup starts over at once.
 * - retry: the person asked to try again.
 * - close: the replica closed or was replaced; everything stops.
 *
 * Effects:
 * - lookup: find document `id` as `attempt`, with a timeout.
 * - cancel: abort lookup `attempt` (its late result is ignored anyway).
 * - schedule: arm the retry timer for `attempt` after `delay` ms.
 * - clearTimer: disarm the retry timer.
 * - install: adopt the handle lookup `attempt` found.
 */
import { defineMachine, reject } from "../shared/machine.mjs";

/** Lookups before the machine stops retrying and shows the failure. */
export const OPEN_ATTEMPTS = 5;
/** Retry delay after failed attempt `n` (1-based): 1 s, 2 s, 4 s, 8 s. */
export const retryDelay = (attempt) => Math.min(1000 * 2 ** (attempt - 1), 8000);

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
const delay = (value) =>
  check(Number.isSafeInteger(value.delay) && value.delay > 0, "delay must be positive");
const shape =
  (head, keys, ...checks) =>
  (value) => {
    only(value, [head, ...keys]);
    for (const fn of checks) fn(value);
  };

export const commentsOpenSpec = Object.freeze({
  name: "comments-open",
  states: ["closed", "opening", "ready", "retrying", "failed"],
  events: ["open", "opened", "lookupFailed", "timer", "reconnected", "retry", "close"],
  cases: {
    "opening/opened": ["current", "stale"],
    "opening/lookupFailed": ["retry", "exhausted", "stale"],
    "retrying/timer": ["current", "stale"],
    "closed/open": ["new"],
    "ready/open": ["same", "other"],
  },
  validate: {
    states: {
      closed: shape("name", []),
      opening: shape("name", ["attempt", "id"], attempt, id),
      ready: shape("name", ["id"], id),
      retrying: shape("name", ["attempt", "id"], attempt, id),
      failed: shape("name", ["attempt", "id"], attempt, id),
    },
    events: {
      open: shape("type", ["id"], id),
      opened: shape("type", ["attempt"], attempt),
      lookupFailed: shape("type", ["attempt"], attempt),
      timer: shape("type", ["attempt"], attempt),
      reconnected: shape("type", []),
      retry: shape("type", []),
      close: shape("type", []),
    },
    effects: {
      lookup: shape("type", ["attempt", "id"], attempt, id),
      cancel: shape("type", ["attempt"], attempt),
      schedule: shape("type", ["attempt", "delay"], attempt, delay),
      clearTimer: shape("type", []),
      install: shape("type", ["attempt"], attempt),
    },
  },
});

export const REJECT = Object.freeze({
  stale: "That lookup was cancelled",
  closed: "Nothing is opening",
  busy: "Already opening",
  ready: "Already open",
  noId: "No comments document to open",
});

const ok = (state, effects = []) => ({ state, effects });
const start = (attemptNumber, documentId, effects = []) =>
  ok({ name: "opening", attempt: attemptNumber, id: documentId }, [
    ...effects,
    { type: "lookup", attempt: attemptNumber, id: documentId },
  ]);

function transition(state, event) {
  switch (event.type) {
    case "open":
      if (state.name === "closed") return start(1, event.id);
      if (state.name === "ready") {
        if (state.id === event.id) return reject(state, REJECT.ready);
        // Discovery named a different document: the record was replaced.
        return start(1, event.id);
      }
      if (state.id === event.id) return reject(state, REJECT.busy);
      return start(
        1,
        event.id,
        state.name === "opening"
          ? [{ type: "cancel", attempt: state.attempt }]
          : state.name === "retrying"
            ? [{ type: "clearTimer" }]
            : [],
      );
    case "opened":
      if (state.name !== "opening" || state.attempt !== event.attempt)
        return reject(state, REJECT.stale);
      return ok({ name: "ready", id: state.id }, [{ type: "install", attempt: event.attempt }]);
    case "lookupFailed":
      if (state.name !== "opening" || state.attempt !== event.attempt)
        return reject(state, REJECT.stale);
      if (state.attempt >= OPEN_ATTEMPTS)
        return ok({ name: "failed", attempt: state.attempt, id: state.id });
      return ok({ name: "retrying", attempt: state.attempt, id: state.id }, [
        { type: "schedule", attempt: state.attempt, delay: retryDelay(state.attempt) },
      ]);
    case "timer":
      if (state.name !== "retrying" || state.attempt !== event.attempt)
        return reject(state, REJECT.stale);
      return start(state.attempt + 1, state.id);
    case "reconnected":
    case "retry":
      if (state.name === "retrying") return start(1, state.id, [{ type: "clearTimer" }]);
      if (state.name === "failed") return start(1, state.id);
      if (state.name === "closed") return reject(state, REJECT.noId);
      if (state.name === "ready") return reject(state, REJECT.ready);
      return reject(state, REJECT.busy);
    case "close":
      if (state.name === "closed") return reject(state, REJECT.closed);
      return ok(
        { name: "closed" },
        state.name === "opening"
          ? [{ type: "cancel", attempt: state.attempt }]
          : state.name === "retrying"
            ? [{ type: "clearTimer" }]
            : [],
      );
  }
  throw new Error(`unknown event ${event.type}`);
}

export const commentsOpenMachine = defineMachine({
  ...commentsOpenSpec,
  initial: { name: "closed" },
  transition,
});

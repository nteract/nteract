/**
 * Whether a viewer session is still catching up to the host after a socket is
 * admitted, as a state machine.
 *
 * A reopened Page renders its local copy first. Changes made elsewhere then
 * arrive over the socket. This machine decides when the status line says
 * "Catching up…" while they do, and when it stops.
 *
 * The host's frontier is the only proof of being caught up. `/api/saved`
 * answers with `durableHeads` (and `durableCommentHeads`): the host's heads
 * when it answered. PageSession asks for them once per admitted socket, with
 * heads the host already acknowledged so it answers at once, and every save
 * receipt answers with them too. When this replica holds that frontier, it has
 * everything the host had then. A frontier it doesn't hold yet is kept, and
 * every remote change rechecks it, so catch-up ends when the last missing
 * change lands, whatever the save debounce is doing. Remote changes alone
 * prove nothing: they arrive the same way during live collaboration.
 *
 * Showing at a fixed delay would flash on a small Page whose frontier answer
 * lands just after it. So "Catching up…" shows only on evidence once
 * CATCH_UP_SHOW_MS has passed: the host's frontier is known and not held, or
 * remote changes are still arriving before any frontier answered.
 *
 * CATCH_UP_LIMIT_MS bounds the whole thing. A socket that never proves this
 * replica current (a lost answer, a host that keeps moving) stops showing the
 * label then. That end is `timedOut`, not `current`: nothing claims the Page
 * caught up, and the interpreter logs it.
 *
 * States. Each carries `attempt`, the count of admitted sockets, which fences
 * timers and frontier answers to the socket they belong to. `frontier` is
 * `{ page: heads, comments: heads | null }` or null:
 * - detached: no socket is admitted. The connection status speaks instead.
 * - opening: a socket was admitted under CATCH_UP_SHOW_MS ago. A frontier is
 *   kept when an answer showed the host ahead.
 * - settling: the threshold passed with no answer. Nothing shows; a remote
 *   change now means catch-up is still going.
 * - catchingUp: the status says "Catching up…".
 * - current: this replica held the host's frontier. Nothing shows until the
 *   next admitted socket, so collaborators' changes never bring it back.
 * - timedOut: the limit passed unproven. Nothing shows until the next
 *   admitted socket.
 *
 * Events: `admitted` (a socket was admitted and the Page's handle is open),
 * `disconnected` (the socket closed or the host is unreachable), `elapsed`
 * and `expired` (the threshold and limit timers for `attempt` fired),
 * `remote` (a remote change was applied; `held` when this replica now holds
 * the kept frontier), and `answered` (the host's frontier for a request sent
 * during `attempt`; `held` when this replica holds it).
 *
 * Effects: `startTimer` and `startLimit` arm the threshold and limit timers
 * for `attempt`, replacing any armed one; `cancelTimer` and `cancelLimit`
 * disarm them; `timedOut` reports a limit that passed unproven. CatchUp
 * (catch-up.mjs) runs them on an RxJS scheduler.
 */
import { defineMachine, reject } from "../shared/machine.mjs";

/** How long after a socket is admitted catch-up may run before it shows. */
export const CATCH_UP_SHOW_MS = 300;
/** How long after a socket is admitted catch-up may show at all. Catching
 * up 2,000 changes takes about 0.5 s in Node (catch-up-benchmark.mjs), and
 * 1.4 s in the browser over a link that delays each frame 150 ms. 15 s leaves
 * an order of magnitude for IndexedDB, editor work and a slow link. It ends
 * before OUTAGE_MS (20 s), so a stuck label never sits beside the outage
 * notice. Past it, the receipt status still reports real save problems. */
export const CATCH_UP_LIMIT_MS = 15_000;

const HEAD = /^[0-9a-f]{64}$/;
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const only = (value, keys) => {
  for (const key of Object.keys(value)) check(keys.includes(key), `unexpected field ${key}`);
};
const heads = (value, label) =>
  check(
    Array.isArray(value) && value.length > 0 && value.every((head) => HEAD.test(head)),
    `${label} must be a non-empty list of heads`,
  );
const frontierOf = (value, nullable) => {
  if (value === null && nullable) return;
  check(value !== null && typeof value === "object", "frontier must be an object");
  only(value, ["page", "comments"]);
  heads(value.page, "frontier.page");
  if (value.comments !== null) heads(value.comments, "frontier.comments");
};
const attemptOf = (value, positive = false) =>
  check(
    Number.isSafeInteger(value.attempt) && value.attempt >= (positive ? 1 : 0),
    positive ? "attempt must be a positive integer" : "attempt must be a non-negative integer",
  );
const bare = (state) => {
  only(state, ["name", "attempt"]);
  attemptOf(state);
};
const admitted = (state) => {
  only(state, ["name", "attempt"]);
  attemptOf(state, true);
};
const keeping = (state) => {
  only(state, ["name", "attempt", "frontier"]);
  attemptOf(state, true);
  frontierOf(state.frontier, true);
};
const typed = (keys) => (value) => only(value, ["type", ...keys]);
const fenced = (value) => {
  only(value, ["type", "attempt"]);
  attemptOf(value);
};

export const viewerCatchUpSpec = Object.freeze({
  name: "viewer-catch-up",
  states: ["detached", "opening", "settling", "catchingUp", "current", "timedOut"],
  events: ["admitted", "disconnected", "elapsed", "expired", "remote", "answered"],
  cases: {
    "opening/elapsed": ["behind", "unproven", "stale"],
    "opening/expired": ["limit", "stale"],
    "settling/expired": ["limit", "stale"],
    "catchingUp/expired": ["limit", "stale"],
    "opening/remote": ["held", "unproven"],
    "catchingUp/remote": ["held", "unproven"],
    "opening/answered": ["held", "behind", "stale"],
    "settling/answered": ["held", "behind", "stale"],
    "catchingUp/answered": ["held", "behind", "stale"],
    "timedOut/answered": ["held", "behind", "stale"],
  },
  validate: {
    states: {
      detached: bare,
      opening: keeping,
      settling: admitted,
      catchingUp: keeping,
      current: admitted,
      timedOut: admitted,
    },
    events: {
      admitted: typed([]),
      disconnected: typed([]),
      elapsed: fenced,
      expired: fenced,
      remote(event) {
        only(event, ["type", "held"]);
        check(typeof event.held === "boolean", "held must be a boolean");
      },
      answered(event) {
        only(event, ["type", "attempt", "frontier", "held"]);
        attemptOf(event);
        frontierOf(event.frontier, false);
        check(typeof event.held === "boolean", "held must be a boolean");
      },
    },
    effects: {
      startTimer(effect) {
        only(effect, ["type", "attempt", "ms"]);
        attemptOf(effect, true);
        check(effect.ms === CATCH_UP_SHOW_MS, "the threshold timer waits CATCH_UP_SHOW_MS");
      },
      startLimit(effect) {
        only(effect, ["type", "attempt", "ms"]);
        attemptOf(effect, true);
        check(effect.ms === CATCH_UP_LIMIT_MS, "the limit timer waits CATCH_UP_LIMIT_MS");
      },
      cancelTimer: typed([]),
      cancelLimit: typed([]),
      timedOut(effect) {
        only(effect, ["type", "attempt"]);
        attemptOf(effect, true);
      },
    },
  },
});

export const REJECT = Object.freeze({
  detached: "No socket is admitted",
  notArmed: "No timer is armed",
  stale: "The event is for an earlier socket",
  early: "A remote change before the threshold proves nothing",
  showing: "Catch-up already shows",
  finished: "Catch-up already finished",
  gaveUp: "Catch-up already stopped showing",
});

const ok = (state, effects = []) => ({ state, effects });
const startTimer = (attempt) => ({ type: "startTimer", attempt, ms: CATCH_UP_SHOW_MS });
const startLimit = (attempt) => ({ type: "startLimit", attempt, ms: CATCH_UP_LIMIT_MS });
const CANCEL_TIMER = Object.freeze({ type: "cancelTimer" });
const CANCEL_LIMIT = Object.freeze({ type: "cancelLimit" });
// Which timers each state has armed.
const ARMED = {
  detached: [],
  opening: [CANCEL_TIMER, CANCEL_LIMIT],
  settling: [CANCEL_LIMIT],
  catchingUp: [CANCEL_LIMIT],
  current: [],
  timedOut: [],
};

function transition(state, event) {
  const { attempt } = state;
  const to = (name, frontier) =>
    frontier === undefined ? { name, attempt } : { name, attempt, frontier };
  const stale = "attempt" in event && event.attempt !== attempt;
  switch (event.type) {
    case "admitted": {
      const next = attempt + 1;
      // A socket replaced mid catch-up keeps the label up: it has no proof
      // yet. Its earlier frontier belongs to the earlier socket.
      if (state.name === "catchingUp")
        return ok({ name: "catchingUp", attempt: next, frontier: null }, [startLimit(next)]);
      return ok({ name: "opening", attempt: next, frontier: null }, [
        startTimer(next),
        startLimit(next),
      ]);
    }
    case "disconnected":
      if (state.name === "detached") return reject(state, REJECT.detached);
      return ok(to("detached"), ARMED[state.name]);
    case "elapsed":
      if (state.name !== "opening") return reject(state, REJECT.notArmed);
      if (stale) return reject(state, REJECT.stale);
      return state.frontier ? ok(to("catchingUp", state.frontier)) : ok(to("settling"));
    case "expired":
      if (!["opening", "settling", "catchingUp"].includes(state.name))
        return reject(state, REJECT.notArmed);
      if (stale) return reject(state, REJECT.stale);
      return ok(to("timedOut"), [
        ...(state.name === "opening" ? [CANCEL_TIMER] : []),
        { type: "timedOut", attempt },
      ]);
    case "remote":
      switch (state.name) {
        case "detached":
          return reject(state, REJECT.detached);
        case "opening":
          if (state.frontier && event.held) return ok(to("current"), ARMED.opening);
          return reject(state, REJECT.early);
        case "settling":
          return ok(to("catchingUp", null));
        case "catchingUp":
          if (state.frontier && event.held) return ok(to("current"), ARMED.catchingUp);
          return reject(state, REJECT.showing);
        case "current":
          return reject(state, REJECT.finished);
        case "timedOut":
          return reject(state, REJECT.gaveUp);
      }
      break;
    case "answered":
      if (state.name === "detached") return reject(state, REJECT.detached);
      if (state.name === "current") return reject(state, REJECT.finished);
      if (stale) return reject(state, REJECT.stale);
      if (event.held) return ok(to("current"), ARMED[state.name]);
      switch (state.name) {
        case "opening":
          return ok(to("opening", event.frontier));
        case "settling":
        case "catchingUp":
          return ok(to("catchingUp", event.frontier));
        case "timedOut":
          return reject(state, REJECT.gaveUp);
      }
      break;
  }
  throw new Error(`unknown event ${event.type} in ${state.name}`);
}

export const viewerCatchUpMachine = defineMachine({
  ...viewerCatchUpSpec,
  initial: { name: "detached", attempt: 0 },
  transition,
});

/** Whether the status line says "Catching up…". */
export const catchingUp = (state) => state.name === "catchingUp";

/** The frontier a state keeps, or null. */
export const keptFrontier = (state) => state.frontier ?? null;

/**
 * Whether a viewer session is still catching up to the host after a socket is
 * admitted, as a state machine.
 *
 * A reopened Page renders its local copy first. Changes made elsewhere then
 * arrive over the socket. This machine decides when the status line says
 * "Catching up…" while they do, and when it stops.
 *
 * The host's frontier is the only proof of being caught up. Every
 * acknowledged receipt (`/api/saved`) answers with `durableHeads`: the host
 * document's heads when it acknowledged. When this replica holds all of them,
 * it has everything the host had then. Remote changes alone prove nothing:
 * they arrive the same way during live collaboration.
 *
 * Receipts are debounced, so the proof comes at least a debounce after the
 * last change. A short catch-up would flash the indicator if it showed at the
 * threshold. So it shows only on evidence that catch-up is still going once
 * CATCH_UP_SHOW_MS has passed: a receipt said the host was ahead, or remote
 * changes are still arriving after the threshold. A small Page whose changes
 * land in one burst never shows it.
 *
 * States. Each carries `attempt`, the count of admitted sockets, which fences
 * the threshold timer:
 * - detached: no socket is admitted. The connection status speaks instead.
 * - opening: a socket was admitted under CATCH_UP_SHOW_MS ago. The timer is
 *   armed. `behind` says a receipt has already shown the host ahead.
 * - settling: the threshold passed with no evidence either way. Nothing
 *   shows; a remote change now means catch-up is still going.
 * - catchingUp: the status says "Catching up…".
 * - current: an acknowledged receipt showed this replica holds the host's
 *   frontier. Nothing shows until the next admitted socket, so later remote
 *   changes from collaborators never bring the indicator back.
 *
 * Events: `admitted` (a socket was admitted and the Page's handle is open),
 * `disconnected` (the socket closed or the host is unreachable), `elapsed`
 * (the threshold timer for `attempt` fired), `remote` (a remote change was
 * applied), and `acknowledged` (a receipt was acknowledged; `current` when
 * this replica holds the frontier it answered with).
 *
 * Effects: `startTimer` arms the threshold timer for `attempt`, replacing any
 * armed one; `cancelTimer` disarms it. CatchUp (catch-up.mjs) runs them on an
 * RxJS scheduler and feeds `elapsed` back.
 */
import { defineMachine, reject } from "../shared/machine.mjs";

/** How long after a socket is admitted catch-up may run before it shows. */
export const CATCH_UP_SHOW_MS = 300;

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const only = (value, keys) => {
  for (const key of Object.keys(value)) check(keys.includes(key), `unexpected field ${key}`);
};
const attempt = (value) =>
  check(
    Number.isSafeInteger(value.attempt) && value.attempt >= 0,
    "attempt must be a non-negative integer",
  );
const plain = (state) => {
  only(state, ["name", "attempt"]);
  attempt(state);
};
const admitted = (state) => {
  plain(state);
  check(state.attempt > 0, "an admitted socket has an attempt");
};
const typed = (keys) => (value) => only(value, ["type", ...keys]);

export const viewerCatchUpSpec = Object.freeze({
  name: "viewer-catch-up",
  states: ["detached", "opening", "settling", "catchingUp", "current"],
  events: ["admitted", "disconnected", "elapsed", "remote", "acknowledged"],
  cases: {
    "opening/elapsed": ["behind", "unproven", "stale"],
    "opening/acknowledged": ["current", "behind"],
    "settling/acknowledged": ["current", "behind"],
    "catchingUp/acknowledged": ["current", "behind"],
  },
  validate: {
    states: {
      detached: plain,
      opening(state) {
        only(state, ["name", "attempt", "behind"]);
        attempt(state);
        check(state.attempt > 0, "an admitted socket has an attempt");
        check(typeof state.behind === "boolean", "behind must be a boolean");
      },
      settling: admitted,
      catchingUp: admitted,
      current: admitted,
    },
    events: {
      admitted: typed([]),
      disconnected: typed([]),
      elapsed(event) {
        only(event, ["type", "attempt"]);
        attempt(event);
      },
      remote: typed([]),
      acknowledged(event) {
        only(event, ["type", "current"]);
        check(typeof event.current === "boolean", "current must be a boolean");
      },
    },
    effects: {
      startTimer(effect) {
        only(effect, ["type", "attempt", "ms"]);
        attempt(effect);
        check(effect.ms === CATCH_UP_SHOW_MS, "the threshold timer waits CATCH_UP_SHOW_MS");
      },
      cancelTimer: typed([]),
    },
  },
});

export const REJECT = Object.freeze({
  detached: "No socket is admitted",
  notArmed: "No threshold timer is armed",
  stale: "The timer is for an earlier socket",
  early: "A remote change before the threshold proves nothing",
  showing: "Catch-up already shows",
  stillBehind: "The host is still ahead",
  finished: "Catch-up already finished",
});

const ok = (state, effects = []) => ({ state, effects });
const startTimer = (attempt) => ({ type: "startTimer", attempt, ms: CATCH_UP_SHOW_MS });
const CANCEL = Object.freeze({ type: "cancelTimer" });
const open = (attempt, behind = false) => ({ name: "opening", attempt, behind });

function transition(state, event) {
  const at = (name) => ({ name, attempt: state.attempt });
  switch (event.type) {
    case "admitted": {
      const next = state.attempt + 1;
      // A socket replaced mid catch-up keeps the indicator up: it still has
      // no proof of being caught up.
      if (state.name === "catchingUp") return ok({ name: "catchingUp", attempt: next });
      return ok(open(next, state.name === "opening" && state.behind), [startTimer(next)]);
    }
    case "disconnected":
      if (state.name === "detached") return reject(state, REJECT.detached);
      return ok(at("detached"), state.name === "opening" ? [CANCEL] : []);
    case "elapsed":
      if (state.name !== "opening") return reject(state, REJECT.notArmed);
      if (event.attempt !== state.attempt) return reject(state, REJECT.stale);
      return ok(at(state.behind ? "catchingUp" : "settling"));
    case "remote":
      switch (state.name) {
        case "settling":
          return ok(at("catchingUp"));
        case "opening":
          return reject(state, REJECT.early);
        case "catchingUp":
          return reject(state, REJECT.showing);
        case "current":
          return reject(state, REJECT.finished);
        case "detached":
          return reject(state, REJECT.detached);
      }
      break;
    case "acknowledged":
      switch (state.name) {
        case "opening":
          return event.current ? ok(at("current"), [CANCEL]) : ok(open(state.attempt, true));
        case "settling":
          return ok(at(event.current ? "current" : "catchingUp"));
        case "catchingUp":
          return event.current ? ok(at("current")) : reject(state, REJECT.stillBehind);
        case "current":
          return reject(state, REJECT.finished);
        case "detached":
          return reject(state, REJECT.detached);
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

/**
 * When a Page session's local edits and caret go out, as a state machine.
 *
 * Every editor transaction is one Automerge change, and each local store used
 * to start its own native sync round: a request, the host's reply, then the
 * commit, three frames per keystroke, plus a presence frame. This machine
 * groups a run of requests into one send, the way the notebook's sync engine
 * debounces outbound source sync. Local durability doesn't wait for it: a
 * store has reached IndexedDB before it asks to be sent.
 *
 * States:
 * - idle: nothing is waiting to go out.
 * - waiting: requests are waiting. `first` is when the oldest arrived and
 *   `last` the newest, on the interpreter's scheduler clock. A timer is armed
 *   for the earlier of `last + DEBOUNCE_MS` and `first + MAX_WAIT_MS`, so a
 *   pause in typing sends after DEBOUNCE_MS and continuous typing still sends
 *   at least every MAX_WAIT_MS.
 * - closed: the session is ending. Each later request goes out at once.
 *
 * Events: `request` (a local store's sync round or a caret update wants to go
 * out, at time `at`), `timer` (the armed timer fired), `flush` (send now: the
 * window lost focus or was hidden, the page is unloading, or a save receipt
 * or a leave needs every edit on the wire), and `close` (the session stops;
 * anything waiting goes first).
 *
 * Effects: `arm` (start the timer for `ms`, replacing any armed one),
 * `cancel` (drop the armed timer) and `send` (start every waiting sync round,
 * then publish the newest caret). The interpreter holds what is waiting; this
 * machine only decides when it goes.
 */
import { defineMachine, reject } from "../shared/machine.mjs";

/** A pause in typing longer than this sends what was typed. Longer than the
 * gaps in fast or paste-like input, short enough to add little to the time a
 * collaborator waits for a single keystroke. */
export const OUTBOUND_DEBOUNCE_MS = 30;
/** Continuous typing sends at least this often. */
export const OUTBOUND_MAX_WAIT_MS = 100;

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const only = (value, keys) => {
  for (const key of Object.keys(value)) check(keys.includes(key), `unexpected field ${key}`);
};
const time = (value, key) =>
  check(Number.isFinite(value[key]) && value[key] >= 0, `${key} must be a time`);
const typed = (keys) => (value) => only(value, ["type", ...keys]);
const bare = (state) => only(state, ["name"]);

export const outboundSyncSpec = Object.freeze({
  name: "outbound-sync",
  states: ["idle", "waiting", "closed"],
  events: ["request", "timer", "flush", "close"],
  cases: {
    "waiting/request": ["debounce", "deadline", "due"],
  },
  validate: {
    states: {
      idle: bare,
      waiting(state) {
        only(state, ["name", "first", "last"]);
        time(state, "first");
        time(state, "last");
        check(state.last >= state.first, "the newest request can't predate the oldest");
        check(
          state.last - state.first < OUTBOUND_MAX_WAIT_MS,
          "a waiting run is younger than the maximum wait",
        );
      },
      closed: bare,
    },
    events: {
      request(event) {
        only(event, ["type", "at"]);
        time(event, "at");
      },
      timer: typed([]),
      flush: typed([]),
      close: typed([]),
    },
    effects: {
      arm(effect) {
        only(effect, ["type", "ms"]);
        check(
          Number.isFinite(effect.ms) && effect.ms > 0 && effect.ms <= OUTBOUND_DEBOUNCE_MS,
          "an armed timer waits no longer than the debounce",
        );
      },
      cancel: typed([]),
      send: typed([]),
    },
  },
});

export const REJECT = Object.freeze({
  noTimer: "No send is armed",
  nothing: "Nothing is waiting to go out",
  closed: "Outbound sync is closed",
});

const ok = (state, ...effects) => ({ state, effects });
const IDLE = Object.freeze({ name: "idle" });
const CLOSED = Object.freeze({ name: "closed" });
const SEND = Object.freeze({ type: "send" });
const CANCEL = Object.freeze({ type: "cancel" });

function transition(state, event) {
  switch (state.name) {
    case "idle":
      switch (event.type) {
        case "request":
          return ok(
            { name: "waiting", first: event.at, last: event.at },
            { type: "arm", ms: OUTBOUND_DEBOUNCE_MS },
          );
        case "timer":
          return reject(state, REJECT.noTimer);
        case "flush":
          return reject(state, REJECT.nothing);
        case "close":
          return ok(CLOSED);
      }
      break;
    case "waiting":
      switch (event.type) {
        case "request": {
          // A clock that steps back never extends the run past its deadline.
          const at = Math.max(event.at, state.last);
          const left = state.first + OUTBOUND_MAX_WAIT_MS - at;
          if (left <= 0) return ok(IDLE, CANCEL, SEND);
          return ok(
            { name: "waiting", first: state.first, last: at },
            { type: "arm", ms: Math.min(OUTBOUND_DEBOUNCE_MS, left) },
          );
        }
        case "timer":
          return ok(IDLE, SEND);
        case "flush":
          return ok(IDLE, CANCEL, SEND);
        case "close":
          return ok(CLOSED, CANCEL, SEND);
      }
      break;
    case "closed":
      if (event.type === "request") return ok(CLOSED, SEND);
      return reject(state, REJECT.closed);
  }
  throw new Error(`unknown state ${state.name}`);
}

export const outboundSyncMachine = defineMachine({
  ...outboundSyncSpec,
  initial: IDLE,
  transition,
});

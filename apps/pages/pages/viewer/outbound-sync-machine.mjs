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
 * States, with times on the interpreter's scheduler clock:
 * - idle: nothing is waiting. `sent` is when the last send went, or null when
 *   none has since the session started or the tab came back.
 * - waiting: requests are waiting. `last` is when the newest arrived. A timer
 *   is armed for the earlier of `last + DEBOUNCE_MS` and `deadline`. The
 *   deadline is MAX_WAIT_MS after the previous send when the run started
 *   within MAX_WAIT_MS of it, otherwise MAX_WAIT_MS after the run's first
 *   request. So a pause in typing sends after DEBOUNCE_MS, and continuous
 *   typing sends every MAX_WAIT_MS.
 * - background: the tab is hidden. A browser may throttle or freeze a hidden
 *   tab's timers, so every request goes out at once, unbatched, until the tab
 *   is visible again. Saves still finishing after the tab hid are covered.
 * - closed: the session is ending. Each later request goes out at once.
 *
 * Events: `request` (a local store's sync round or a caret update wants to go
 * out, at `at`), `timer` (the armed timer fired, at `at`), `flush` (send now,
 * at `at`: the window lost focus, the page may unload, or a save receipt or a
 * leave needs every edit on the wire), `hide` and `show` (the tab was hidden
 * or shown), and `close` (the session stops; anything waiting goes first).
 *
 * Effects: `arm` (start the timer for `ms`, replacing any armed one),
 * `cancel` (drop the armed timer) and `send` (start every waiting sync round,
 * then publish the newest caret). The interpreter holds what is waiting; this
 * machine only decides when it goes. Sending starts a round; on unload,
 * whether it finishes before the page goes is up to the browser.
 */
import { defineMachine, reject } from "../shared/machine.mjs";

/** A pause in typing longer than this sends what was typed. Longer than the
 * gaps in fast or paste-like input, short enough to add little to the time a
 * collaborator waits for a single keystroke. */
export const OUTBOUND_DEBOUNCE_MS = 30;
/** Continuous typing sends this often. */
export const OUTBOUND_MAX_WAIT_MS = 100;

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const only = (value, keys) => {
  for (const key of Object.keys(value)) check(keys.includes(key), `unexpected field ${key}`);
};
const isTime = (value) => Number.isFinite(value) && value >= 0;
const time = (value, key) => check(isTime(value[key]), `${key} must be a time`);
const typed = (keys) => (value) => only(value, ["type", ...keys]);
const timed = (value) => {
  only(value, ["type", "at"]);
  time(value, "at");
};
const bare = (state) => only(state, ["name"]);

export const outboundSyncSpec = Object.freeze({
  name: "outbound-sync",
  states: ["idle", "waiting", "background", "closed"],
  events: ["request", "timer", "flush", "hide", "show", "close"],
  cases: {
    "idle/request": ["fresh", "after-send"],
    "waiting/request": ["debounce", "deadline", "due"],
  },
  validate: {
    states: {
      idle(state) {
        only(state, ["name", "sent"]);
        check(state.sent === null || isTime(state.sent), "sent must be a time or null");
      },
      waiting(state) {
        only(state, ["name", "deadline", "last"]);
        time(state, "deadline");
        time(state, "last");
        check(
          state.deadline > state.last && state.deadline - state.last <= OUTBOUND_MAX_WAIT_MS,
          "a waiting run is due within the maximum wait",
        );
      },
      background: bare,
      closed: bare,
    },
    events: {
      request: timed,
      timer: timed,
      flush: timed,
      hide: typed([]),
      show: typed([]),
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
  visible: "The tab is already visible",
  hidden: "The tab is already hidden",
  closed: "Outbound sync is closed",
});

const ok = (state, ...effects) => ({ state, effects });
const VISIBLE = Object.freeze({ name: "idle", sent: null });
const BACKGROUND = Object.freeze({ name: "background" });
const CLOSED = Object.freeze({ name: "closed" });
const SEND = Object.freeze({ type: "send" });
const CANCEL = Object.freeze({ type: "cancel" });
const sentAt = (at) => ({ name: "idle", sent: at });
const arm = (deadline, at) => ({ type: "arm", ms: Math.min(OUTBOUND_DEBOUNCE_MS, deadline - at) });

function transition(state, event) {
  switch (state.name) {
    case "idle":
      switch (event.type) {
        case "request": {
          // A clock that steps back never moves the run before the last send.
          const at = state.sent === null ? event.at : Math.max(event.at, state.sent);
          const deadline =
            state.sent !== null && at - state.sent < OUTBOUND_MAX_WAIT_MS
              ? state.sent + OUTBOUND_MAX_WAIT_MS
              : at + OUTBOUND_MAX_WAIT_MS;
          return ok({ name: "waiting", deadline, last: at }, arm(deadline, at));
        }
        case "timer":
          return reject(state, REJECT.noTimer);
        case "flush":
          return reject(state, REJECT.nothing);
        case "hide":
          return ok(BACKGROUND);
        case "show":
          return reject(state, REJECT.visible);
        case "close":
          return ok(CLOSED);
      }
      break;
    case "waiting":
      switch (event.type) {
        case "request": {
          const at = Math.max(event.at, state.last);
          if (state.deadline - at <= 0) return ok(sentAt(at), CANCEL, SEND);
          return ok(
            { name: "waiting", deadline: state.deadline, last: at },
            arm(state.deadline, at),
          );
        }
        case "timer":
          return ok(sentAt(Math.max(event.at, state.last)), SEND);
        case "flush":
          return ok(sentAt(Math.max(event.at, state.last)), CANCEL, SEND);
        case "hide":
          return ok(BACKGROUND, CANCEL, SEND);
        case "show":
          return reject(state, REJECT.visible);
        case "close":
          return ok(CLOSED, CANCEL, SEND);
      }
      break;
    case "background":
      switch (event.type) {
        case "request":
          return ok(BACKGROUND, SEND);
        case "timer":
          return reject(state, REJECT.noTimer);
        case "flush":
          return reject(state, REJECT.nothing);
        case "hide":
          return reject(state, REJECT.hidden);
        case "show":
          return ok(VISIBLE);
        case "close":
          return ok(CLOSED);
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
  initial: VISIBLE,
  transition,
});

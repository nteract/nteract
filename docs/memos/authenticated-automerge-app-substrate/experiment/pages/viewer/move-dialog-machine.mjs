/**
 * The "Move to…" dialog as a state machine.
 *
 * States:
 * - closed: no dialog.
 * - loading: the dialog is open and its destinations are loading.
 * - choosing: destinations are listed; `selected` is the chosen row's index
 *   or null, and `error` holds the last failed move's message.
 * - moving: move_page is in flight for the selected destination.
 * - failed: destinations couldn't load; `error` says why.
 *
 * Every open starts a new `attempt`, chosen by the interpreter. Replies carry
 * the attempt they answer, so a late reply for an earlier opening is
 * rejected instead of overwriting a newer one. A dialog can't close or reopen
 * while a move is in flight: its outcome must reach the lists.
 *
 * Effects: `load` reads projects and Pages for the attempt, answering
 * `loaded` or `loadFailed`; `move` calls move_page, answering `moved` or
 * `moveFailed`; `notify` hands the receipt to the screen so it can refresh
 * its lists and breadcrumbs.
 */
import { defineMachine, reject } from "../shared/machine.mjs";

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const only = (value, keys) => {
  for (const key of Object.keys(value)) check(keys.includes(key), `unexpected field ${key}`);
};
const isAttempt = (value) => Number.isSafeInteger(value) && value >= 0;
const isPage = (page) =>
  page !== null &&
  typeof page === "object" &&
  typeof page.page_id === "string" &&
  typeof page.title === "string";
const isDestination = (row) =>
  row !== null &&
  typeof row === "object" &&
  typeof row.key === "string" &&
  typeof row.label === "string" &&
  Number.isSafeInteger(row.depth) &&
  (row.project_id === null || typeof row.project_id === "string") &&
  (row.parent_id === null || typeof row.parent_id === "string") &&
  typeof row.disabled === "boolean";

function open(state, keys) {
  only(state, ["name", "attempt", "page", ...keys]);
  check(isAttempt(state.attempt), "attempt is required");
  check(isPage(state.page), "page is required");
}
function listed(state) {
  check(
    Array.isArray(state.destinations) && state.destinations.every(isDestination),
    "destinations must be rows",
  );
  check(
    state.selected === null ||
      (Number.isSafeInteger(state.selected) &&
        !!state.destinations[state.selected] &&
        !state.destinations[state.selected].disabled),
    "selected names an enabled row",
  );
}
const message = (value) => check(typeof value.error === "string", "error must be a string");

export const moveDialogSpec = Object.freeze({
  name: "move-dialog",
  states: ["closed", "loading", "choosing", "moving", "failed"],
  events: ["open", "loaded", "loadFailed", "select", "submit", "moved", "moveFailed", "close"],
  unreachable: [
    ["closed", "select", "only a listed dialog renders its rows"],
    ["closed", "submit", "only a listed dialog renders its Move button"],
    ["loading", "select", "rows render once destinations load"],
    ["loading", "submit", "the Move button renders once destinations load"],
    ["moving", "select", "rows are disabled while a move runs"],
    ["moving", "submit", "the Move button is disabled while a move runs"],
    ["failed", "select", "a failed load renders no rows"],
    ["failed", "submit", "a failed load renders no Move button"],
  ],
  validate: {
    states: {
      closed: (state) => only(state, ["name"]),
      loading: (state) => open(state, []),
      choosing(state) {
        open(state, ["destinations", "selected", "error"]);
        listed(state);
        check(state.error === undefined || typeof state.error === "string", "error");
      },
      moving(state) {
        open(state, ["destinations", "selected"]);
        listed(state);
        check(state.selected !== null, "a move needs a destination");
      },
      failed(state) {
        open(state, ["error"]);
        message(state);
      },
    },
    events: {
      open(event) {
        only(event, ["type", "attempt", "page"]);
        check(isAttempt(event.attempt), "attempt is required");
        check(isPage(event.page), "page is required");
      },
      loaded(event) {
        only(event, ["type", "attempt", "destinations"]);
        check(isAttempt(event.attempt), "attempt is required");
        check(
          Array.isArray(event.destinations) && event.destinations.every(isDestination),
          "destinations must be rows",
        );
      },
      loadFailed(event) {
        only(event, ["type", "attempt", "error"]);
        message(event);
      },
      select(event) {
        only(event, ["type", "index"]);
        check(Number.isSafeInteger(event.index), "index is required");
      },
      submit: (event) => only(event, ["type"]),
      moved(event) {
        only(event, ["type", "attempt", "receipt"]);
        check(event.receipt !== null && typeof event.receipt === "object", "receipt");
      },
      moveFailed(event) {
        only(event, ["type", "attempt", "error"]);
        message(event);
      },
      close: (event) => only(event, ["type"]),
    },
    effects: {
      load: (effect) => only(effect, ["type", "attempt", "page_id"]),
      move: (effect) => only(effect, ["type", "attempt", "page_id", "destination"]),
      notify: (effect) => only(effect, ["type", "receipt"]),
    },
  },
});

export const REJECT = Object.freeze({
  running: "A move is running",
  stale: "The reply is for an earlier opening",
  closed: "The dialog is closed",
  unavailable: "That destination can't take this Page",
  unselected: "Choose a destination first",
});

const CLOSED = Object.freeze({ name: "closed" });

function transition(state, event) {
  switch (event.type) {
    case "open":
      if (state.name === "moving") return reject(state, REJECT.running);
      return {
        state: { name: "loading", attempt: event.attempt, page: event.page },
        effects: [{ type: "load", attempt: event.attempt, page_id: event.page.page_id }],
      };
    case "close":
      if (state.name === "moving") return reject(state, REJECT.running);
      if (state.name === "closed") return reject(state, REJECT.closed);
      return { state: CLOSED, effects: [] };
    case "loaded":
    case "loadFailed":
      if (state.name !== "loading" || state.attempt !== event.attempt)
        return reject(state, REJECT.stale);
      return event.type === "loaded"
        ? {
            state: {
              ...state,
              name: "choosing",
              destinations: event.destinations,
              selected: null,
            },
            effects: [],
          }
        : { state: { ...state, name: "failed", error: event.error }, effects: [] };
    case "select": {
      const row = state.destinations[event.index];
      if (!row || row.disabled) return reject(state, REJECT.unavailable);
      const { error: _error, ...rest } = state;
      return { state: { ...rest, selected: event.index }, effects: [] };
    }
    case "submit": {
      if (state.selected === null) return reject(state, REJECT.unselected);
      const { error: _error, ...rest } = state;
      const row = state.destinations[state.selected];
      return {
        state: { ...rest, name: "moving" },
        effects: [
          {
            type: "move",
            attempt: state.attempt,
            page_id: state.page.page_id,
            destination: { project_id: row.project_id, parent_id: row.parent_id },
          },
        ],
      };
    }
    case "moved":
    case "moveFailed":
      if (state.name !== "moving" || state.attempt !== event.attempt)
        return reject(state, REJECT.stale);
      return event.type === "moved"
        ? { state: CLOSED, effects: [{ type: "notify", receipt: event.receipt }] }
        : { state: { ...state, name: "choosing", error: event.error }, effects: [] };
  }
  throw new Error(`Unknown event ${event.type}`);
}

export const moveDialogMachine = defineMachine({
  ...moveDialogSpec,
  initial: CLOSED,
  transition,
});

/**
 * One dataframe table's renderer lifecycle (wordgard-dataframes.mjs runs it).
 *
 * States, each carrying `generation`, which a connect from idle and every
 * teardown advance:
 * - idle: not connected, or torn down. Nothing pending.
 * - waiting: connected, watched until it nears the viewport. No chunk or
 *   dataset is loaded for a table nobody scrolls to.
 * - scheduled: near the viewport; the short delay timer is armed, so a table
 *   scrolled straight past doesn't load.
 * - loading: the renderer chunk is loading (it fetches the dataset itself).
 * - mounted: the renderer is drawn. It stays drawn offscreen, keeping the
 *   reader's sort and filters.
 * - parked: Wordgard disconnected a mounted table. Selecting the node moves
 *   its DOM into a selection wrapper (disconnect, then connect), so the
 *   table waits out the park timer instead of reloading.
 * - failed: the chunk failed to load.
 *
 * Events: `connect` and `disconnect` (Wordgard), `visible` and `hidden` (the
 * viewport watcher), `timer` and `parkExpired` (the two timers), `loaded` and
 * `failed` (the chunk import). Timer and load events carry the generation
 * that started them; one from an older generation is rejected, so a widget
 * never holds two mounted tables.
 *
 * Effects: `showStatus` (`status`: "waiting" or "loading"), `observe` and
 * `unobserve` (the viewport watcher), `startTimer` (`timer`: "delay" or
 * "park", with its generation; the interpreter owns the durations and clears
 * any timer already armed) and `clearTimer`, `load` and `mount` (with their
 * generation), `markMoved` (turn off load-in animations replayed by a DOM
 * move), `fail` (say the table is unavailable) and `destroy` (unmount).
 *
 * Only one timer is ever armed: the delay timer in scheduled, the park timer
 * in parked. Leaving either state clears it or is it firing, so `timer` and
 * `parkExpired` can't arrive anywhere else.
 */
import { defineMachine, reject } from "../shared/machine.mjs";

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const only = (value, keys) => {
  for (const key of Object.keys(value)) check(keys.includes(key), `unexpected field ${key}`);
};
const generation = (value) => {
  check(
    Number.isSafeInteger(value.generation) && value.generation >= 0,
    "generation must be a non-negative integer",
  );
};
const state = (value) => {
  only(value, ["name", "generation"]);
  generation(value);
};
const plain = (value) => only(value, ["type"]);
const settled = (value) => {
  only(value, ["type", "generation"]);
  generation(value);
};

export const STATES = Object.freeze([
  "idle",
  "waiting",
  "scheduled",
  "loading",
  "mounted",
  "parked",
  "failed",
]);

export const REJECT = Object.freeze({
  connected: "The table is already connected",
  disconnected: "The table isn't connected",
  watching: "Nothing is watching the table's visibility",
  near: "The table is already near the viewport",
  away: "The table is already away from the viewport",
  stale: "This settled for an older connect",
  notLoading: "No load is in flight for this table",
});

const NOT_ARMED = "No timer of this kind is armed in this state";

export const dataframeTableSpec = Object.freeze({
  name: "dataframe-table",
  states: STATES,
  events: [
    "connect",
    "disconnect",
    "visible",
    "hidden",
    "timer",
    "parkExpired",
    "loaded",
    "failed",
  ],
  unreachable: [
    ...STATES.filter((name) => name !== "scheduled").map((name) => [name, "timer", NOT_ARMED]),
    ...STATES.filter((name) => name !== "parked").map((name) => [name, "parkExpired", NOT_ARMED]),
  ],
  cases: {
    "scheduled/timer": ["current", "stale"],
    "parked/parkExpired": ["current", "stale"],
    "loading/loaded": ["current", "stale"],
    "loading/failed": ["current", "stale"],
  },
  validate: {
    states: Object.fromEntries(STATES.map((name) => [name, state])),
    events: {
      connect: plain,
      disconnect: plain,
      visible: plain,
      hidden: plain,
      timer: settled,
      parkExpired: settled,
      loaded: settled,
      failed: settled,
    },
    effects: {
      showStatus(effect) {
        only(effect, ["type", "status"]);
        check(["waiting", "loading"].includes(effect.status), "status is waiting or loading");
      },
      observe: plain,
      unobserve: plain,
      startTimer(effect) {
        only(effect, ["type", "timer", "generation"]);
        check(["delay", "park"].includes(effect.timer), "timer is delay or park");
        generation(effect);
      },
      clearTimer: plain,
      load: settled,
      mount: settled,
      markMoved: plain,
      fail: plain,
      destroy: plain,
    },
  },
});

const ok = (next, ...effects) => ({ state: next, effects });
const at = (name, { generation: current }) => ({ name, generation: current });
const next = (name, { generation: current }) => ({ name, generation: current + 1 });

function transition(current, event) {
  const fresh = event.generation === current.generation;
  switch (event.type) {
    case "connect":
      if (current.name === "idle")
        return ok(
          next("waiting", current),
          { type: "showStatus", status: "waiting" },
          { type: "observe" },
        );
      if (current.name === "parked")
        return ok(at("mounted", current), { type: "clearTimer" }, { type: "markMoved" });
      return reject(current, REJECT.connected);
    case "disconnect":
      switch (current.name) {
        case "idle":
          return reject(current, REJECT.disconnected);
        case "waiting":
          return ok(next("idle", current), { type: "unobserve" });
        case "scheduled":
          return ok(next("idle", current), { type: "clearTimer" }, { type: "unobserve" });
        case "mounted":
          return ok(at("parked", current), {
            type: "startTimer",
            timer: "park",
            generation: current.generation,
          });
        case "parked":
          return ok(next("idle", current), { type: "clearTimer" }, { type: "destroy" });
        // A load in flight can't be cancelled; advancing the generation makes
        // its result stale.
        default:
          return ok(next("idle", current));
      }
    case "visible":
      if (current.name === "waiting")
        return ok(at("scheduled", current), {
          type: "startTimer",
          timer: "delay",
          generation: current.generation,
        });
      return reject(current, current.name === "scheduled" ? REJECT.near : REJECT.watching);
    case "hidden":
      if (current.name === "scheduled") return ok(at("waiting", current), { type: "clearTimer" });
      return reject(current, current.name === "waiting" ? REJECT.away : REJECT.watching);
    case "timer":
      if (!fresh) return reject(current, REJECT.stale);
      return ok(
        at("loading", current),
        { type: "unobserve" },
        { type: "showStatus", status: "loading" },
        { type: "load", generation: current.generation },
      );
    case "parkExpired":
      if (!fresh) return reject(current, REJECT.stale);
      return ok(next("idle", current), { type: "destroy" });
    case "loaded":
    case "failed":
      if (current.name !== "loading") return reject(current, REJECT.notLoading);
      if (!fresh) return reject(current, REJECT.stale);
      return event.type === "loaded"
        ? ok(at("mounted", current), { type: "mount", generation: current.generation })
        : ok(at("failed", current), { type: "fail" });
  }
}

export const dataframeTableMachine = defineMachine({
  ...dataframeTableSpec,
  initial: { name: "idle", generation: 0 },
  transition,
});

/**
 * Who holds one view replica, and whether it has one of the Page's slots, as
 * a state machine. view-replicas.mjs runs one per view id and decides which
 * waiting view a free slot goes to; host-doc-open-machine.mjs runs the
 * replica itself.
 *
 * States:
 * - closed: no replica. Nothing holds the view.
 * - waiting: `holders` hold the view, but every slot is taken. `rank` says
 *   why it waits: `fresh` (it hasn't had a slot) or `missing` (it gave its
 *   slot up because its document wasn't there). A fresh view may take the
 *   slot of a view whose document is missing; a missing one waits for a free
 *   slot. Its replica, if it had one, is closed.
 * - held: `holders` hold the view and it has a slot: its replica is open and
 *   asks for its document for as long as it is held.
 * - closing: the last holder let go; the replica keeps its slot until the
 *   close timer fires, so a holder that comes back at once (an embed the
 *   editor moved) keeps it. A waiting view may reclaim the slot first.
 * - retired: the Page's documents retired. `holders` still hold the view and
 *   read it as closed; nothing opens again.
 *
 * Events: `hold` and `release` (a holder came or went), `admit` (a slot is
 * free for it), `evict` (its slot goes to a waiting view), `closeTimer` (the
 * close timer fired), `close` (the Page's replica closed or is being
 * replaced) and `retire`.
 *
 * Effects:
 * - open: make the replica if there is none, and look its view up if a
 *   connection is up.
 * - demand / undemand: start or stop asking for the document. A held view
 *   asks once per look-again window (host-doc-replica.mjs demand).
 * - arm / disarm: the close timer.
 * - shut: close the replica; an entry that is closed is dropped.
 * - closeReplica: close the replica and keep the entry for its holders; the
 *   next admitted connection looks the view up again.
 * - retireReplica: retire the replica, if there is one.
 */
import { defineMachine, reject } from "../shared/machine.mjs";

const RANKS = ["fresh", "missing"];

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const only = (value, keys) => {
  for (const key of Object.keys(value)) check(keys.includes(key), `unexpected field ${key}`);
};
const holders = (min) => (value) =>
  check(
    Number.isSafeInteger(value.holders) && value.holders >= min,
    `holders must be at least ${min}`,
  );
const rank = (value) => check(RANKS.includes(value.rank), "rank is fresh or missing");
const shape =
  (head, keys, ...checks) =>
  (value) => {
    only(value, [head, ...keys]);
    for (const fn of checks) fn(value);
  };
const bare = (head) => shape(head, []);

const EVENTS = ["hold", "release", "admit", "evict", "closeTimer", "close", "retire"];
const EFFECTS = [
  "open",
  "demand",
  "undemand",
  "arm",
  "disarm",
  "shut",
  "closeReplica",
  "retireReplica",
];

export const viewHoldSpec = Object.freeze({
  name: "view-hold",
  states: ["closed", "waiting", "held", "closing", "retired"],
  events: EVENTS,
  cases: {
    "waiting/release": ["more", "last"],
    "held/release": ["more", "last"],
    "retired/release": ["more", "none"],
  },
  validate: {
    states: {
      closed: bare("name"),
      waiting: shape("name", ["holders", "rank"], holders(1), rank),
      held: shape("name", ["holders"], holders(1)),
      closing: bare("name"),
      retired: shape("name", ["holders"], holders(0)),
    },
    events: Object.fromEntries(EVENTS.map((type) => [type, bare("type")])),
    effects: Object.fromEntries(EFFECTS.map((type) => [type, bare("type")])),
  },
});

export const REJECT = Object.freeze({
  unheld: "Nothing holds this view",
  stale: "No close timer is armed",
  closed: "No replica is open",
  slotted: "The view already has a slot",
  slotless: "The view has no slot to give up",
  retired: "The view was retired",
});

const ok = (state, ...effects) => ({ state, effects: effects.map((type) => ({ type })) });

function transition(state, event) {
  switch (state.name) {
    case "closed":
      if (event.type === "hold") return ok({ name: "waiting", holders: 1, rank: "fresh" });
      if (event.type === "retire") return ok({ name: "retired", holders: 0 });
      if (event.type === "closeTimer") return reject(state, REJECT.stale);
      if (event.type === "close" || event.type === "evict") return reject(state, REJECT.closed);
      return reject(state, REJECT.unheld);
    case "waiting":
      if (event.type === "hold") return ok({ ...state, holders: state.holders + 1 });
      if (event.type === "release")
        return state.holders > 1
          ? ok({ ...state, holders: state.holders - 1 })
          : ok({ name: "closed" });
      if (event.type === "admit")
        return ok({ name: "held", holders: state.holders }, "open", "demand");
      if (event.type === "retire") return ok({ name: "retired", holders: state.holders });
      if (event.type === "evict") return reject(state, REJECT.slotless);
      if (event.type === "close") return reject(state, REJECT.closed);
      return reject(state, REJECT.stale);
    case "held":
      if (event.type === "hold") return ok({ name: "held", holders: state.holders + 1 });
      if (event.type === "release")
        return state.holders > 1
          ? ok({ name: "held", holders: state.holders - 1 })
          : ok({ name: "closing" }, "undemand", "arm");
      if (event.type === "evict")
        return ok({ name: "waiting", holders: state.holders, rank: "missing" }, "undemand", "shut");
      if (event.type === "close") return ok(state, "closeReplica");
      if (event.type === "retire")
        return ok({ name: "retired", holders: state.holders }, "undemand", "retireReplica");
      if (event.type === "admit") return reject(state, REJECT.slotted);
      return reject(state, REJECT.stale);
    case "closing":
      if (event.type === "hold") return ok({ name: "held", holders: 1 }, "disarm", "demand");
      if (event.type === "closeTimer") return ok({ name: "closed" }, "shut");
      if (event.type === "close" || event.type === "evict")
        return ok({ name: "closed" }, "disarm", "shut");
      if (event.type === "retire")
        return ok({ name: "retired", holders: 0 }, "disarm", "retireReplica");
      if (event.type === "admit") return reject(state, REJECT.slotted);
      return reject(state, REJECT.unheld);
    case "retired":
      if (event.type === "hold") return ok({ name: "retired", holders: state.holders + 1 });
      if (event.type === "release")
        return state.holders > 0
          ? ok({ name: "retired", holders: state.holders - 1 })
          : reject(state, REJECT.unheld);
      return reject(state, REJECT.retired);
  }
  throw new Error(`unknown state ${state.name}`);
}

export const viewHoldMachine = defineMachine({
  ...viewHoldSpec,
  initial: { name: "closed" },
  transition,
});

/** Whether a view in `state` has one of the Page's slots. */
export const slotted = (state) => state.name === "held" || state.name === "closing";

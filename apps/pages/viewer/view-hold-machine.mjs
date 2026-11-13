/**
 * Who holds one view replica, as a state machine. view-replicas.mjs runs one
 * per view id; host-doc-open-machine.mjs runs the replica itself.
 *
 * States:
 * - closed: no replica. Nothing holds the view.
 * - held: `holders` embeds (or the view's address) hold it; the replica is
 *   open.
 * - closing: the last holder let go; the close timer is armed, so a holder
 *   that comes back at once (an embed the editor moved) keeps the replica.
 * - retired: the Page's documents retired. `holders` still hold the view and
 *   read it as closed; nothing opens again.
 *
 * Events: `hold` and `release` (a holder came or went), `closeTimer` (the
 * close timer fired), `close` (the Page's replica closed or is being
 * replaced) and `retire`.
 *
 * Effects:
 * - open: make the replica; it looks its view up if a connection is up.
 * - arm / disarm: the close timer.
 * - shut: close the replica and drop the entry.
 * - closeReplica: close the replica and keep the entry for its holders; the
 *   next admitted connection looks the view up again.
 * - retireReplica: retire the replica, if there is one.
 */
import { defineMachine, reject } from "../shared/machine.mjs";

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
const shape =
  (head, keys, ...checks) =>
  (value) => {
    only(value, [head, ...keys]);
    for (const fn of checks) fn(value);
  };
const bare = (head) => shape(head, []);

export const viewHoldSpec = Object.freeze({
  name: "view-hold",
  states: ["closed", "held", "closing", "retired"],
  events: ["hold", "release", "closeTimer", "close", "retire"],
  cases: {
    "held/release": ["more", "last"],
    "retired/release": ["more", "none"],
  },
  validate: {
    states: {
      closed: bare("name"),
      held: shape("name", ["holders"], holders(1)),
      closing: bare("name"),
      retired: shape("name", ["holders"], holders(0)),
    },
    events: Object.fromEntries(
      ["hold", "release", "closeTimer", "close", "retire"].map((type) => [type, bare("type")]),
    ),
    effects: Object.fromEntries(
      ["open", "arm", "disarm", "shut", "closeReplica", "retireReplica"].map((type) => [
        type,
        bare("type"),
      ]),
    ),
  },
});

export const REJECT = Object.freeze({
  unheld: "Nothing holds this view",
  stale: "No close timer is armed",
  closed: "No replica is open",
  retired: "The view was retired",
});

const ok = (state, ...effects) => ({ state, effects: effects.map((type) => ({ type })) });

function transition(state, event) {
  switch (state.name) {
    case "closed":
      if (event.type === "hold") return ok({ name: "held", holders: 1 }, "open");
      if (event.type === "retire") return ok({ name: "retired", holders: 0 });
      if (event.type === "closeTimer") return reject(state, REJECT.stale);
      if (event.type === "close") return reject(state, REJECT.closed);
      return reject(state, REJECT.unheld);
    case "held":
      if (event.type === "hold") return ok({ name: "held", holders: state.holders + 1 });
      if (event.type === "release")
        return state.holders > 1
          ? ok({ name: "held", holders: state.holders - 1 })
          : ok({ name: "closing" }, "arm");
      if (event.type === "close") return ok(state, "closeReplica");
      if (event.type === "retire")
        return ok({ name: "retired", holders: state.holders }, "retireReplica");
      return reject(state, REJECT.stale);
    case "closing":
      if (event.type === "hold") return ok({ name: "held", holders: 1 }, "disarm");
      if (event.type === "closeTimer" || event.type === "close")
        return ok({ name: "closed" }, ...(event.type === "close" ? ["disarm"] : []), "shut");
      if (event.type === "retire")
        return ok({ name: "retired", holders: 0 }, "disarm", "retireReplica");
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

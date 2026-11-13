/**
 * A paste or drop that holds a table from another Page, as a state machine.
 *
 * A dataframe names a Parquet asset on its own Page. Pasted into another
 * Page, it needs that Page's own copy of the bytes, so the paste waits while
 * the host copies them (POST to the asset's URL on this Page, naming the
 * source). Then the paste lands with the table's src on this Page. If a copy
 * fails, the paste lands anyway, with that table as its title in text, and
 * the Page says why. One paste is held at a time.
 *
 * A copy record (copy-registry.mjs) shows that this browser copied the
 * table, not that the person means to move its data into this Page: the
 * clipboard can carry a copy id out of the browser and back. So the Page
 * asks before anything is copied.
 *
 * States:
 * - idle: nothing held and nothing to report.
 * - confirming: `token`'s paste is held while the Page asks whether to bring
 *   its tables' data. No copy has been requested.
 * - copying: `token`'s tables are being copied. The Page says so, and the
 *   paste hasn't landed yet.
 * - failed: the last paste landed without some of its tables' data, or
 *   didn't land. `message` says why until the next paste or Dismiss.
 *
 * Events:
 * - start: a paste holding tables this browser copied from another Page is
 *   held as `token`.
 * - confirm: the person chose to bring the data.
 * - decline: the person chose titles only; the paste lands now.
 * - copied: every table of `token` copied.
 * - failed: `token`'s copies settled and at least one failed, or some of
 *   its tables were never copied; `message` says why. Any other token
 *   belongs to a paste that was cancelled, so its result is ignored.
 * - problem: a paste couldn't land, or landed without its tables' data
 *   before anything was held.
 * - cancel: Cancel while held (the paste is dropped), Dismiss on a failure,
 *   or the editor closing.
 *
 * Effects: `copy` starts `token`'s copies; `abort` drops `token`'s paste and
 * stops its copies; `insert` lands `token`'s paste with each copied table on
 * this Page and every other as its title.
 */
import { defineMachine, reject } from "../shared/machine.mjs";

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const only = (value, keys) => {
  for (const key of Object.keys(value)) check(keys.includes(key), `unexpected field ${key}`);
};
const token = (value) =>
  check(Number.isSafeInteger(value.token) && value.token > 0, "token must be a positive integer");
const message = (value) =>
  check(typeof value.message === "string" && value.message !== "", "message is required");
const shape =
  (head, keys, ...checks) =>
  (value) => {
    only(value, [head, ...keys]);
    for (const fn of checks) fn(value);
  };

export const dataframeCopySpec = Object.freeze({
  name: "dataframe-copy",
  states: ["idle", "confirming", "copying", "failed"],
  events: ["start", "confirm", "decline", "copied", "failed", "problem", "cancel"],
  cases: {
    "copying/copied": ["current", "stale"],
    "copying/failed": ["current", "stale"],
  },
  validate: {
    states: {
      idle: shape("name", []),
      confirming: shape("name", ["token"], token),
      copying: shape("name", ["token"], token),
      failed: shape("name", ["message"], message),
    },
    events: {
      start: shape("type", ["token"], token),
      confirm: shape("type", []),
      decline: shape("type", []),
      copied: shape("type", ["token"], token),
      failed: shape("type", ["token", "message"], token, message),
      problem: shape("type", ["message"], message),
      cancel: shape("type", []),
    },
    effects: {
      copy: shape("type", ["token"], token),
      abort: shape("type", ["token"], token),
      insert: shape("type", ["token"], token),
    },
  },
});

export const REJECT = Object.freeze({
  busy: "A paste is already held",
  stale: "The copy was cancelled",
  idle: "Nothing to cancel",
  unasked: "Nothing is waiting for an answer",
});

const ok = (state, effects = []) => ({ state, effects });
const held = (state) => state.name === "confirming" || state.name === "copying";

function transition(state, event) {
  switch (event.type) {
    case "start":
      if (held(state)) return reject(state, REJECT.busy);
      return ok({ name: "confirming", token: event.token });
    case "confirm":
      if (state.name !== "confirming") return reject(state, REJECT.unasked);
      return ok({ name: "copying", token: state.token }, [{ type: "copy", token: state.token }]);
    case "decline":
      if (state.name !== "confirming") return reject(state, REJECT.unasked);
      // The paste lands now, every table from another Page as its title.
      return ok({ name: "idle" }, [{ type: "insert", token: state.token }]);
    case "copied":
      if (state.name !== "copying" || state.token !== event.token)
        return reject(state, REJECT.stale);
      return ok({ name: "idle" }, [{ type: "insert", token: event.token }]);
    case "failed":
      if (state.name !== "copying" || state.token !== event.token)
        return reject(state, REJECT.stale);
      // The paste still lands, with the tables that didn't copy as titles.
      return ok({ name: "failed", message: event.message }, [
        { type: "insert", token: event.token },
      ]);
    case "problem":
      if (held(state)) return reject(state, REJECT.busy);
      return ok({ name: "failed", message: event.message });
    case "cancel":
      if (state.name === "idle") return reject(state, REJECT.idle);
      return ok({ name: "idle" }, held(state) ? [{ type: "abort", token: state.token }] : []);
  }
  throw new Error(`unknown event ${event.type}`);
}

export const dataframeCopyMachine = defineMachine({
  ...dataframeCopySpec,
  initial: { name: "idle" },
  transition,
});

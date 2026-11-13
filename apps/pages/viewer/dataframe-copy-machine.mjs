/**
 * A paste or drop that holds a table from another Page, as a state machine.
 *
 * A dataframe names a Parquet asset on its own Page. Pasted into another
 * Page, it needs that Page's own copy of the bytes, so the paste waits while
 * the host copies them (POST to the asset's URL on this Page, naming the
 * source). Then the paste lands with the table's src on this Page. If a copy
 * fails, the paste lands anyway, with that table as its title in text, and
 * the Page says why. One paste copies at a time.
 *
 * States:
 * - idle: nothing copying and nothing to report.
 * - copying: `token`'s tables are being copied. The Page says so, and the
 *   paste hasn't landed yet.
 * - failed: the last paste landed without some of its tables' data, or
 *   didn't land. `message` says why until the next paste or Dismiss.
 *
 * Events:
 * - start: a paste holding tables from another Page starts copying as
 *   `token`.
 * - copied: every table of `token` copied.
 * - failed: `token`'s copies settled and at least one failed; `message` says
 *   why. Any other token belongs to a paste that was cancelled, so its
 *   result is ignored.
 * - problem: the paste couldn't land: its insertion point was gone, or the
 *   editor refused the write.
 * - cancel: Cancel while copying (the paste is dropped), Dismiss on a
 *   failure, or the editor closing.
 *
 * Effects: `copy` starts `token`'s copies; `abort` stops them; `insert`
 * lands `token`'s paste with each copied table on this Page and every other
 * as its title.
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
  states: ["idle", "copying", "failed"],
  events: ["start", "copied", "failed", "problem", "cancel"],
  cases: {
    "copying/copied": ["current", "stale"],
    "copying/failed": ["current", "stale"],
  },
  validate: {
    states: {
      idle: shape("name", []),
      copying: shape("name", ["token"], token),
      failed: shape("name", ["message"], message),
    },
    events: {
      start: shape("type", ["token"], token),
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
  busy: "A table is already being copied",
  stale: "The copy was cancelled",
  idle: "Nothing to cancel",
});

const ok = (state, effects = []) => ({ state, effects });

function transition(state, event) {
  switch (event.type) {
    case "start":
      if (state.name === "copying") return reject(state, REJECT.busy);
      return ok({ name: "copying", token: event.token }, [{ type: "copy", token: event.token }]);
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
      if (state.name === "copying") return reject(state, REJECT.busy);
      return ok({ name: "failed", message: event.message });
    case "cancel":
      if (state.name === "idle") return reject(state, REJECT.idle);
      return ok(
        { name: "idle" },
        state.name === "copying" ? [{ type: "abort", token: state.token }] : [],
      );
  }
  throw new Error(`unknown event ${event.type}`);
}

export const dataframeCopyMachine = defineMachine({
  ...dataframeCopySpec,
  initial: { name: "idle" },
  transition,
});

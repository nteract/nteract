/**
 * One view embed's drawing, as a state machine: what is on screen, and which
 * load is the current one. view-draw.mjs runs it for each embed.
 *
 * Its inputs are plans. A plan is everything one drawing reads: the view at
 * one revision and, for each data name, the source version it resolved to
 * (or none). The interpreter names each plan by a `key`, and keeps the plan
 * itself; this machine compares keys only. A new key is a new drawing.
 *
 * States (each carries `generation`, the number of the newest load started):
 * - waiting: nothing to draw yet; the view document, or the sources document
 *   it reads, is still being found.
 * - unreachable: nothing to draw yet; the view reads a source this tab
 *   hasn't stored, and the Page is offline. It draws once a connection
 *   brings the sources document.
 * - blocked: nothing to draw, and one sentence says why: the view isn't on
 *   this Page, can't be read, or its spec was refused.
 * - loading: the tables for plan `key` are loading as load `generation`.
 *   Whatever was drawn before stays on screen until they arrive.
 * - drawn: plan `key` is drawn.
 * - failed: plan `key` couldn't be shown, for `cause`: its tables didn't
 *   load (`load`) or the chart threw while mounting (`draw`). A sentence
 *   says so.
 * - destroyed: the embed is gone. Nothing runs again.
 *
 * Events:
 * - pending: the view document, or a source it reads, isn't known yet.
 * - unreachable: the view reads a source this tab hasn't stored, and the
 *   Page is offline.
 * - blocked: there is nothing to draw, for `sentence`.
 * - plan: draw plan `key`.
 * - loaded / loadFailed: load `generation` finished or failed. A load that
 *   isn't the current one was cancelled; its answer is ignored.
 * - drawFailed: drawing load `generation` threw.
 * - destroy: the embed was removed.
 *
 * Effects:
 * - load: load plan `key`'s tables as load `generation`.
 * - cancel: abort load `generation` and free what it decoded.
 * - release: forget failed load `generation`, freeing anything it holds.
 * - draw: replace the drawn chart with load `generation`'s tables, and free
 *   the tables it replaces.
 * - clear: remove the drawn chart and free its tables.
 */
import { defineMachine, reject } from "../shared/machine.mjs";

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const only = (value, keys) => {
  for (const key of Object.keys(value)) check(keys.includes(key), `unexpected field ${key}`);
};
const generation = (value) =>
  check(
    Number.isSafeInteger(value.generation) && value.generation >= 0,
    "generation must be a whole number",
  );
const positive = (value) =>
  check(
    Number.isSafeInteger(value.generation) && value.generation > 0,
    "generation must be positive",
  );
const key = (value) => check(typeof value.key === "string" && value.key !== "", "key is required");
const sentence = (value) =>
  check(typeof value.sentence === "string" && value.sentence !== "", "sentence is required");
const shape =
  (head, keys, ...checks) =>
  (value) => {
    only(value, [head, ...keys]);
    for (const fn of checks) fn(value);
  };
const settled = shape("type", ["generation"], positive);
const CAUSES = ["load", "draw"];
const cause = (value) => check(CAUSES.includes(value.cause), "cause is load or draw");

export const STATES = Object.freeze([
  "waiting",
  "unreachable",
  "blocked",
  "loading",
  "drawn",
  "failed",
  "destroyed",
]);

export const viewDrawSpec = Object.freeze({
  name: "view-draw",
  states: STATES,
  events: [
    "pending",
    "unreachable",
    "blocked",
    "plan",
    "loaded",
    "loadFailed",
    "drawFailed",
    "destroy",
  ],
  cases: {
    "blocked/blocked": ["same", "other"],
    "loading/plan": ["same", "other"],
    "drawn/plan": ["same", "other"],
    "failed/plan": ["same", "other"],
    "loading/loaded": ["current", "stale"],
    "loading/loadFailed": ["current", "stale"],
    "drawn/drawFailed": ["current", "stale"],
  },
  validate: {
    states: {
      waiting: shape("name", ["generation"], generation),
      unreachable: shape("name", ["generation"], generation),
      blocked: shape("name", ["generation", "sentence"], generation, sentence),
      loading: shape("name", ["generation", "key"], positive, key),
      drawn: shape("name", ["generation", "key"], positive, key),
      failed: shape("name", ["generation", "key", "cause"], positive, key, cause),
      destroyed: shape("name", ["generation"], generation),
    },
    events: {
      pending: shape("type", []),
      unreachable: shape("type", []),
      blocked: shape("type", ["sentence"], sentence),
      plan: shape("type", ["key"], key),
      loaded: settled,
      loadFailed: settled,
      drawFailed: settled,
      destroy: shape("type", []),
    },
    effects: {
      load: shape("type", ["generation", "key"], positive, key),
      cancel: shape("type", ["generation"], positive),
      release: shape("type", ["generation"], positive),
      draw: shape("type", ["generation"], positive),
      clear: shape("type", []),
    },
  },
});

export const REJECT = Object.freeze({
  destroyed: "The embed was destroyed",
  same: "Already drawing that",
  stale: "That load was cancelled",
  keep: "What is drawn stays while the view is found again",
});

const ok = (state, effects = []) => ({ state, effects });

/** What leaving `state` for a state that draws nothing needs. */
function stop(state) {
  if (state.name === "loading")
    return [{ type: "cancel", generation: state.generation }, { type: "clear" }];
  if (state.name === "drawn" || state.name === "failed") return [{ type: "clear" }];
  return [];
}

function transition(state, event) {
  if (state.name === "destroyed") return reject(state, REJECT.destroyed);
  const { generation: current } = state;
  switch (event.type) {
    case "pending":
      // A view that is being found again (a reconnect) keeps what it drew.
      if (state.name !== "blocked" && state.name !== "unreachable")
        return reject(state, REJECT.keep);
      return ok({ name: "waiting", generation: current });
    case "unreachable":
      if (state.name === "unreachable") return reject(state, REJECT.same);
      // Like pending, a drawing, a load or a sentence for one stays.
      if (state.name !== "waiting" && state.name !== "blocked") return reject(state, REJECT.keep);
      return ok({ name: "unreachable", generation: current });
    case "blocked":
      if (state.name === "blocked" && state.sentence === event.sentence)
        return reject(state, REJECT.same);
      return ok({ name: "blocked", generation: current, sentence: event.sentence }, stop(state));
    case "plan": {
      if (["loading", "drawn", "failed"].includes(state.name) && state.key === event.key)
        return reject(state, REJECT.same);
      const next = current + 1;
      return ok({ name: "loading", generation: next, key: event.key }, [
        ...(state.name === "loading" ? [{ type: "cancel", generation: current }] : []),
        { type: "load", generation: next, key: event.key },
      ]);
    }
    case "loaded":
      if (state.name !== "loading" || event.generation !== current)
        return reject(state, REJECT.stale);
      return ok({ name: "drawn", generation: current, key: state.key }, [
        { type: "draw", generation: current },
      ]);
    case "loadFailed":
      if (state.name !== "loading" || event.generation !== current)
        return reject(state, REJECT.stale);
      return ok({ name: "failed", generation: current, key: state.key, cause: "load" }, [
        { type: "release", generation: current },
        { type: "clear" },
      ]);
    case "drawFailed":
      if (state.name !== "drawn" || event.generation !== current)
        return reject(state, REJECT.stale);
      return ok({ name: "failed", generation: current, key: state.key, cause: "draw" }, [
        { type: "clear" },
      ]);
    case "destroy":
      return ok({ name: "destroyed", generation: current }, stop(state));
  }
  throw new Error(`unknown event ${event.type}`);
}

export const viewDrawMachine = defineMachine({
  ...viewDrawSpec,
  initial: { name: "waiting", generation: 0 },
  transition,
});

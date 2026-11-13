// The view-draw table over every state and event, run through the pure
// machine. Its interpreter is covered in view-draw.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { runTable } from "../shared/machine-test.mjs";
import { REJECT, viewDrawMachine } from "./view-draw-machine.mjs";

const waiting = (generation = 2) => ({ name: "waiting", generation });
const unreachable = (generation = 2) => ({ name: "unreachable", generation });
const blocked = (sentence = "No.", generation = 2) => ({ name: "blocked", generation, sentence });
const loading = (key = "k1", generation = 2) => ({ name: "loading", generation, key });
const drawn = (key = "k1", generation = 2) => ({ name: "drawn", generation, key });
const failed = (key = "k1", generation = 2, cause = "load") => ({
  name: "failed",
  generation,
  key,
  cause,
});
const destroyed = (generation = 2) => ({ name: "destroyed", generation });

const pending = { type: "pending" };
const offline = { type: "unreachable" };
const block = (sentence = "No.") => ({ type: "blocked", sentence });
const plan = (key = "k1") => ({ type: "plan", key });
const loaded = (generation = 2) => ({ type: "loaded", generation });
const loadFailed = (generation = 2) => ({ type: "loadFailed", generation });
const drawFailed = (generation = 2) => ({ type: "drawFailed", generation });
const destroy = { type: "destroy" };

const load = (key, generation = 3) => ({ type: "load", generation, key });
const cancel = (generation = 2) => ({ type: "cancel", generation });
const release = (generation = 2) => ({ type: "release", generation });
const draw = (generation = 2) => ({ type: "draw", generation });
const clear = { type: "clear" };

const go = (state, effects = []) => ({ state, effects });
const no = (state, rejected) => ({ state, effects: [], rejected });
const row = (label, state, event, expect, kase) => ({
  label,
  state,
  event,
  expect,
  ...(kase && { case: kase }),
});

/** A state with no current load: every load answer is a cancelled one. */
const lateLoads = (state, { drawn = false } = {}) => [
  row(`${state.name}: a cancelled load finishes`, state, loaded(), no(state, REJECT.stale)),
  row(`${state.name}: a cancelled load fails`, state, loadFailed(), no(state, REJECT.stale)),
  ...(drawn
    ? []
    : [row(`${state.name}: no chart is drawing`, state, drawFailed(), no(state, REJECT.stale))]),
];

const ROWS = [
  // Nothing found yet.
  row("waiting: still pending", waiting(), pending, no(waiting(), REJECT.keep)),
  row(
    "waiting: its source isn't stored and the Page is offline",
    waiting(),
    offline,
    go(unreachable()),
  ),
  row("waiting: the view isn't on this Page", waiting(), block(), go(blocked())),
  row("waiting: the first plan loads", waiting(), plan(), go(loading("k1", 3), [load("k1")])),
  ...lateLoads(waiting()),
  row("waiting: destroy", waiting(), destroy, go(destroyed())),

  // Waiting for a connection to bring the sources document.
  row(
    "unreachable: the connection is back, the lookup runs",
    unreachable(),
    pending,
    go(waiting()),
  ),
  row("unreachable: still offline", unreachable(), offline, no(unreachable(), REJECT.same)),
  row("unreachable: the view goes away", unreachable(), block(), go(blocked())),
  row(
    "unreachable: the sources document opens and the plan loads",
    unreachable(),
    plan(),
    go(loading("k1", 3), [load("k1")]),
  ),
  ...lateLoads(unreachable()),
  row("unreachable: destroy", unreachable(), destroy, go(destroyed())),

  // Nothing to draw, with a sentence.
  row("blocked: the view is being found again", blocked(), pending, go(waiting())),
  row(
    "blocked: the view returns reading a source this offline tab hasn't stored",
    blocked(),
    offline,
    go(unreachable()),
  ),
  row("blocked: the same sentence", blocked(), block(), no(blocked(), REJECT.same), "same"),
  row("blocked: another sentence", blocked(), block("Other."), go(blocked("Other.")), "other"),
  row("blocked: the view arrives", blocked(), plan(), go(loading("k1", 3), [load("k1")])),
  ...lateLoads(blocked()),
  row("blocked: destroy", blocked(), destroy, go(destroyed())),

  // Tables are loading.
  row(
    "loading: a reconnect keeps the load running",
    loading(),
    pending,
    no(loading(), REJECT.keep),
  ),
  row("loading: offline, the load keeps running", loading(), offline, no(loading(), REJECT.keep)),
  row("loading: the view goes away mid-load", loading(), block(), go(blocked(), [cancel(), clear])),
  row("loading: the same plan again", loading(), plan(), no(loading(), REJECT.same), "same"),
  row(
    "loading: a rewritten view or source replaces the load",
    loading(),
    plan("k2"),
    go(loading("k2", 3), [cancel(), load("k2")]),
    "other",
  ),
  row("loading: the load finishes", loading(), loaded(), go(drawn(), [draw()]), "current"),
  row(
    "loading: a cancelled load finishes late",
    loading(),
    loaded(1),
    no(loading(), REJECT.stale),
    "stale",
  ),
  row(
    "loading: the load fails and is released",
    loading(),
    loadFailed(),
    go(failed(), [release(), clear]),
    "current",
  ),
  row(
    "loading: a cancelled load fails late",
    loading(),
    loadFailed(1),
    no(loading(), REJECT.stale),
    "stale",
  ),
  row(
    "loading: an earlier chart's failure while a new load runs",
    loading(),
    drawFailed(1),
    no(loading(), REJECT.stale),
  ),
  row("loading: destroy cancels the load", loading(), destroy, go(destroyed(), [cancel(), clear])),

  // A chart is drawn.
  row("drawn: a reconnect keeps the chart", drawn(), pending, no(drawn(), REJECT.keep)),
  row("drawn: offline, the chart stays", drawn(), offline, no(drawn(), REJECT.keep)),
  row("drawn: the view goes away", drawn(), block(), go(blocked(), [clear])),
  row("drawn: the same plan again", drawn(), plan(), no(drawn(), REJECT.same), "same"),
  row(
    "drawn: a new plan loads while the chart stays",
    drawn(),
    plan("k2"),
    go(loading("k2", 3), [load("k2")]),
    "other",
  ),
  ...lateLoads(drawn(), { drawn: true }),
  row(
    "drawn: the chart threw while mounting",
    drawn(),
    drawFailed(),
    go(failed("k1", 2, "draw"), [clear]),
    "current",
  ),
  row(
    "drawn: an earlier chart's failure",
    drawn(),
    drawFailed(1),
    no(drawn(), REJECT.stale),
    "stale",
  ),
  row("drawn: destroy", drawn(), destroy, go(destroyed(), [clear])),

  // The tables failed to load.
  row("failed: a reconnect keeps the sentence", failed(), pending, no(failed(), REJECT.keep)),
  row("failed: offline, the sentence stays", failed(), offline, no(failed(), REJECT.keep)),
  row("failed: the view goes away", failed(), block(), go(blocked(), [clear])),
  row("failed: the same plan again", failed(), plan(), no(failed(), REJECT.same), "same"),
  row(
    "failed: a new plan tries again",
    failed(),
    plan("k2"),
    go(loading("k2", 3), [load("k2")]),
    "other",
  ),
  ...lateLoads(failed()),
  row("failed: destroy", failed(), destroy, go(destroyed(), [clear])),

  // Gone.
  ...[pending, offline, block(), plan(), loaded(), loadFailed(), drawFailed(), destroy].map(
    (event) =>
      row(
        `destroyed: ${event.type} does nothing`,
        destroyed(),
        event,
        no(destroyed(), REJECT.destroyed),
      ),
  ),
];

test("the view-draw table covers every state and event", async () => {
  const result = await runTable(viewDrawMachine, ROWS);
  assert.equal(result.pairs, 56);
  assert.equal(result.unreachable, 0);
});

test("generations rise, so an answer from a replaced load is always stale", () => {
  let { state } = viewDrawMachine.step(viewDrawMachine.initial, plan("a"));
  const first = state.generation;
  ({ state } = viewDrawMachine.step(state, plan("b")));
  ({ state } = viewDrawMachine.step(state, block("Gone.")));
  ({ state } = viewDrawMachine.step(state, plan("c")));
  assert.equal(state.generation, first + 2);
  assert.equal(viewDrawMachine.step(state, loaded(first)).rejected, REJECT.stale);
});

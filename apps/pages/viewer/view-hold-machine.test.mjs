// The view-hold table over every state and event. Its interpreter is
// view-replicas.mjs (view-replicas.test.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { runTable } from "../shared/machine-test.mjs";
import { REJECT, viewHoldMachine } from "./view-hold-machine.mjs";

const closed = { name: "closed" };
const held = (holders) => ({ name: "held", holders });
const closing = { name: "closing" };
const retired = (holders) => ({ name: "retired", holders });
const event = (type) => ({ type });
const effects = (...types) => types.map((type) => ({ type }));
const go = (state, ...types) => ({ state, effects: effects(...types) });
const no = (state, rejected) => ({ state, effects: [], rejected });
const row = (label, state, type, expect, kase) => ({
  label,
  state,
  event: event(type),
  expect,
  ...(kase && { case: kase }),
});

const ROWS = [
  row("closed: the first holder opens the replica", closed, "hold", go(held(1), "open")),
  row("closed: a release of nothing", closed, "release", no(closed, REJECT.unheld)),
  row("closed: a late close timer", closed, "closeTimer", no(closed, REJECT.stale)),
  row("closed: the Page's replica closes", closed, "close", no(closed, REJECT.closed)),
  row("closed: a view first named after retirement", closed, "retire", go(retired(0))),

  row("held: another holder", held(1), "hold", go(held(2))),
  row("held: one of two lets go", held(2), "release", go(held(1)), "more"),
  row("held: the last lets go and the timer arms", held(1), "release", go(closing, "arm"), "last"),
  row("held: no timer is armed", held(1), "closeTimer", no(held(1), REJECT.stale)),
  row(
    "held: the Page's replica closes; holders keep the entry",
    held(2),
    "close",
    go(held(2), "closeReplica"),
  ),
  row("held: retire", held(2), "retire", go(retired(2), "retireReplica")),

  row("closing: a holder comes back in time", closing, "hold", go(held(1), "disarm")),
  row("closing: nothing holds it to release", closing, "release", no(closing, REJECT.unheld)),
  row("closing: the timer fires", closing, "closeTimer", go(closed, "shut")),
  row("closing: the Page's replica closes first", closing, "close", go(closed, "disarm", "shut")),
  row("closing: retire", closing, "retire", go(retired(0), "disarm", "retireReplica")),

  row("retired: a holder reads it as closed", retired(1), "hold", go(retired(2))),
  row("retired: a holder lets go", retired(2), "release", go(retired(1)), "more"),
  row("retired: nothing to release", retired(0), "release", no(retired(0), REJECT.unheld), "none"),
  row("retired: a late timer", retired(1), "closeTimer", no(retired(1), REJECT.retired)),
  row("retired: close", retired(1), "close", no(retired(1), REJECT.retired)),
  row("retired: retire again", retired(1), "retire", no(retired(1), REJECT.retired)),
];

test("the view-hold table covers every state and event", async () => {
  const result = await runTable(viewHoldMachine, ROWS);
  assert.equal(result.pairs, 20);
  assert.equal(result.unreachable, 0);
});

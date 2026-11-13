// The view-hold table over every state and event. Its interpreter is
// view-replicas.mjs (view-replicas.test.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { runTable } from "../shared/machine-test.mjs";
import { REJECT, viewHoldMachine } from "./view-hold-machine.mjs";

const closed = { name: "closed" };
const waiting = (holders, rank = "fresh") => ({ name: "waiting", holders, rank });
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
  row("closed: the first holder waits for a slot", closed, "hold", go(waiting(1))),
  row("closed: a release of nothing", closed, "release", no(closed, REJECT.unheld)),
  row("closed: nothing holds it to admit", closed, "admit", no(closed, REJECT.unheld)),
  row("closed: nothing to evict", closed, "evict", no(closed, REJECT.closed)),
  row("closed: a late close timer", closed, "closeTimer", no(closed, REJECT.stale)),
  row("closed: the Page's replica closes", closed, "close", no(closed, REJECT.closed)),
  row("closed: a view first named after retirement", closed, "retire", go(retired(0))),

  row(
    "waiting: another holder waits with it",
    waiting(1, "missing"),
    "hold",
    go(waiting(2, "missing")),
  ),
  row("waiting: one of two lets go", waiting(2), "release", go(waiting(1)), "more"),
  row("waiting: the last lets go and it stops waiting", waiting(1), "release", go(closed), "last"),
  row(
    "waiting: a slot frees; the replica opens and asks",
    waiting(2, "missing"),
    "admit",
    go(held(2), "open", "demand"),
  ),
  row("waiting: no slot to give up", waiting(1), "evict", no(waiting(1), REJECT.slotless)),
  row("waiting: no timer is armed", waiting(1), "closeTimer", no(waiting(1), REJECT.stale)),
  row("waiting: no replica to close", waiting(1), "close", no(waiting(1), REJECT.closed)),
  row("waiting: retire", waiting(2), "retire", go(retired(2))),

  row("held: another holder", held(1), "hold", go(held(2))),
  row("held: one of two lets go", held(2), "release", go(held(1)), "more"),
  row(
    "held: the last lets go; it stops asking and the timer arms",
    held(1),
    "release",
    go(closing, "undemand", "arm"),
    "last",
  ),
  row("held: already has a slot", held(1), "admit", no(held(1), REJECT.slotted)),
  row(
    "held: its document is missing and a fresh view takes the slot",
    held(2),
    "evict",
    go(waiting(2, "missing"), "undemand", "shut"),
  ),
  row("held: no timer is armed", held(1), "closeTimer", no(held(1), REJECT.stale)),
  row(
    "held: the Page's replica closes; holders keep the slot",
    held(2),
    "close",
    go(held(2), "closeReplica"),
  ),
  row("held: retire", held(2), "retire", go(retired(2), "undemand", "retireReplica")),

  row("closing: a holder comes back in time", closing, "hold", go(held(1), "disarm", "demand")),
  row("closing: nothing holds it to release", closing, "release", no(closing, REJECT.unheld)),
  row("closing: still has its slot", closing, "admit", no(closing, REJECT.slotted)),
  row("closing: a waiting view reclaims the slot", closing, "evict", go(closed, "disarm", "shut")),
  row("closing: the timer fires", closing, "closeTimer", go(closed, "shut")),
  row("closing: the Page's replica closes first", closing, "close", go(closed, "disarm", "shut")),
  row("closing: retire", closing, "retire", go(retired(0), "disarm", "retireReplica")),

  row("retired: a holder reads it as closed", retired(1), "hold", go(retired(2))),
  row("retired: a holder lets go", retired(2), "release", go(retired(1)), "more"),
  row("retired: nothing to release", retired(0), "release", no(retired(0), REJECT.unheld), "none"),
  row("retired: nothing is admitted", retired(1), "admit", no(retired(1), REJECT.retired)),
  row("retired: nothing to evict", retired(1), "evict", no(retired(1), REJECT.retired)),
  row("retired: a late timer", retired(1), "closeTimer", no(retired(1), REJECT.retired)),
  row("retired: close", retired(1), "close", no(retired(1), REJECT.retired)),
  row("retired: retire again", retired(1), "retire", no(retired(1), REJECT.retired)),
];

test("the view-hold table covers every state and event", async () => {
  const result = await runTable(viewHoldMachine, ROWS);
  assert.equal(result.pairs, 35);
  assert.equal(result.unreachable, 0);
});

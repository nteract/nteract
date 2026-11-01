// The viewer-reconnect table, run through the pure machine, and the backoff
// arithmetic the interpreter applies to its `schedule` effect. PageSession's
// use of it is covered in receipt-reconnect.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { loadTable, runTable } from "../shared/machine-test.mjs";
import {
  MAX_STEP_MS,
  OUTAGE_ATTEMPTS,
  REFUSAL_LIMIT,
  backoffStep,
  reconnectDelay,
  viewerReconnectMachine,
} from "./reconnect-machine.mjs";

const TABLE = new URL("../test/fixtures/machines/viewer-reconnect.json", import.meta.url);

test("the viewer-reconnect table runs through the pure machine", async () => {
  assert.deepEqual(await runTable(viewerReconnectMachine, loadTable(TABLE)), {
    rows: 62,
    pairs: 50,
    unreachable: 0,
    cases: 10,
  });
});

test("backoff steps double from half a second to a 60 s cap", () => {
  const steps = Array.from({ length: 10 }, (_, attempts) => backoffStep(attempts));
  assert.deepEqual(steps, [500, 1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000]);
  assert.equal(backoffStep(10_000), MAX_STEP_MS, "a long outage never overflows the cap");
});

test("equal jitter keeps every delay within [step / 2, step]", () => {
  for (let attempts = 0; attempts < 12; attempts++) {
    const step = backoffStep(attempts);
    assert.equal(reconnectDelay(step, 0), step / 2);
    assert.equal(reconnectDelay(step, 0.5), (step * 3) / 4);
    assert.equal(reconnectDelay(step, 0.999_999), step);
    for (let i = 0; i < 50; i++) {
      const delay = reconnectDelay(step, Math.random());
      assert.ok(delay >= step / 2 && delay <= step, `${delay} is outside [${step / 2}, ${step}]`);
    }
  }
  assert.equal(reconnectDelay(backoffStep(0), 0), 250, "the first retry stays quick");
});

test("transient failures back off forever while refusals pause at the limit", () => {
  let state = viewerReconnectMachine.initial;
  const steps = [];
  const outages = [];
  for (let i = 0; i < 12; i++) {
    const result = viewerReconnectMachine.step(state, { type: "failed", refused: false });
    steps.push(result.effects[0].step);
    outages.push(result.effects.some((effect) => effect.type === "reportOutage"));
    state = viewerReconnectMachine.step(result.state, { type: "timer" }).state;
  }
  // Retries continue past the outage report, which repeats on every failure.
  assert.deepEqual(
    outages,
    Array.from({ length: 12 }, (_, i) => i + 1 >= OUTAGE_ATTEMPTS),
  );
  assert.ok(
    steps.slice(0, OUTAGE_ATTEMPTS - 1).reduce((sum, step) => sum + step / 2, 0) >= 15_000,
    "a restart shorter than 15 s never reports an outage",
  );
  assert.equal(state.name, "ready");
  assert.deepEqual(steps.slice(-5), Array(5).fill(MAX_STEP_MS));
  assert.equal(state.refusals, 0);

  state = viewerReconnectMachine.initial;
  for (let refusal = 1; refusal < REFUSAL_LIMIT; refusal++) {
    const result = viewerReconnectMachine.step(state, { type: "failed", refused: true });
    assert.equal(result.state.name, "waiting");
    assert.equal(result.state.refusals, refusal);
    state = viewerReconnectMachine.step(result.state, { type: "timer" }).state;
  }
  const last = viewerReconnectMachine.step(state, { type: "failed", refused: true });
  assert.equal(last.state.name, "paused");
  assert.deepEqual(last.effects, [{ type: "pauseSync" }]);
  assert.deepEqual(viewerReconnectMachine.step(last.state, { type: "resume" }).state, {
    name: "ready",
    attempts: 0,
    refusals: 0,
  });
});

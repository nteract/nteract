import assert from "node:assert/strict";
import { test } from "node:test";
import { COMPACTION_READY, MAX_COMPACTION_SKIP, compactionStep } from "./compaction-machine.mjs";

const compacting = (failures) => ({ phase: "compacting", failures });
const backoff = (failures, skip) => ({ phase: "backoff", failures, skip });

test("compactionStep covers every state and event", () => {
  const cases = [
    [COMPACTION_READY, "due", compacting(0), "compact"],
    [COMPACTION_READY, "succeeded", TypeError],
    [COMPACTION_READY, "failed", TypeError],
    [compacting(0), "due", compacting(0), null],
    [compacting(0), "succeeded", COMPACTION_READY, null],
    [compacting(0), "failed", backoff(1, 1), "report"],
    [compacting(1), "failed", backoff(2, 2), "report"],
    [compacting(3), "succeeded", COMPACTION_READY, null],
    [backoff(2, 2), "due", backoff(2, 1), null],
    [backoff(2, 0), "due", compacting(2), "compact"],
    [backoff(2, 1), "succeeded", TypeError],
    [backoff(2, 1), "failed", TypeError],
  ];
  for (const [state, type, next, effect] of cases) {
    const label = `${state.phase}(${state.failures}) + ${type}`;
    if (next === TypeError) assert.throws(() => compactionStep(state, { type }), TypeError, label);
    else assert.deepEqual(compactionStep(state, { type }), { state: next, effect }, label);
  }
});

test("the skip doubles per failure up to the cap", () => {
  const skips = [];
  let state = COMPACTION_READY;
  for (let i = 0; i < 12; i++) {
    state = compactionStep(compacting(state.failures), { type: "failed" }).state;
    skips.push(state.skip);
  }
  assert.deepEqual(skips, [1, 2, 4, 8, 16, 32, 64, 128, 256, 256, 256, 256]);
  assert.equal(MAX_COMPACTION_SKIP, 256);
});

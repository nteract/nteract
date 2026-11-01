// The comments-open table, run through the pure machine. PageSession's use of
// it (timeouts, late completion, reconnects, replica replacement) is covered
// in comments-open.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { loadTable, runTable } from "../shared/machine-test.mjs";
import { OPEN_ATTEMPTS, commentsOpenMachine, retryDelay } from "./comments-open-machine.mjs";

const TABLE = new URL("../test/fixtures/machines/comments-open.json", import.meta.url);

test("the comments-open table runs through the pure machine", async () => {
  assert.deepEqual(await runTable(commentsOpenMachine, loadTable(TABLE)), {
    rows: 43,
    pairs: 35,
    unreachable: 0,
    cases: 10,
  });
});

test("retries back off 1, 2, 4, 8 s, then stop at the attempt limit", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(retryDelay), [1000, 2000, 4000, 8000, 8000, 8000]);
  let state = commentsOpenMachine.initial;
  ({ state } = commentsOpenMachine.step(state, { type: "open", id: "doc" }));
  for (let attempt = 1; attempt < OPEN_ATTEMPTS; attempt++) {
    ({ state } = commentsOpenMachine.step(state, { type: "lookupFailed", attempt }));
    assert.equal(state.name, "retrying");
    ({ state } = commentsOpenMachine.step(state, { type: "timer", attempt }));
  }
  ({ state } = commentsOpenMachine.step(state, { type: "lookupFailed", attempt: OPEN_ATTEMPTS }));
  assert.deepEqual(state, { name: "failed", attempt: OPEN_ATTEMPTS, id: "doc" });
});

import test from "node:test";
import assert from "node:assert/strict";
import { runWithDeadline } from "../src/runtime-deadline.js";

test("deadline waits for host termination and normalizes invalidation rejection", async () => {
  let invalidate;
  let startTermination;
  const terminationStarted = new Promise((resolve) => {
    startTermination = resolve;
  });
  let finishTermination;
  const termination = new Promise((resolve) => {
    finishTermination = resolve;
  });
  let terminated = false;
  const result = runWithDeadline(
    () =>
      new Promise((_, reject) => {
        invalidate = reject;
      }),
    {
      timeoutMs: 5,
      message: "deadline",
      terminate: () => {
        startTermination();
        invalidate(new Error("host invalidated"));
        return termination.then(() => {
          terminated = true;
        });
      },
    },
  );
  await terminationStarted;
  finishTermination();
  await assert.rejects(result, /^Error: deadline$/);
  assert.equal(terminated, true);
});

test("deadline reports failed termination rather than claiming successful cancellation", async () => {
  await assert.rejects(
    runWithDeadline(() => new Promise(() => {}), {
      timeoutMs: 5,
      message: "deadline",
      terminate: async () => {
        throw new Error("termination failed");
      },
    }),
    /termination failed/,
  );
});

test("deadline rejects a late fulfillment after termination starts", async () => {
  let resolveRun;
  let finishTermination;
  let startedTermination;
  const runStarted = new Promise((resolve) => {
    resolveRun = resolve;
  });
  const terminationStarted = new Promise((resolve) => {
    startedTermination = resolve;
  });
  const termination = new Promise((resolve) => {
    finishTermination = resolve;
  });
  let settled = false;
  const result = runWithDeadline(() => runStarted, {
    timeoutMs: 5,
    message: "deadline",
    terminate: () => {
      startedTermination();
      return termination;
    },
  }).finally(() => {
    settled = true;
  });

  await terminationStarted;
  resolveRun("late success");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "the result waits for host termination");
  finishTermination();
  await assert.rejects(result, /^Error: deadline$/);
});

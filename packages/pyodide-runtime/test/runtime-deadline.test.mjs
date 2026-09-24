import test from "node:test";
import assert from "node:assert/strict";
import { runWithDeadline } from "../src/runtime-deadline.js";

test("deadline waits for host termination and normalizes invalidation rejection", async () => {
  let invalidate;
  let terminated = false;
  await assert.rejects(
    runWithDeadline(
      () =>
        new Promise((_, reject) => {
          invalidate = reject;
        }),
      {
        timeoutMs: 5,
        message: "deadline",
        terminate: async () => {
          invalidate(new Error("host invalidated"));
          await new Promise((resolve) => setTimeout(resolve, 5));
          terminated = true;
        },
      },
    ),
    /^Error: deadline$/,
  );
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

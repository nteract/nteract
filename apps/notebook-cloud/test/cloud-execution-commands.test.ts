import assert from "node:assert/strict";
import { test } from "node:test";

import { TestScheduler } from "rxjs/testing";
import {
  CloudExecutionCommands,
  cloudExecutionCommand$,
} from "../viewer/cloud-execution-commands.ts";

for (const boundary of ["sync", "attachment"] as const) {
  test(`virtual-time cancellation unsubscribes a held ${boundary} before execution`, () => {
    new TestScheduler((actual, expected) => assert.deepEqual(actual, expected)).run(
      ({ cold, hot, expectObservable, expectSubscriptions }) => {
        const held = cold("------t|", { t: true });
        const cancellation = hot("---x");
        const result = cloudExecutionCommand$(
          {
            isCurrent: () => true,
            flush: () => (boundary === "sync" ? held : cold("(t|)", { t: true })),
            start: () => held,
            execute: () => assert.fail("cancelled preparation sent execution"),
          },
          cancellation,
        );
        expectObservable(result).toBe("---(c|)", { c: "cancelled" });
        expectSubscriptions(held.subscriptions).toBe("^--!");
      },
    );
  });
}

test("virtual-time Interrupt after submission leaves the room-owned request intact", () => {
  new TestScheduler((actual, expected) => assert.deepEqual(actual, expected)).run(
    ({ cold, hot, expectObservable, expectSubscriptions }) => {
      const submitted = cold("----(r|)", { r: undefined });
      const result = cloudExecutionCommand$(
        {
          isCurrent: () => true,
          flush: () => cold("-t|", { t: true }),
          execute: () => submitted,
        },
        hot("---x"),
      );
      expectObservable(result).toBe("-----(s|)", { s: "submitted" });
      expectSubscriptions(submitted.subscriptions).toBe("-^---!");
    },
  );
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const boundary of ["sync", "attachment"] as const) {
  test(`cancelPending drops restart-and-run while ${boundary} is pending`, async () => {
    const commands = new CloudExecutionCommands();
    const entered = deferred<void>();
    const held = deferred<boolean>();
    const events: string[] = [];
    const command = {
      isCurrent: () => true,
      flush: async () => {
        events.push("sync");
        if (boundary === "sync") {
          entered.resolve();
          return held.promise;
        }
        return true;
      },
      start: async () => {
        events.push("attach");
        entered.resolve();
        return held.promise;
      },
      execute: async () => {
        events.push("run_all");
      },
    };
    const pending = commands.submit(command);
    await entered.promise;
    commands.cancelPending();
    events.push("interrupt");
    held.resolve(true);
    assert.equal(await pending, "cancelled");
    assert.deepEqual(
      events,
      boundary === "sync" ? ["sync", "interrupt"] : ["sync", "attach", "interrupt"],
    );
    // A fresh explicit command still works; cancelled intent is not replayed.
    assert.equal(await commands.submit(command), "submitted");
    assert.equal(events.filter((event) => event === "run_all").length, 1);
  });
}

test("a replaced room connection drops a delayed execution submission", async () => {
  const commands = new CloudExecutionCommands();
  const held = deferred<boolean>();
  let current = true;
  const pending = commands.submit({
    isCurrent: () => current,
    flush: () => held.promise,
    execute: async () => assert.fail("old room received an execution"),
  });
  current = false;
  held.resolve(true);
  assert.equal(await pending, "cancelled");
});

test("a command issued on a stale connection never flushes", async () => {
  const commands = new CloudExecutionCommands();
  assert.equal(
    await commands.submit({
      isCurrent: () => false,
      flush: async () => assert.fail("stale connection flushed"),
      execute: async () => assert.fail("stale connection executed"),
    }),
    "cancelled",
  );
});

test("a failed sync never starts compute or executes", async () => {
  const commands = new CloudExecutionCommands();
  assert.equal(
    await commands.submit({
      isCurrent: () => true,
      flush: async () => false,
      start: async () => assert.fail("failed sync started compute"),
      execute: async () => assert.fail("failed sync submitted execution"),
    }),
    "sync_failed",
  );
});

test("a failed attachment never executes", async () => {
  const commands = new CloudExecutionCommands();
  assert.equal(
    await commands.submit({
      isCurrent: () => true,
      flush: async () => true,
      start: async () => false,
      execute: async () => assert.fail("failed attachment submitted execution"),
    }),
    "start_failed",
  );
});

test("cancellation reports cancelled even when the held step also failed", async () => {
  const commands = new CloudExecutionCommands();
  const held = deferred<boolean>();
  const pending = commands.submit({
    isCurrent: () => true,
    flush: async () => true,
    start: () => held.promise,
    execute: async () => assert.fail("cancelled command executed"),
  });
  await Promise.resolve();
  commands.cancelPending();
  held.resolve(false);
  assert.equal(await pending, "cancelled");
});

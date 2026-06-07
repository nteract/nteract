import assert from "node:assert/strict";
import { test } from "node:test";
import { Subject } from "rxjs";
import { subscribeSerializedCloudCellChanges } from "../viewer/serialized-cell-changes";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

async function flushMicrotasks(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

test("serialized cloud cell changes wait for prior materialization to finish", async () => {
  const cellChanges$ = new Subject<string>();
  const first = deferred();
  const second = deferred();
  const started: string[] = [];
  const completed: string[] = [];

  const subscription = subscribeSerializedCloudCellChanges({
    cellChanges$,
    materializeChangeset: async (changeset) => {
      started.push(changeset);
      await (changeset === "first" ? first.promise : second.promise);
      completed.push(changeset);
    },
  });

  cellChanges$.next("first");
  cellChanges$.next("second");
  await flushMicrotasks();

  assert.deepEqual(started, ["first"]);
  assert.deepEqual(completed, []);

  first.resolve();
  await flushMicrotasks();

  assert.deepEqual(started, ["first", "second"]);
  assert.deepEqual(completed, ["first"]);

  second.resolve();
  await flushMicrotasks();

  assert.deepEqual(completed, ["first", "second"]);

  subscription.unsubscribe();
});

test("serialized cloud cell changes keep processing after materialization errors", async () => {
  const cellChanges$ = new Subject<string>();
  const started: string[] = [];
  const errors: unknown[] = [];

  const subscription = subscribeSerializedCloudCellChanges({
    cellChanges$,
    materializeChangeset: async (changeset) => {
      started.push(changeset);
      if (changeset === "bad") {
        throw new Error("bad changeset");
      }
    },
    onMaterializationError: (error) => {
      errors.push(error);
    },
  });

  cellChanges$.next("bad");
  cellChanges$.next("next");
  await flushMicrotasks();

  assert.deepEqual(started, ["bad", "next"]);
  assert.equal(errors.length, 1);
  assert.match(errors[0] instanceof Error ? errors[0].message : String(errors[0]), /bad changeset/);

  subscription.unsubscribe();
});

test("serialized cloud cell changes suppress in-flight errors after unsubscribe", async () => {
  const cellChanges$ = new Subject<string>();
  const inFlight = deferred();
  const errors: unknown[] = [];

  const subscription = subscribeSerializedCloudCellChanges({
    cellChanges$,
    materializeChangeset: async () => {
      await inFlight.promise;
    },
    onMaterializationError: (error) => {
      errors.push(error);
    },
  });

  cellChanges$.next("slow");
  await flushMicrotasks();
  subscription.unsubscribe();

  inFlight.reject(new Error("after unsubscribe"));
  await flushMicrotasks();

  assert.deepEqual(errors, []);
});

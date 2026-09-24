import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY, Subject, VirtualTimeScheduler } from "rxjs";
import {
  CloudNotebookHomeStore,
  NotebookHomeAccessError,
  type NotebookHomeDriver,
} from "../viewer/cloud-notebook-home-store";
import type { CloudNotebookListResponse } from "../viewer/cloud-viewer-types";

const body = (principal = "alice"): CloudNotebookListResponse => ({
  ok: true,
  notebooks: [],
  current_user_principal: principal,
  current_user_display: principal,
});
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function fixture() {
  const events = new Subject<void>();
  const scheduler = new VirtualTimeScheduler();
  const calls: {
    signal: AbortSignal;
    resolve: (body: CloudNotebookListResponse) => void;
    reject: (error: Error) => void;
  }[] = [];
  const saved: CloudNotebookListResponse[] = [];
  let clears = 0;
  const driver: NotebookHomeDriver = {
    identityKey: "alice",
    gate: "open",
    seed: null,
    waitMs: 8_000,
    scheduler,
    events,
    wake: EMPTY,
    load: (signal) => new Promise((resolve, reject) => calls.push({ signal, resolve, reject })),
    saved: (body) => saved.push(body),
    clear: () => {
      clears++;
    },
  };
  return { driver, events, scheduler, calls, saved, clears: () => clears };
}

test("a change during initial fetch cancels the stale snapshot and fetches again", async () => {
  const f = fixture();
  const store = new CloudNotebookHomeStore();
  const dispose = store.activate(f.driver);
  assert.equal(f.calls.length, 1);
  f.events.next();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0]!.signal.aborted, true);
  f.calls[0]!.resolve(body("stale"));
  f.calls[1]!.resolve(body("current"));
  await settle();
  assert.equal(store.snapshot.displayName, "current");
  assert.deepEqual(
    f.saved.map((entry) => entry.current_user_principal),
    ["current"],
  );
  dispose();
});

test("sign-out cancels pending work, closes the subscription, and clears cached data", async () => {
  const f = fixture();
  const store = new CloudNotebookHomeStore();
  const dispose = store.activate(f.driver);
  dispose();
  const signedOut = store.activate({ ...f.driver, gate: "closed" });
  f.calls[0]!.resolve(body());
  f.events.next();
  await settle();
  assert.equal(f.calls.length, 1);
  assert.equal(f.saved.length, 0);
  assert.equal(f.clears(), 1);
  assert.equal(store.snapshot.list.kind, "signed_out");
  signedOut();
});

test("an account switch discards completions from the previous identity", async () => {
  const first = fixture();
  const next = fixture();
  const store = new CloudNotebookHomeStore();
  const dispose = store.activate(first.driver);
  const epoch = store.identityEpoch;
  dispose();
  const stop = store.activate({ ...next.driver, identityKey: "bob" });
  assert.equal(store.snapshot.list.kind, "loading");
  first.calls[0]!.resolve(body("alice"));
  next.calls[0]!.resolve(body("bob"));
  await settle();
  assert.notEqual(store.identityEpoch, epoch);
  assert.equal(store.snapshot.displayName, "bob");
  assert.equal(first.saved.length, 0);
  stop();
});

test("a failed refresh retries without waiting for another server event", async () => {
  const f = fixture();
  const store = new CloudNotebookHomeStore();
  const stop = store.activate(f.driver);
  f.calls[0]!.reject(new Error("offline"));
  await settle();
  assert.equal(store.snapshot.list.kind, "error");
  f.scheduler.maxFrames = 1_000;
  f.scheduler.flush();
  assert.equal(f.calls.length, 2);
  f.calls[1]!.resolve(body());
  await settle();
  assert.equal(store.snapshot.list.kind, "ready");
  f.scheduler.maxFrames = 100_000;
  f.scheduler.flush();
  assert.equal(f.calls.length, 2, "healthy lists are not polled");
  stop();
});

test("loss of authorization clears the seeded list and stops retrying", async () => {
  const f = fixture();
  const store = new CloudNotebookHomeStore();
  const stop = store.activate({ ...f.driver, seed: { notebooks: [], totalCount: 0 } });
  f.calls[0]!.reject(new NotebookHomeAccessError("expired"));
  await settle();
  f.scheduler.maxFrames = 60_000;
  f.scheduler.flush();
  assert.equal(store.snapshot.list.kind, "signed_out");
  assert.equal(f.clears(), 1);
  assert.equal(f.calls.length, 1);
  stop();
});

test("waiting for a session preserves the seed until the deadline", () => {
  const f = fixture();
  const store = new CloudNotebookHomeStore();
  const stop = store.activate({
    ...f.driver,
    gate: "waiting",
    seed: { notebooks: [], totalCount: 0 },
  });
  assert.equal(store.snapshot.list.kind, "ready");
  assert.equal(f.calls.length, 0);
  f.scheduler.maxFrames = 8_000;
  f.scheduler.flush();
  assert.equal(f.calls.length, 1);
  stop();
});

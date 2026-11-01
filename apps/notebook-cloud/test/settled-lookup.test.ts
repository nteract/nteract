import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import {
  createSettledLookup,
  lookupAction,
  lookupTransition,
  type LookupEvent,
  type LookupState,
} from "../src/settled-lookup.ts";
import { deferred, track, turns, virtualTime } from "./settled-lookup-helpers.ts";

class TimedOut extends Error {}

function lookup(t: TestContext, overrides: { maxEntries?: number; waitMs?: number } = {}) {
  virtualTime(t);
  return createSettledLookup<string, string>({
    attemptMs: 1_000,
    waitMs: overrides.waitMs ?? 1_000,
    pollMs: 5,
    timeoutError: () => new TimedOut("timed out"),
    ...(overrides.maxEntries !== undefined ? { maxEntries: overrides.maxEntries } : {}),
  });
}

const fresh = (value: string, expiresAt = Date.now() + 60_000) => ({ value, expiresAt });

describe("lookupTransition", () => {
  const value = { name: "cached" };
  const states: Record<string, LookupState<typeof value>> = {
    empty: { name: "empty" },
    loading: { name: "loading", generation: 1, deadline: 100 },
    fresh: { name: "ready", value, expiresAt: 100 },
  };
  const events: Record<string, LookupEvent<typeof value>> = {
    "start before deadline": { type: "start", generation: 2, now: 50, deadline: 150 },
    "start at deadline": { type: "start", generation: 2, now: 100, deadline: 200 },
    "succeed current": { type: "succeed", generation: 1, value, expiresAt: 500 },
    "succeed stale": { type: "succeed", generation: 9, value, expiresAt: 500 },
    "fail current": { type: "fail", generation: 1 },
    "fail stale": { type: "fail", generation: 9 },
    "expire early": { type: "expire", generation: 1, now: 99 },
    "expire at deadline": { type: "expire", generation: 1, now: 100 },
    "expire stale": { type: "expire", generation: 9, now: 100 },
    "evict cached value": { type: "evict", value },
    "evict another value": { type: "evict", value: { name: "other" } },
  };
  // Expected state name, or "rejected".
  const expected: Record<string, Record<string, string>> = {
    empty: {
      "start before deadline": "loading",
      "start at deadline": "loading",
      "succeed current": "rejected",
      "succeed stale": "rejected",
      "fail current": "rejected",
      "fail stale": "rejected",
      "expire early": "rejected",
      "expire at deadline": "rejected",
      "expire stale": "rejected",
      "evict cached value": "rejected",
      "evict another value": "rejected",
    },
    loading: {
      "start before deadline": "rejected",
      "start at deadline": "loading",
      "succeed current": "ready",
      "succeed stale": "rejected",
      "fail current": "empty",
      "fail stale": "rejected",
      "expire early": "rejected",
      "expire at deadline": "empty",
      "expire stale": "rejected",
      "evict cached value": "rejected",
      "evict another value": "rejected",
    },
    fresh: {
      "start before deadline": "rejected",
      "start at deadline": "loading",
      "succeed current": "rejected",
      "succeed stale": "rejected",
      "fail current": "rejected",
      "fail stale": "rejected",
      "expire early": "rejected",
      "expire at deadline": "rejected",
      "expire stale": "rejected",
      "evict cached value": "empty",
      "evict another value": "rejected",
    },
  };

  for (const [stateName, state] of Object.entries(states)) {
    for (const [eventName, event] of Object.entries(events)) {
      it(`${stateName} + ${eventName}`, () => {
        const result = lookupTransition(state, event);
        const want = expected[stateName]![eventName]!;
        if (want === "rejected") {
          assert.ok(result.rejected, "event is rejected");
          assert.equal(result.state, state, "state is unchanged");
        } else {
          assert.equal(result.rejected, undefined);
          assert.equal(result.state.name, want);
        }
      });
    }
  }

  it("a new attempt replaces an abandoned one with its own generation and deadline", () => {
    const result = lookupTransition(states.loading!, events["start at deadline"]!);
    assert.deepEqual(result.state, { name: "loading", generation: 2, deadline: 200 });
  });

  it("chooses hit, wait or start from the state and the time", () => {
    assert.equal(lookupAction(states.empty!, 0), "start");
    assert.equal(lookupAction(states.loading!, 99), "wait");
    assert.equal(lookupAction(states.loading!, 100), "start");
    assert.equal(lookupAction(states.fresh!, 99), "hit");
    assert.equal(lookupAction(states.fresh!, 100), "start");
  });
});

describe("createSettledLookup", () => {
  it("a waiter resumes from its own timer, not from the attempt it waited for", async (t) => {
    const cache = lookup(t);
    const attempt = deferred<{ value: string; expiresAt: number }>();
    let loads = 0;
    const owner = cache.get("key", () => (loads++, attempt.promise));
    const waiter = cache.get("key", async () => (loads++, fresh("second")));
    const waiting = track(waiter);
    await turns();
    assert.equal(loads, 1, "only the first request starts an attempt");

    attempt.resolve(fresh("first"));
    assert.equal(await owner, "first");
    await turns();
    assert.equal(waiting.settled, false, "settling the attempt does not resume the waiter");

    t.mock.timers.tick(5);
    assert.equal(await waiter, "first");
    assert.equal(loads, 1);
  });

  it("a hung attempt stops blocking later requests at its deadline", async (t) => {
    const cache = lookup(t);
    const hung = deferred<{ value: string; expiresAt: number }>();
    let abandonedSignal: AbortSignal | undefined;
    const owner = cache.get("key", (signal) => ((abandonedSignal = signal), hung.promise));
    const ownerSettled = track(owner);
    const later = cache.get("key", async () => fresh("fresh attempt"));
    await turns();

    t.mock.timers.tick(999);
    await turns();
    assert.equal(ownerSettled.settled, false, "the attempt still has time");
    assert.equal(cache.state("key").name, "loading");

    t.mock.timers.tick(1);
    await assert.rejects(owner, TimedOut);
    assert.equal(abandonedSignal?.aborted, true, "the abandoned attempt is aborted");
    t.mock.timers.tick(5);
    assert.equal(await later, "fresh attempt");

    hung.resolve(fresh("late"));
    await turns();
    assert.equal(await cache.get("key", async () => fresh("unused")), "fresh attempt");
  });

  it("caches a success until it expires", async (t) => {
    const cache = lookup(t);
    let loads = 0;
    const load = async () => fresh(`value-${++loads}`, Date.now() + 100);
    assert.equal(await cache.get("key", load), "value-1");
    t.mock.timers.tick(99);
    assert.equal(await cache.get("key", load), "value-1");
    t.mock.timers.tick(1);
    assert.equal(await cache.get("key", load), "value-2");
    assert.equal(loads, 2);
  });

  it("hands the loader its start time so a slow attempt expires on schedule", async (t) => {
    const cache = lookup(t);
    const startedAt = Date.now();
    let seen: number | undefined;
    const pending = cache.get("key", async (_signal, attemptStart) => {
      seen = attemptStart;
      await new Promise((resolve) => setTimeout(resolve, 900));
      return fresh("slow", attemptStart + 100);
    });
    await turns();
    t.mock.timers.tick(900);
    assert.equal(await pending, "slow");
    assert.equal(seen, startedAt);
    assert.equal(cache.state("key").name, "ready");
    assert.equal(
      await cache.get("key", async () => fresh("reloaded")),
      "reloaded",
      "expired 100 ms after the start, before the 900 ms response",
    );
  });

  it("does not cache a failure", async (t) => {
    const cache = lookup(t);
    await assert.rejects(
      cache.get("key", async () => {
        throw new Error("provider is down");
      }),
      /provider is down/,
    );
    assert.equal(cache.state("key").name, "empty");
    assert.equal(await cache.get("key", async () => fresh("repaired")), "repaired");
  });

  it("a waiter whose attempt failed starts one attempt of its own", async (t) => {
    const cache = lookup(t);
    const failing = deferred<{ value: string; expiresAt: number }>();
    let loads = 0;
    const owner = cache.get("key", () => (loads++, failing.promise));
    const waiter = cache.get("key", async () => (loads++, fresh("retry")));
    await turns();
    failing.reject(new Error("first failed"));
    await assert.rejects(owner, /first failed/);
    t.mock.timers.tick(5);
    assert.equal(await waiter, "retry");
    assert.equal(loads, 2);
  });

  it("bounds a waiter's wait when every attempt hangs", async (t) => {
    const cache = lookup(t, { waitMs: 500 });
    const never = () => new Promise<never>(() => {});
    const owner = cache.get("key", never);
    const waiter = cache.get("key", never);
    await turns();
    t.mock.timers.tick(500);
    await assert.rejects(waiter, TimedOut);
    t.mock.timers.tick(500);
    await assert.rejects(owner, TimedOut);
    assert.equal(cache.state("key").name, "empty");
  });

  it("evicts only the value a caller found unusable", async (t) => {
    const cache = lookup(t);
    const first = await cache.get("key", async () => fresh("first"));
    cache.evict("key", "not-cached");
    assert.equal(cache.state("key").name, "ready");
    cache.evict("key", first);
    assert.equal(cache.state("key").name, "empty");
  });

  it("bounds entries and evicts the least recently used", async (t) => {
    const cache = lookup(t, { maxEntries: 2 });
    let loads = 0;
    const load = (value: string) => async () => (loads++, fresh(value));
    await cache.get("a", load("a"));
    await cache.get("b", load("b"));
    await cache.get("a", load("a"));
    await cache.get("c", load("c"));
    assert.equal(cache.state("b").name, "empty", "b was least recently used");
    assert.equal(cache.state("a").name, "ready");
    assert.equal(loads, 3);
  });

  it("supports object keys without retaining them", async (t) => {
    virtualTime(t);
    const cache = createSettledLookup<object, true>({
      attemptMs: 1_000,
      waitMs: 1_000,
      timeoutError: () => new TimedOut(),
      weakKeys: true,
    });
    const key = {};
    let loads = 0;
    const load = async () => (loads++, { value: true as const, expiresAt: Infinity });
    await cache.get(key, load);
    await cache.get(key, load);
    await cache.get({}, load);
    assert.equal(loads, 2);
  });
});

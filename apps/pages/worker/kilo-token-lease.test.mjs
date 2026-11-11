import assert from "node:assert/strict";
import { test } from "node:test";
import {
  kiloTokenLease,
  leaseAction,
  leaseEnd,
  leaseTransition,
  MAX_ENTRIES,
  MAX_LEASE_MS,
} from "./kilo-token-lease.mjs";

const absent = { name: "absent" };
const expired = { name: "expired" };
const exchanging = { name: "exchanging", generation: 1, deadline: 100 };
const leased = { name: "leased", value: "person", until: 100 };
const failure = new Error("refused");
const refused = { name: "refused", generation: 1, failure, until: 100 };

test("every state answers every event", () => {
  const before = { now: 50 };
  const after = { now: 100 };
  const cases = [
    // start: allowed unless a lease is live or an exchange holds the token.
    [absent, { type: "start", generation: 2, deadline: 150, ...before }, "exchanging"],
    [expired, { type: "start", generation: 2, deadline: 150, ...before }, "exchanging"],
    [exchanging, { type: "start", generation: 2, deadline: 150, ...before }, null],
    [exchanging, { type: "start", generation: 2, deadline: 200, ...after }, "exchanging"],
    [leased, { type: "start", generation: 2, deadline: 150, ...before }, null],
    [leased, { type: "start", generation: 2, deadline: 200, ...after }, "exchanging"],
    // A refusal is never reused: a new request starts a new exchange.
    [refused, { type: "start", generation: 2, deadline: 150, ...before }, "exchanging"],
    // settle: only the running exchange it names.
    [absent, { type: "settle", generation: 1, value: "p", until: 90, ...before }, null],
    [expired, { type: "settle", generation: 1, value: "p", until: 90, ...before }, null],
    [exchanging, { type: "settle", generation: 1, value: "p", until: 90, ...before }, "leased"],
    [exchanging, { type: "settle", generation: 1, value: "p", until: 50, ...before }, "expired"],
    [exchanging, { type: "settle", generation: 9, value: "p", until: 90, ...before }, null],
    [leased, { type: "settle", generation: 1, value: "p", until: 90, ...before }, null],
    [refused, { type: "settle", generation: 1, value: "p", until: 90, ...before }, null],
    // fail: only the running exchange it names.
    [absent, { type: "fail", generation: 1, failure, until: 90 }, null],
    [expired, { type: "fail", generation: 1, failure, until: 90 }, null],
    [exchanging, { type: "fail", generation: 1, failure, until: 90 }, "refused"],
    [exchanging, { type: "fail", generation: 9, failure, until: 90 }, null],
    [leased, { type: "fail", generation: 1, failure, until: 90 }, null],
    [refused, { type: "fail", generation: 1, failure, until: 90 }, null],
    // expire: at or after the end of a lease, an attempt or a refusal.
    [absent, { type: "expire", ...after }, null],
    [expired, { type: "expire", ...after }, null],
    [exchanging, { type: "expire", ...before }, null],
    [exchanging, { type: "expire", ...after }, "expired"],
    [leased, { type: "expire", ...before }, null],
    [leased, { type: "expire", ...after }, "expired"],
    [refused, { type: "expire", ...before }, null],
    [refused, { type: "expire", ...after }, "expired"],
    // Anything else changes nothing.
    [leased, { type: "renew", ...before }, null],
  ];
  for (const [state, event, next] of cases) {
    const result = leaseTransition(state, event);
    const label = `${state.name} + ${event.type} ${JSON.stringify(event)}`;
    if (next === null) {
      assert.ok(result.rejected, label);
      assert.equal(result.state, state, label);
    } else {
      assert.equal(result.rejected, undefined, label);
      assert.equal(result.state.name, next, label);
    }
  }
  assert.deepEqual(
    leaseTransition(exchanging, { type: "settle", generation: 1, value: "p", now: 50, until: 90 })
      .state,
    { name: "leased", value: "p", until: 90 },
  );
  assert.deepEqual(
    leaseTransition(exchanging, { type: "fail", generation: 1, failure, until: 90 }).state,
    { name: "refused", generation: 1, failure, until: 90 },
  );
});

test("a request uses a live lease, waits for a live exchange and otherwise starts", () => {
  assert.equal(leaseAction(absent, 50), "start");
  assert.equal(leaseAction(expired, 50), "start");
  assert.equal(leaseAction(leased, 99), "use");
  assert.equal(leaseAction(leased, 100), "start");
  assert.equal(leaseAction(exchanging, 99), "wait");
  assert.equal(leaseAction(exchanging, 100), "start");
  // Only a waiter of the failed exchange gets its failure, and only in time.
  assert.equal(leaseAction(refused, 50, 1), "fail");
  assert.equal(leaseAction(refused, 50, 2), "start");
  assert.equal(leaseAction(refused, 50), "start");
  assert.equal(leaseAction(refused, 100, 1), "start");
});

test("a lease ends at the token's exp, never more than 15 minutes on", () => {
  const now = 1_000_000_000;
  assert.equal(leaseEnd(now / 1000 + 300, now), now + 300_000);
  assert.equal(leaseEnd(now / 1000 + 3600, now), now + MAX_LEASE_MS);
  assert.equal(MAX_LEASE_MS, 15 * 60 * 1000);
  for (const exp of [undefined, null, "9999999999", Number.NaN, Infinity])
    assert.equal(leaseEnd(exp, now), now);
});

/** A clock tests move by hand. `sleep` lets other requests run, then moves
 * time on by the poll interval. */
function virtualClock() {
  const clock = { now: 1_000_000 };
  clock.read = () => clock.now;
  clock.sleep = async (ms) => {
    await new Promise((resolve) => setImmediate(resolve));
    clock.now += ms;
  };
  return clock;
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const settled = async (promise) => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  return promise;
};

test("one exchange per token while its lease lasts, and again after it ends", async () => {
  const clock = virtualClock();
  const lease = kiloTokenLease({ holdMs: 15_000, now: clock.read, sleep: clock.sleep });
  let exchanges = 0;
  const exchange = async () => {
    exchanges++;
    return { value: `person-${exchanges}`, until: clock.now + 300_000 };
  };
  assert.equal(await lease.resolve("token", exchange), "person-1");
  clock.now += 299_999;
  assert.equal(await lease.resolve("token", exchange), "person-1");
  assert.equal(exchanges, 1);
  clock.now += 1;
  assert.equal(await lease.resolve("token", exchange), "person-2");
  assert.equal(exchanges, 2);
  // Another token is its own lease.
  assert.equal(await lease.resolve("other", exchange), "person-3");
});

test("an exchange whose lease is already over serves its request and keeps nothing", async () => {
  const clock = virtualClock();
  const lease = kiloTokenLease({ holdMs: 15_000, now: clock.read, sleep: clock.sleep });
  let exchanges = 0;
  const exchange = async () => ({ value: ++exchanges, until: clock.now });
  assert.equal(await lease.resolve("token", exchange), 1);
  assert.equal(lease.state("token").name, "absent");
  assert.equal(await lease.resolve("token", exchange), 2);
});

test("concurrent requests for one new token share one exchange", async () => {
  const clock = virtualClock();
  const lease = kiloTokenLease({ holdMs: 15_000, now: clock.read, sleep: clock.sleep });
  const answer = deferred();
  let exchanges = 0;
  const exchange = () => {
    exchanges++;
    return answer.promise;
  };
  const requests = [1, 2, 3].map(() => lease.resolve("token", exchange));
  await settled();
  assert.equal(exchanges, 1);
  assert.equal(lease.state("token").name, "exchanging");
  answer.resolve({ value: "person", until: clock.now + 60_000 });
  assert.deepEqual(await Promise.all(requests), ["person", "person", "person"]);
  assert.equal(exchanges, 1);
});

test("a failure reaches the requests that waited for it and is not kept", async () => {
  const clock = virtualClock();
  const lease = kiloTokenLease({ holdMs: 15_000, now: clock.read, sleep: clock.sleep });
  const answer = deferred();
  let exchanges = 0;
  const failing = () => {
    exchanges++;
    return answer.promise;
  };
  const requests = [1, 2, 3].map(() => lease.resolve("token", failing).catch((error) => error));
  await settled();
  const refusal = Object.assign(new Error("refused"), { status: 401 });
  answer.reject(refusal);
  const results = await Promise.all(requests);
  assert.equal(exchanges, 1);
  assert.ok(results.every((result) => result === refusal));
  // The next request asks again.
  const succeeding = async () => {
    exchanges++;
    return { value: "person", until: clock.now + 60_000 };
  };
  assert.equal(await lease.resolve("token", succeeding), "person");
  assert.equal(exchanges, 2);
});

test("an exchange that never answers is abandoned at its deadline", async () => {
  const clock = virtualClock();
  const lease = kiloTokenLease({ holdMs: 100, pollMs: 10, now: clock.read, sleep: clock.sleep });
  const hung = deferred();
  let exchanges = 0;
  const first = lease.resolve("token", () => {
    exchanges++;
    return hung.promise;
  });
  void first.catch(() => {});
  await settled();
  // A waiter polls until the deadline, then starts its own exchange.
  const second = lease.resolve("token", async () => {
    exchanges++;
    return { value: "person", until: clock.now + 60_000 };
  });
  assert.equal(await second, "person");
  assert.equal(exchanges, 2);
  // The abandoned attempt's late answer doesn't replace the lease.
  hung.resolve({ value: "stale", until: clock.now + 60_000 });
  await first;
  assert.equal(lease.state("token").value, "person");
});

test("the table keeps at most maxEntries tokens, the oldest lease leaving first", async () => {
  const clock = virtualClock();
  assert.equal(MAX_ENTRIES, 1000);
  const lease = kiloTokenLease({
    holdMs: 15_000,
    maxEntries: 3,
    now: clock.read,
    sleep: clock.sleep,
  });
  let exchanges = 0;
  const exchange = async () => ({ value: ++exchanges, until: clock.now + 60_000 });
  for (const key of ["a", "b", "c", "d"]) await lease.resolve(key, exchange);
  assert.equal(lease.size(), 3);
  assert.equal(lease.state("a").name, "absent");
  assert.equal(await lease.resolve("b", exchange), 2);
  assert.equal(await lease.resolve("a", exchange), 5);
  // Using a lease doesn't renew it: "b" is still the oldest and leaves first.
  assert.equal(lease.state("b").name, "absent");
  assert.equal(lease.state("c").name, "leased");
});

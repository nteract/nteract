import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLOCK_ALLOWANCE_MS,
  evictable,
  kiloTokenLease,
  leaseAction,
  leaseEnd,
  leaseFailure,
  leaseTransition,
  MAX_ENTRIES,
  MAX_IN_FLIGHT,
  MAX_LEASE_MS,
} from "./kilo-token-lease.mjs";

const absent = { name: "absent" };
const expired = { name: "expired" };
const exchanging = { name: "exchanging", generation: 1, deadline: 100 };
const leased = { name: "leased", value: "person", until: 100 };
const failure = new Error("unavailable");
const refusal = new Error("invalid token");
const failed = { name: "failed", generation: 1, failure, until: 100 };
const refused = { name: "refused", generation: 1, failure: refusal, until: 100 };
const STATES = { absent, expired, exchanging, leased, failed, refused };

test("every state answers every event", () => {
  const before = { now: 50 };
  const after = { now: 100 };
  const start = (at) => ({ type: "start", generation: 2, deadline: at.now + 50, ...at });
  const settle = { type: "settle", generation: 1, value: "p", until: 90, ...before };
  const refuse = { type: "refuse", generation: 1, failure: refusal, until: 90 };
  const fail = { type: "fail", generation: 1, failure, until: 90 };
  const stale = (event) => ({ ...event, generation: 9 });
  const expire = (at) => ({ type: "expire", ...at });
  // [state, event, next state name or null for rejected]
  const table = {
    absent: [
      [start(before), "exchanging"],
      [settle, null],
      [refuse, null],
      [fail, null],
      [expire(after), null],
    ],
    expired: [
      [start(before), "exchanging"],
      [settle, null],
      [refuse, null],
      [fail, null],
      [expire(after), null],
    ],
    exchanging: [
      [start(before), null],
      [start(after), "exchanging"],
      [settle, "leased"],
      [{ ...settle, until: 50 }, "expired"],
      [stale(settle), null],
      [refuse, "refused"],
      [stale(refuse), null],
      [fail, "failed"],
      [stale(fail), null],
      [expire(before), null],
      [expire(after), "expired"],
    ],
    leased: [
      [start(before), null],
      [start(after), "exchanging"],
      [settle, null],
      [refuse, null],
      [fail, null],
      [expire(before), null],
      [expire(after), "expired"],
    ],
    failed: [
      // A failure is never reused by a new request: it starts an exchange.
      [start(before), "exchanging"],
      [settle, null],
      [refuse, null],
      [fail, null],
      [expire(before), null],
      [expire(after), "expired"],
    ],
    refused: [
      // A refusal answers every request until it ends.
      [start(before), null],
      [start(after), "exchanging"],
      [settle, null],
      [refuse, null],
      [fail, null],
      [expire(before), null],
      [expire(after), "expired"],
    ],
  };
  for (const [name, rows] of Object.entries(table))
    for (const [event, next] of rows) {
      const state = STATES[name];
      const result = leaseTransition(state, event);
      const label = `${name} + ${JSON.stringify(event)}`;
      if (next === null) {
        assert.ok(result.rejected, label);
        assert.equal(result.state, state, label);
      } else {
        assert.equal(result.rejected, undefined, label);
        assert.equal(result.state.name, next, label);
      }
    }
  assert.ok(leaseTransition(leased, { type: "renew", now: 50 }).rejected);
  // A new exchange over a live failure keeps it for that failure's waiters.
  assert.deepEqual(leaseTransition(failed, start(before)).state, {
    name: "exchanging",
    generation: 2,
    deadline: 100,
    prior: { generation: 1, failure, until: 100 },
  });
  assert.equal(leaseTransition(failed, start(after)).state.prior, undefined);
  assert.deepEqual(leaseTransition(exchanging, refuse).state, {
    name: "refused",
    generation: 1,
    failure: refusal,
    until: 90,
  });
});

test("a request uses a lease, takes a refusal, waits, or starts", () => {
  assert.equal(leaseAction(absent, 50), "start");
  assert.equal(leaseAction(expired, 50), "start");
  assert.equal(leaseAction(leased, 99), "use");
  assert.equal(leaseAction(leased, 100), "start");
  assert.equal(leaseAction(exchanging, 99), "wait");
  assert.equal(leaseAction(exchanging, 100), "start");
  // A refusal of the token answers everyone while it lasts.
  assert.equal(leaseAction(refused, 50), "fail");
  assert.equal(leaseAction(refused, 50, 7), "fail");
  assert.equal(leaseFailure(refused), refusal);
  assert.equal(leaseAction(refused, 100), "start");
  // A failure answers only the waiters of its attempt, while it lasts.
  assert.equal(leaseAction(failed, 50, 1), "fail");
  assert.equal(leaseAction(failed, 50, 2), "start");
  assert.equal(leaseAction(failed, 50), "start");
  assert.equal(leaseAction(failed, 100, 1), "start");
  // ... even after a newer attempt replaced it.
  const replaced = { ...exchanging, generation: 2, prior: { generation: 1, failure, until: 100 } };
  assert.equal(leaseAction(replaced, 50, 1), "fail");
  assert.equal(leaseFailure(replaced), failure);
  assert.equal(leaseAction(replaced, 50, 2), "wait");
  assert.equal(leaseAction(replaced, 50), "wait");
});

test("only a running exchange and a live lease are kept to admit another token", () => {
  assert.equal(evictable(exchanging, 99), false);
  assert.equal(evictable(exchanging, 100), true);
  assert.equal(evictable(leased, 99), false);
  assert.equal(evictable(leased, 100), true);
  assert.equal(evictable(failed, 50), true);
  assert.equal(evictable(refused, 50), true);
});

test("a lease ends at the earliest of exp, the token's lifetime from sending, and 15 minutes", () => {
  const iat = 1_000_000;
  const at = (seconds) => seconds * 1000;
  // In step: exp less the clock allowance.
  assert.equal(
    leaseEnd({ iat, exp: iat + 300 }, { sentAt: at(iat), settledAt: at(iat) + 50 }),
    at(iat + 300) - CLOCK_ALLOWANCE_MS,
  );
  // Pages behind Kilo by ten minutes: exp reads late, the lifetime bound holds.
  const behind = at(iat) - 600_000;
  assert.equal(
    leaseEnd({ iat, exp: iat + 300 }, { sentAt: behind, settledAt: behind + 50 }),
    behind + 300_000,
  );
  // Pages ahead of Kilo by four minutes: exp reads early and is the bound.
  const ahead = at(iat) + 240_000;
  assert.equal(
    leaseEnd({ iat, exp: iat + 300 }, { sentAt: ahead, settledAt: ahead + 50 }),
    at(iat + 300) - CLOCK_ALLOWANCE_MS,
  );
  // Ahead by more than the token's life less the allowance: no lease.
  const far = at(iat) + 290_000;
  assert.equal(leaseEnd({ iat, exp: iat + 300 }, { sentAt: far, settledAt: far + 50 }), null);
  // The clock moved back between send and answer: the earlier reading anchors.
  assert.equal(
    leaseEnd({ iat, exp: iat + 300 }, { sentAt: behind + 5000, settledAt: behind }),
    behind + 300_000,
  );
  // The 15-minute cap, with the longest lifetime Pages leases.
  assert.equal(
    leaseEnd({ iat, exp: iat + 900 }, { sentAt: behind, settledAt: behind }),
    behind + MAX_LEASE_MS,
  );
  for (const claims of [
    {},
    { iat },
    { exp: iat + 300 },
    { iat, exp: iat + 901 },
    { iat, exp: iat },
    { iat, exp: iat - 300 },
    { iat, exp: iat + 300.5 },
    { iat: iat + 0.5, exp: iat + 300 },
    { iat, exp: Number.MAX_VALUE },
    { iat, exp: -1 },
    { iat: at(iat), exp: at(iat + 300) },
    { iat, exp: at(iat + 300) },
    { iat: String(iat), exp: String(iat + 300) },
    { iat, exp: Infinity },
  ])
    assert.equal(
      leaseEnd(claims, { sentAt: at(iat), settledAt: at(iat) }),
      null,
      JSON.stringify(claims),
    );
});

/** A clock with timers that only moves when nothing else can run: then it
 * jumps to the earliest timer and fires it. Tests can also move it by hand. */
function virtualClock(t) {
  const clock = { now: 1_000_000, timers: [] };
  clock.read = () => clock.now;
  clock.sleep = (ms, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const timer = { at: clock.now + ms, resolve };
      clock.timers.push(timer);
      signal?.addEventListener("abort", () => {
        clock.timers = clock.timers.filter((other) => other !== timer);
        resolve();
      });
    });
  /** Fires the earliest timer, moving the clock to it. */
  clock.tick = () => {
    if (!clock.timers.length) return false;
    clock.timers.sort((a, b) => a.at - b.at);
    const next = clock.timers.shift();
    clock.now = Math.max(clock.now, next.at);
    next.resolve();
    return true;
  };
  // `manual` stops the clock; the test then fires timers with `tick`.
  clock.manual = false;
  let running = true;
  t.after(() => {
    running = false;
  });
  void (async () => {
    while (running) {
      await new Promise((resolve) => setImmediate(resolve));
      if (!clock.manual) clock.tick();
    }
  })();
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
const turns = async (count = 5) => {
  for (let i = 0; i < count; i++) await new Promise((resolve) => setImmediate(resolve));
};
const busy = (reason) => Object.assign(new Error(`busy: ${reason}`), { status: 503, reason });
const table = (clock, options = {}) =>
  kiloTokenLease({ holdMs: 15_000, busy, now: clock.read, sleep: clock.sleep, ...options });

test("one exchange per token while its lease lasts, and again after it ends", async (t) => {
  const clock = virtualClock(t);
  const lease = table(clock);
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
  assert.equal(await lease.resolve("other", exchange), "person-3");
});

test("an exchange with no lease serves its request and keeps nothing", async (t) => {
  const clock = virtualClock(t);
  const lease = table(clock);
  let exchanges = 0;
  const exchange = async () => ({ value: ++exchanges, until: null });
  assert.equal(await lease.resolve("token", exchange), 1);
  assert.equal(lease.state("token").name, "absent");
  assert.equal(await lease.resolve("token", exchange), 2);
});

test("concurrent requests for one new token share one exchange", async (t) => {
  const clock = virtualClock(t);
  const lease = table(clock);
  const answer = deferred();
  let exchanges = 0;
  const exchange = () => {
    exchanges++;
    return answer.promise;
  };
  const requests = [1, 2, 3].map(() => lease.resolve("token", exchange));
  await turns();
  assert.equal(exchanges, 1);
  answer.resolve({ value: "person", until: clock.now + 60_000 });
  assert.deepEqual(await Promise.all(requests), ["person", "person", "person"]);
  assert.equal(exchanges, 1);
});

test("a failure reaches its waiters and is not kept; a refusal answers repeats", async (t) => {
  const clock = virtualClock(t);
  const unavailable = Object.assign(new Error("unavailable"), { status: 503 });
  const invalid = Object.assign(new Error("invalid"), { status: 401, remember: 300_000 });
  const lease = table(clock, { rememberFor: (error) => error.remember ?? 0 });
  let exchanges = 0;
  const answer = deferred();
  const requests = [1, 2, 3].map(() =>
    lease
      .resolve("token", () => {
        exchanges++;
        return answer.promise;
      })
      .catch((error) => error),
  );
  await turns();
  answer.reject(unavailable);
  assert.ok((await Promise.all(requests)).every((result) => result === unavailable));
  assert.equal(exchanges, 1);
  // The next request asks again, and Kilo refuses the token itself.
  const refusing = async () => {
    exchanges++;
    throw invalid;
  };
  await assert.rejects(lease.resolve("token", refusing), invalid);
  assert.equal(exchanges, 2);
  // Repeats are answered from the refusal until it ends.
  clock.now += 299_999;
  await assert.rejects(lease.resolve("token", refusing), invalid);
  assert.equal(exchanges, 2);
  clock.now += 1;
  await assert.rejects(lease.resolve("token", refusing), invalid);
  assert.equal(exchanges, 3);
});

test("a starter whose exchange throws at once fails and holds nothing", async (t) => {
  const clock = virtualClock(t);
  const lease = table(clock);
  const thrown = new Error("thrown");
  await assert.rejects(
    lease.resolve("token", () => {
      throw thrown;
    }),
    thrown,
  );
  assert.equal(lease.state("token").name, "failed");
  assert.equal(lease.inFlight(), 0);
});

test("a waiter keeps the failure of the attempt it waited on after a newer one starts", async (t) => {
  const clock = virtualClock(t);
  clock.manual = true;
  const lease = table(clock, { pollMs: 10 });
  const first = deferred();
  const a = lease.resolve("token", () => first.promise).catch((error) => error);
  await turns(1);
  // B joins attempt 1 and is between polls.
  const b = lease.resolve("token", () => assert.fail("B never starts")).catch((error) => error);
  await turns(1);
  first.reject(failure);
  await turns();
  assert.equal(lease.state("token").name, "failed");
  // C arrives before B polls again and starts attempt 2.
  const second = deferred();
  const c = lease.resolve("token", () => second.promise);
  await turns(1);
  assert.equal(lease.state("token").generation, 2);
  // B's poll fires: it gets attempt 1's failure, not attempt 2's outcome.
  while (clock.timers.some((timer) => timer.at - clock.now <= 10)) {
    clock.tick();
    await turns();
  }
  assert.equal(await b, failure);
  assert.equal(await a, failure);
  second.resolve({ value: "person", until: clock.now + 60_000 });
  assert.equal(await c, "person");
});

test("a waiter gives up at its deadline through endless turnover", async (t) => {
  const clock = virtualClock(t);
  const lease = table(clock, { holdMs: 1000, pollMs: 10 });
  // Attempts that each hang until the next one abandons them.
  let attempts = 0;
  const hanging = () => {
    attempts++;
    return new Promise(() => {});
  };
  const starter = lease.resolve("token", hanging).catch((error) => error);
  await turns(1);
  const waiter = lease.resolve("token", hanging).catch((error) => error);
  // An exchange that never answers ends its starter and its waiter.
  assert.equal((await starter).reason, "wait_timeout");
  assert.equal((await waiter).reason, "wait_timeout");
  assert.ok(attempts >= 1);
});

test("a waiter on a turning-over token returns by its own deadline", async (t) => {
  const clock = virtualClock(t);
  const lease = table(clock, { holdMs: 1000, pollMs: 10 });
  // Every attempt fails just as another request starts the next.
  let generation = 0;
  const churn = async () => {
    for (;;) {
      const attempt = deferred();
      const started = lease
        .resolve("token", () => {
          generation++;
          return attempt.promise;
        })
        .catch(() => {});
      await turns(1);
      attempt.reject(failure);
      await started;
      if (clock.now > 1_000_000 + 5000) return;
      clock.now += 1;
    }
  };
  const churning = churn();
  const waiter = lease.resolve("token", () => new Promise(() => {})).catch((error) => error);
  const result = await waiter;
  assert.ok(result === failure || result?.reason === "wait_timeout", String(result));
  await churning;
  assert.ok(generation > 1);
});

test("at most maxInFlight exchanges run; a new token past that is refused untried", async (t) => {
  const clock = virtualClock(t);
  assert.equal(MAX_IN_FLIGHT, 8);
  // The hung exchanges hold their slots: time stands still.
  clock.manual = true;
  const lease = table(clock, { maxInFlight: 3 });
  // A token in use before the flood keeps working through it.
  await lease.resolve("in-use", async () => ({ value: "person", until: clock.now + 600_000 }));
  const hung = [];
  let exchanges = 0;
  let peak = 0;
  const forged = (key) =>
    lease.resolve(key, () => {
      exchanges++;
      peak = Math.max(peak, lease.inFlight());
      const answer = deferred();
      hung.push(answer);
      return answer.promise;
    });
  const floods = Array.from({ length: 50 }, (_, i) => forged(`forged-${i}`).catch((e) => e));
  await turns();
  assert.equal(exchanges, 3);
  assert.ok(peak <= 3);
  const turned = await Promise.all(floods.slice(3));
  assert.equal(turned.length, 47);
  assert.ok(turned.every((error) => error.reason === "exchanges_in_flight"));
  assert.equal(lease.inFlight(), 3);
  assert.equal(await lease.resolve("in-use", () => assert.fail("leased")), "person");
  for (const answer of hung) answer.reject(Object.assign(new Error("invalid"), { status: 401 }));
  await Promise.all(floods);
});

test("the table never drops a live lease or a running exchange to admit a token", async (t) => {
  const clock = virtualClock(t);
  assert.equal(MAX_ENTRIES, 1000);
  const remember = Object.assign(new Error("invalid"), { remember: 300_000 });
  const lease = table(clock, {
    maxEntries: 3,
    rememberFor: (error) => error.remember ?? 0,
  });
  const leaseFor = (key) =>
    lease.resolve(key, async () => ({ value: key, until: clock.now + 600_000 }));
  await leaseFor("a");
  await lease
    .resolve("refused", async () => {
      throw remember;
    })
    .catch(() => {});
  await leaseFor("b");
  // A refusal leaves first, ahead of an older lease.
  await leaseFor("c");
  assert.equal(lease.state("refused").name, "absent");
  for (const key of ["a", "b", "c"]) assert.equal(lease.state(key).name, "leased");
  // Full of live leases: a new token is refused without an exchange.
  await assert.rejects(
    lease.resolve("d", () => assert.fail("no exchange")),
    { reason: "lease_capacity" },
  );
  for (const key of ["a", "b", "c"]) assert.equal(lease.state(key).name, "leased");
  // A lease whose time is over makes room.
  clock.now += 600_000;
  await leaseFor("d");
  assert.equal(lease.size(), 3);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLOCK_ALLOWANCE_MS,
  evictable,
  kiloTokenLease,
  leaseAction,
  leaseEnd,
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
const refused = { name: "refused", failure: refusal, until: 100 };
const STATES = { absent, exchanging, leased, refused, expired };

test("every state answers every event", () => {
  const before = { now: 50 };
  const after = { now: 100 };
  const start = (at) => ({ type: "start", generation: 2, deadline: at.now + 50, ...at });
  const settle = { type: "settle", generation: 1, value: "p", until: 90, ...before };
  const refuse = { type: "refuse", generation: 1, failure: refusal, until: 90 };
  const fail = { type: "fail", generation: 1 };
  const stale = (event) => ({ ...event, generation: 9 });
  const expire = (at) => ({ type: "expire", ...at });
  // [event, next state name, or null for rejected]
  const table = {
    absent: [
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
      // The attempt owns the key until it settles: an answer after the
      // request that started it gave up still installs the lease.
      [{ ...settle, now: 99, until: 200 }, "leased"],
      // Past its hold, until another attempt takes the key.
      [{ ...settle, now: 150, until: 200 }, "leased"],
      [{ ...settle, until: 50 }, "expired"],
      [stale(settle), null],
      [refuse, "refused"],
      [stale(refuse), null],
      // A transient failure leaves nothing behind.
      [fail, "expired"],
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
    refused: [
      // A refusal of the token answers every request until it ends.
      [start(before), null],
      [start(after), "exchanging"],
      [settle, null],
      [refuse, null],
      [fail, null],
      [expire(before), null],
      [expire(after), "expired"],
    ],
    expired: [
      [start(before), "exchanging"],
      [settle, null],
      [refuse, null],
      [fail, null],
      [expire(after), null],
    ],
  };
  assert.deepEqual(Object.keys(table).sort(), Object.keys(STATES).sort());
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
  assert.deepEqual(leaseTransition(exchanging, refuse).state, {
    name: "refused",
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
  assert.equal(leaseAction(refused, 99), "fail");
  assert.equal(leaseAction(refused, 100), "start");
});

test("only a running exchange and a live lease are kept to admit another token", () => {
  assert.equal(evictable(exchanging, 99), false);
  assert.equal(evictable(exchanging, 100), true);
  assert.equal(evictable(leased, 99), false);
  assert.equal(evictable(leased, 100), true);
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
/** `resolve` with when it settled, on the virtual clock. */
const timed = (clock, promise) =>
  promise.then(
    (value) => ({ value, at: clock.now }),
    (error) => ({ error, at: clock.now }),
  );

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

test("a transient failure reaches only its own request; waiters exchange again, one at a time", async (t) => {
  const clock = virtualClock(t);
  const lease = table(clock);
  const answers = [deferred(), deferred()];
  let exchanges = 0;
  let running = 0;
  let peak = 0;
  const exchange = () => {
    const answer = answers[exchanges++];
    peak = Math.max(peak, ++running);
    return answer.promise.finally(() => running--);
  };
  const requests = [1, 2, 3].map(() => lease.resolve("token", exchange).catch((error) => error));
  await turns();
  answers[0].reject(failure);
  await turns();
  // One waiter took the key for a second exchange; the other waits on it.
  assert.equal(exchanges, 2);
  answers[1].resolve({ value: "person", until: clock.now + 60_000 });
  assert.deepEqual(await Promise.all(requests), [failure, "person", "person"]);
  assert.equal(exchanges, 2);
  assert.equal(peak, 1, "exchanges for one token are serial");
});

test("a refusal of the token answers repeats until it ends", async (t) => {
  const clock = virtualClock(t);
  const invalid = Object.assign(new Error("invalid"), { status: 401, remember: 300_000 });
  const lease = table(clock, { rememberFor: (error) => error.remember ?? 0 });
  let exchanges = 0;
  const refusing = async () => {
    exchanges++;
    throw invalid;
  };
  await assert.rejects(lease.resolve("token", refusing), invalid);
  clock.now += 299_999;
  await assert.rejects(lease.resolve("token", refusing), invalid);
  assert.equal(exchanges, 1);
  clock.now += 1;
  await assert.rejects(lease.resolve("token", refusing), invalid);
  assert.equal(exchanges, 2);
  // A transient failure is not remembered.
  const unavailable = Object.assign(new Error("unavailable"), { status: 503 });
  await assert.rejects(
    lease.resolve("other", async () => {
      throw unavailable;
    }),
    unavailable,
  );
  assert.equal(lease.state("other").name, "absent");
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
  assert.equal(lease.state("token").name, "absent");
  assert.equal(lease.inFlight(), 0);
});

test("no request answers later than its arrival plus holdMs", async (t) => {
  const clock = virtualClock(t);
  const lease = table(clock, { holdMs: 1000, pollMs: 10 });
  const hanging = () => new Promise(() => {});
  // A starts an exchange that never answers; B joins it at the same moment,
  // so when A's attempt is abandoned B's own deadline has come too.
  clock.manual = true;
  const arrived = clock.now;
  const a = timed(clock, lease.resolve("token", hanging));
  const b = timed(clock, lease.resolve("token", hanging));
  await turns();
  clock.manual = false;
  for (const outcome of [await a, await b]) {
    assert.equal(outcome.error?.reason, "wait_timeout");
    assert.ok(outcome.at <= arrived + 1000, `${outcome.at - arrived} ms`);
  }
  // C arrives later and its own deadline is counted from its own arrival.
  const late = clock.now;
  const c = await timed(clock, lease.resolve("token", hanging));
  assert.equal(c.error?.reason, "wait_timeout");
  assert.ok(c.at <= late + 1000, `${c.at - late} ms`);
});

test("a waiter returns by its own deadline through endless turnover", async (t) => {
  const clock = virtualClock(t);
  const lease = table(clock, { holdMs: 1000, pollMs: 10 });
  // Every attempt fails as soon as it starts, and another request starts the next.
  let generations = 0;
  let churning = true;
  const churn = (async () => {
    while (churning) {
      await lease
        .resolve("token", async () => {
          generations++;
          await turns(1);
          throw failure;
        })
        .catch(() => {});
      clock.now += 1;
    }
  })();
  const arrived = clock.now;
  const waiter = await timed(
    clock,
    lease.resolve("token", () => new Promise(() => {})),
  );
  churning = false;
  await churn;
  assert.ok(waiter.at <= arrived + 1000, `${waiter.at - arrived} ms`);
  assert.ok(waiter.error === failure || waiter.error?.reason === "wait_timeout");
  assert.ok(generations > 1);
});

/** Exchanges that record how many run at once, per token and overall. Each
 * call to `script(key, n)` gives the nth exchange's behaviour for `key`. */
function instrumented(clock, script) {
  const running = new Map();
  const log = { overall: 0, peak: 0, peakPerKey: 0, starts: [] };
  const exchange = (key) => () => {
    const n = log.starts.filter((start) => start.key === key).length;
    log.starts.push({ key, at: clock.now });
    running.set(key, (running.get(key) ?? 0) + 1);
    log.overall++;
    log.peak = Math.max(log.peak, log.overall);
    log.peakPerKey = Math.max(log.peakPerKey, running.get(key));
    const done = () => {
      running.set(key, running.get(key) - 1);
      log.overall--;
    };
    return script(key, n).then(
      (value) => {
        done();
        return value;
      },
      (error) => {
        done();
        throw error;
      },
    );
  };
  return { log, exchange };
}

test("an abandoned attempt holds its token until its exchange settles", async (t) => {
  const clock = virtualClock(t);
  const start = clock.now;
  const at = (ms) => clock.sleep(start + ms - clock.now);
  const lease = table(clock, { pollMs: 100 });
  // The production timeline: A's exchange fails at 9.9 s; B, which arrived at
  // 0.1 s, then starts one that runs to Kilo's 10 s timeout and fails at
  // about 19.9 s; C arrives at 15.2 s, after B gave up.
  const { log, exchange } = instrumented(clock, async (key, n) => {
    if (n === 0) {
      await at(9_900);
      throw failure;
    }
    if (n === 1) {
      await clock.sleep(10_000);
      throw failure;
    }
    await clock.sleep(1_000);
    return { value: "person", until: clock.now + 60_000 };
  });
  const a = timed(clock, lease.resolve("token", exchange("token")));
  const b = at(100).then(() => timed(clock, lease.resolve("token", exchange("token"))));
  const c = at(15_200).then(() => timed(clock, lease.resolve("token", exchange("token"))));
  assert.equal((await a).error, failure);
  const bOutcome = await b;
  assert.equal(bOutcome.error?.reason, "wait_timeout");
  assert.ok(bOutcome.at <= start + 100 + 15_000);
  const cOutcome = await c;
  assert.equal(cOutcome.value, "person");
  assert.ok(cOutcome.at <= start + 15_200 + 15_000);
  // C started only after B's abandoned exchange settled.
  assert.equal(log.peakPerKey, 1, "one exchange per token at every instant");
  assert.ok(log.starts[2].at >= start + 19_900, `${log.starts[2].at - start} ms`);
});

test("an attempt counts against the in-flight bound until it settles, not until its requester leaves", async (t) => {
  const clock = virtualClock(t);
  const start = clock.now;
  const at = (ms) => clock.sleep(start + ms - clock.now);
  const lease = table(clock, { holdMs: 1000, pollMs: 10, maxInFlight: 1 });
  const { log, exchange } = instrumented(clock, async (key, n) => {
    if (key === "token" && n === 0) {
      await at(500);
      throw failure;
    }
    // B's attempt starts at 0.5 s and settles at 1.4 s, after B left at 1 s.
    await clock.sleep(900);
    return { value: key, until: clock.now + 60_000 };
  });
  const a = lease.resolve("token", exchange("token")).catch((error) => error);
  const b = timed(clock, lease.resolve("token", exchange("token")));
  assert.equal(await a, failure);
  assert.equal((await b).error?.reason, "wait_timeout");
  // Between B leaving and its attempt settling, the slot is still taken.
  await at(1_200);
  assert.equal(lease.inFlight(), 1);
  await assert.rejects(lease.resolve("other", exchange("other")), {
    reason: "exchanges_in_flight",
  });
  assert.ok(log.peak <= 1);
  await at(1_450);
  assert.equal(lease.inFlight(), 0);
});

test("an attempt whose requester gave up still decides what the next request finds", async (t) => {
  for (const [label, outcome, expect] of [
    ["success", async () => ({ value: "person", until: Infinity }), "leased"],
    [
      "refusal",
      async () => {
        throw Object.assign(new Error("invalid"), { remember: 300_000 });
      },
      "refused",
    ],
    ["transient failure", async () => Promise.reject(failure), "absent"],
  ]) {
    await t.test(label, async (t) => {
      const clock = virtualClock(t);
      const start = clock.now;
      const at = (ms) => clock.sleep(start + ms - clock.now);
      const lease = table(clock, {
        holdMs: 1000,
        pollMs: 10,
        rememberFor: (error) => error.remember ?? 0,
      });
      const { log, exchange } = instrumented(clock, async (key, n) => {
        if (n === 0) {
          await at(500);
          throw failure;
        }
        if (n === 1) {
          // Starts at 0.5 s, answers at 1.2 s, after its requester left at 1 s.
          await at(1_200);
          return outcome();
        }
        return { value: "fresh", until: clock.now + 60_000 };
      });
      const a = lease.resolve("token", exchange("token")).catch((error) => error);
      const b = timed(clock, lease.resolve("token", exchange("token")));
      await a;
      assert.equal((await b).error?.reason, "wait_timeout");
      await at(1_300);
      assert.equal(lease.state("token").name, expect);
      const next = await lease.resolve("token", exchange("token")).then(
        (value) => value,
        (error) => error,
      );
      if (expect === "leased") assert.equal(next, "person");
      if (expect === "refused") assert.equal(next.remember, 300_000);
      if (expect === "absent") assert.equal(next, "fresh");
      assert.equal(log.starts.length, expect === "absent" ? 3 : 2, label);
    });
  }
});

test("an attempt that never settles frees its token and slot at its own hold, not before", async (t) => {
  const clock = virtualClock(t);
  const start = clock.now;
  const at = (ms) => clock.sleep(start + ms - clock.now);
  const lease = table(clock, { holdMs: 1000, pollMs: 10, maxInFlight: 1 });
  const { log, exchange } = instrumented(clock, async (key) =>
    key === "hung" ? new Promise(() => {}) : { value: key, until: clock.now + 60_000 },
  );
  void lease.resolve("hung", exchange("hung")).catch(() => {});
  await at(999);
  await assert.rejects(lease.resolve("other", exchange("other")), {
    reason: "exchanges_in_flight",
  });
  // A request for the same token waits on the hung attempt until its hold.
  const same = timed(clock, lease.resolve("hung", exchange("hung")));
  await at(1_000);
  assert.equal(await lease.resolve("other", exchange("other")), "other");
  const late = await same;
  assert.equal(late.error?.reason, "wait_timeout");
  assert.ok(
    log.starts
      .filter((s) => s.key === "hung")
      .every((s) => s.at === start || s.at >= start + 1_000),
  );
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

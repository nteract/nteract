import assert from "node:assert/strict";
import test from "node:test";
import { VirtualTimeScheduler } from "rxjs";
import {
  createReadBudget,
  initialReadBudget,
  READ_BURST,
  READ_CONCURRENCY,
  READ_REFILL_PER_SECOND,
  READ_WAITING_LIMIT,
  readBudgetTransition,
} from "@nteract/output-frame/read-budget";

const TOKEN_MS = 1000 / READ_REFILL_PER_SECOND;

function run(state, events) {
  const started = [];
  let last;
  for (const event of events) {
    last = readBudgetTransition(state, event);
    state = last.state;
    started.push(...last.start);
  }
  return { state, started, last };
}

const requests = (ids, now = 0) => ids.map((id) => ({ type: "request", id, now }));
const range = (from, to) => Array.from({ length: to - from }, (_, i) => from + i);

test("the bounds are the documented values", () => {
  assert.equal(READ_CONCURRENCY, 8);
  assert.equal(READ_BURST, 256);
  assert.equal(READ_REFILL_PER_SECOND, 32);
  assert.equal(READ_WAITING_LIMIT, 256);
});

test("reads under the concurrency cap start at once", () => {
  const { state, started, last } = run(initialReadBudget(0), requests(range(1, 9)));
  assert.deepEqual(started, range(1, 9));
  assert.deepEqual(state.running, range(1, 9));
  assert.deepEqual(state.waiting, []);
  assert.equal(state.tokens, READ_BURST - 8);
  assert.equal(last.refused, false);
  assert.equal(last.wakeAt, null);
});

test("the ninth read waits, and settles start waiting reads in arrival order", () => {
  let { state, started, last } = run(initialReadBudget(0), requests(range(1, 12)));
  assert.deepEqual(started, range(1, 9));
  assert.deepEqual(state.waiting, [9, 10, 11]);
  // Waiting on a slot, not on a token: no timer.
  assert.equal(last.wakeAt, null);
  last = readBudgetTransition(state, { type: "settle", id: 4, now: 0 });
  assert.deepEqual(last.start, [9]);
  assert.deepEqual(last.state.running, [1, 2, 3, 5, 6, 7, 8, 9]);
  last = readBudgetTransition(last.state, { type: "settle", id: 1, now: 0 });
  assert.deepEqual(last.start, [10]);
  assert.deepEqual(last.state.waiting, [11]);
});

test("cancelling a waiting read removes it without spending a token", () => {
  const { state } = run(initialReadBudget(0), requests(range(1, 11)));
  const cancelled = readBudgetTransition(state, { type: "cancel", id: 9, now: 0 });
  assert.deepEqual(cancelled.start, []);
  assert.deepEqual(cancelled.state.waiting, [10]);
  assert.equal(cancelled.state.tokens, state.tokens);
  const next = readBudgetTransition(cancelled.state, { type: "settle", id: 1, now: 0 });
  assert.deepEqual(next.start, [10]);
});

test("cancelling an in-flight read keeps its slot until it settles", () => {
  const { state } = run(initialReadBudget(0), requests(range(1, 10)));
  const result = readBudgetTransition(state, { type: "cancel", id: 3, now: 0 });
  assert.equal(result.state, state);
  assert.deepEqual(result.start, []);
});

test("settling or cancelling an unknown id changes nothing", () => {
  const { state } = run(initialReadBudget(0), requests(range(1, 10)));
  for (const type of ["settle", "cancel"]) {
    const result = readBudgetTransition(state, { type, id: 99, now: 5000 });
    assert.equal(result.state, state);
    assert.deepEqual(result.start, []);
    assert.equal(result.refused, false);
  }
  // A waiting read cannot settle; only a started one can.
  assert.equal(readBudgetTransition(state, { type: "settle", id: 9, now: 0 }).state, state);
  // A repeated request id is ignored.
  assert.equal(readBudgetTransition(state, { type: "request", id: 9, now: 0 }).state, state);
});

test("the 257th start in one instant waits for a token even with free slots", () => {
  let state = initialReadBudget(0);
  let started = 0;
  for (let id = 1; id <= READ_BURST; id++) {
    const result = readBudgetTransition(state, { type: "request", id, now: 0 });
    started += result.start.length;
    state = readBudgetTransition(result.state, { type: "settle", id, now: 0 }).state;
  }
  assert.equal(started, READ_BURST);
  assert.equal(state.tokens, 0);
  const last = readBudgetTransition(state, { type: "request", id: 257, now: 0 });
  assert.deepEqual(last.start, []);
  assert.deepEqual(last.state.running, []);
  assert.deepEqual(last.state.waiting, [257]);
  assert.equal(last.wakeAt, TOKEN_MS);
});

test("a tick grants exactly the tokens the elapsed time earned, capped at the burst", () => {
  const spent = { ...initialReadBudget(0), tokens: 0 };
  // 2.5 intervals earn two tokens; the half interval carries over.
  let result = readBudgetTransition(spent, { type: "tick", now: TOKEN_MS * 2.5 });
  assert.equal(result.state.tokens, 2);
  assert.equal(result.state.countedAt, TOKEN_MS * 2);
  result = readBudgetTransition(result.state, { type: "tick", now: TOKEN_MS * 3 });
  assert.equal(result.state.tokens, 3);
  result = readBudgetTransition(result.state, { type: "tick", now: TOKEN_MS * 3 - 1 });
  assert.equal(result.state.tokens, 3);
  result = readBudgetTransition(spent, { type: "tick", now: 60_000 });
  assert.equal(result.state.tokens, READ_BURST);
  assert.equal(result.state.countedAt, 60_000);
  // Waiting reads take earned tokens as slots allow.
  const waiting = { ...spent, waiting: [1, 2, 3] };
  result = readBudgetTransition(waiting, { type: "tick", now: TOKEN_MS * 2 });
  assert.deepEqual(result.start, [1, 2]);
  assert.deepEqual(result.state.waiting, [3]);
  assert.equal(result.state.tokens, 0);
  assert.equal(result.wakeAt, TOKEN_MS * 3);
});

test("a request that finds the waiting list full is refused", () => {
  const { state } = run(initialReadBudget(0), requests(range(1, 9 + READ_WAITING_LIMIT)));
  assert.equal(state.waiting.length, READ_WAITING_LIMIT);
  const refused = readBudgetTransition(state, { type: "request", id: 999, now: 0 });
  assert.equal(refused.refused, true);
  assert.deepEqual(refused.start, []);
  assert.ok(!refused.state.waiting.includes(999));
  // Room on the waiting list admits the next request again.
  const room = readBudgetTransition(state, { type: "cancel", id: 9, now: 0 }).state;
  assert.equal(readBudgetTransition(room, { type: "request", id: 999, now: 0 }).refused, false);
});

test("dispose drops every read, and a disposed budget starts nothing", () => {
  const { state } = run(initialReadBudget(0), requests(range(1, 20)));
  const disposed = readBudgetTransition(state, { type: "dispose" });
  assert.equal(disposed.state.disposed, true);
  assert.deepEqual(disposed.state.running, []);
  assert.deepEqual(disposed.state.waiting, []);
  assert.equal(disposed.wakeAt, null);
  for (const event of [
    { type: "settle", id: 1, now: 0 },
    { type: "cancel", id: 12, now: 0 },
    { type: "tick", now: 10_000 },
    { type: "dispose" },
  ]) {
    const result = readBudgetTransition(disposed.state, event);
    assert.equal(result.state, disposed.state);
    assert.deepEqual(result.start, []);
  }
  assert.equal(
    readBudgetTransition(disposed.state, { type: "request", id: 50, now: 0 }).refused,
    true,
  );
});

test("a burst of instant reads starts 256 at once and the rest at the refill rate", () => {
  const clock = new VirtualTimeScheduler();
  const lifetime = new AbortController();
  const budget = createReadBudget({ lifetime: lifetime.signal, scheduler: clock });
  const startedAt = [];
  for (let i = 0; i < 300; i++)
    assert.equal(
      budget.schedule(new AbortController().signal, (settle) => {
        startedAt.push(clock.now());
        settle();
      }),
      true,
    );
  assert.equal(startedAt.length, READ_BURST);
  // One timer waits for the next token.
  assert.equal(clock.actions.length, 1);
  clock.maxFrames = 1000;
  clock.flush();
  assert.equal(startedAt.length, READ_BURST + READ_REFILL_PER_SECOND);
  assert.ok(clock.actions.length <= 1);
  clock.maxFrames = Infinity;
  clock.flush();
  assert.equal(startedAt.length, 300);
  assert.equal(clock.actions.length, 0);
  const late = startedAt.slice(READ_BURST);
  assert.ok(late.every((at, i) => at >= Math.ceil((i + 1) * TOKEN_MS) - 1e-9));
  assert.ok(late.at(-1) <= Math.ceil(44 * TOKEN_MS));
  lifetime.abort();
});

test("disposing with reads waiting cancels the timer and starts nothing more", () => {
  const clock = new VirtualTimeScheduler();
  const lifetime = new AbortController();
  const budget = createReadBudget({ lifetime: lifetime.signal, scheduler: clock });
  let started = 0;
  for (let i = 0; i < 260; i++)
    budget.schedule(new AbortController().signal, (settle) => {
      started++;
      settle();
    });
  assert.equal(started, READ_BURST);
  assert.equal(clock.actions.length, 1);
  lifetime.abort();
  assert.equal(clock.actions.length, 0);
  clock.flush();
  assert.equal(started, READ_BURST);
  assert.equal(
    budget.schedule(new AbortController().signal, () => started++),
    false,
  );
  assert.equal(started, READ_BURST);
});

test("aborting a waiting read's signal removes it before it starts", () => {
  const clock = new VirtualTimeScheduler();
  const budget = createReadBudget({ scheduler: clock });
  const settles = [];
  for (let i = 0; i < READ_CONCURRENCY; i++) budget.schedule(undefined, (s) => settles.push(s));
  const waiting = new AbortController();
  let ran = false;
  assert.equal(
    budget.schedule(waiting.signal, () => (ran = true)),
    true,
  );
  let next = false;
  budget.schedule(undefined, () => (next = true));
  waiting.abort();
  settles[0]();
  assert.equal(ran, false);
  assert.equal(next, true);
  // Settling twice frees one slot, once.
  settles[0]();
});

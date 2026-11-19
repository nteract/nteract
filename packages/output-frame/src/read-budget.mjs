import { asyncScheduler, timer } from "rxjs";

// One budget per mounted view, shared by all of its bound files. Every read is
// an authorized request on the reader's session, and view code runs in every
// reader's browser, so these bound what one view can ask of the host.

// Reads in flight at once across the view.
export const READ_CONCURRENCY = 8;
// Reads a view can start back to back before the refill rate applies.
export const READ_BURST = 256;
// Reads a view can start per second once its burst is spent.
export const READ_REFILL_PER_SECOND = 32;
// Reads that may wait for a slot or a token. A read past this is refused.
export const READ_WAITING_LIMIT = 256;

const TOKEN_MS = 1000 / READ_REFILL_PER_SECOND;

// `running` and `waiting` hold read ids; `waiting` is in arrival order.
// `countedAt` is the time up to which tokens have been credited. It advances
// by whole token intervals, so a partial interval carries over to the next
// count.
export function initialReadBudget(now) {
  return Object.freeze({
    running: Object.freeze([]),
    waiting: Object.freeze([]),
    tokens: READ_BURST,
    countedAt: now,
    disposed: false,
  });
}

// Pure transition. Events: {type: "request" | "settle" | "cancel", id, now},
// {type: "tick", now} and {type: "dispose"}. Returns the next state plus the
// effects for the edge: ids to start now, whether this request was refused,
// and when the next token arrives if reads are waiting only on tokens.
export function readBudgetTransition(state, event) {
  if (state.disposed) return effects(state, [], event.type === "request");
  switch (event.type) {
    case "dispose":
      return effects({ ...state, running: [], waiting: [], disposed: true }, [], false);
    case "request": {
      if (state.running.includes(event.id) || state.waiting.includes(event.id))
        return effects(state, [], false);
      const { state: ready, start } = pump(refill(state, event.now));
      if (ready.waiting.length >= READ_WAITING_LIMIT) return effects(ready, start, true);
      const next = pump({ ...ready, waiting: [...ready.waiting, event.id] });
      return effects(next.state, [...start, ...next.start], false);
    }
    case "settle": {
      if (!state.running.includes(event.id)) return effects(state, [], false);
      const freed = { ...state, running: state.running.filter((id) => id !== event.id) };
      const next = pump(refill(freed, event.now));
      return effects(next.state, next.start, false);
    }
    case "cancel": {
      // An in-flight read keeps its slot until it settles.
      if (!state.waiting.includes(event.id)) return effects(state, [], false);
      const kept = { ...state, waiting: state.waiting.filter((id) => id !== event.id) };
      const next = pump(refill(kept, event.now));
      return effects(next.state, next.start, false);
    }
    case "tick": {
      const next = pump(refill(state, event.now));
      return effects(next.state, next.start, false);
    }
    default:
      return effects(state, [], false);
  }
}

function refill(state, now) {
  const earned = Math.floor(Math.max(0, now - state.countedAt) / TOKEN_MS);
  if (state.tokens + earned >= READ_BURST) return { ...state, tokens: READ_BURST, countedAt: now };
  return {
    ...state,
    tokens: state.tokens + earned,
    countedAt: state.countedAt + earned * TOKEN_MS,
  };
}

function pump(state) {
  const start = [];
  let { running, waiting, tokens } = state;
  while (waiting.length && running.length < READ_CONCURRENCY && tokens >= 1) {
    const [id, ...rest] = waiting;
    waiting = rest;
    running = [...running, id];
    tokens--;
    start.push(id);
  }
  return { state: { ...state, running, waiting, tokens }, start };
}

// An unchanged state comes back as the same frozen object.
function effects(state, start, refused) {
  const frozen = Object.isFrozen(state)
    ? state
    : Object.freeze({
        ...state,
        running: Object.freeze([...state.running]),
        waiting: Object.freeze([...state.waiting]),
      });
  const onTokens =
    frozen.waiting.length > 0 && frozen.running.length < READ_CONCURRENCY && frozen.tokens < 1;
  return {
    state: frozen,
    start,
    refused,
    wakeAt: onTokens ? frozen.countedAt + TOKEN_MS : null,
  };
}

// Runs the transition's effects. `schedule(signal, start)` admits one read:
// `start(settle)` runs when the budget lets it begin, and the read calls
// `settle` once it has finished, failed or been aborted. Aborting `signal`
// before the read begins removes it from the queue, and `start` never runs.
// Returns false when the read is refused. One timer at most waits for the next
// token; the lifetime's abort drops every waiting read and cancels that timer.
export function createReadBudget({ lifetime, scheduler = asyncScheduler } = {}) {
  let state = initialReadBudget(scheduler.now());
  let nextId = 0;
  let wake = null;
  const begin = new Map();
  const arm = (at) => {
    if (wake?.at === at) return;
    wake?.subscription.unsubscribe();
    wake = null;
    if (at === null) return;
    const subscription = timer(Math.max(0, Math.ceil(at - scheduler.now())), scheduler).subscribe(
      () => {
        wake = null;
        dispatch({ type: "tick", now: scheduler.now() });
      },
    );
    wake = { at, subscription };
  };
  // The state and the timer are settled before any read begins, so a read
  // that settles synchronously re-enters against current state.
  const dispatch = (event) => {
    const result = readBudgetTransition(state, event);
    state = result.state;
    arm(result.wakeAt);
    for (const id of result.start) {
      const run = begin.get(id);
      begin.delete(id);
      run?.();
    }
    return result;
  };
  const dispose = () => {
    begin.clear();
    dispatch({ type: "dispose" });
  };
  if (lifetime?.aborted) dispose();
  else lifetime?.addEventListener("abort", dispose, { once: true });
  return {
    schedule(signal, start) {
      if (state.disposed || signal?.aborted) return false;
      const id = ++nextId;
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        dispatch({ type: "settle", id, now: scheduler.now() });
      };
      const cancel = () => {
        begin.delete(id);
        dispatch({ type: "cancel", id, now: scheduler.now() });
      };
      begin.set(id, () => {
        signal?.removeEventListener("abort", cancel);
        start(settle);
      });
      signal?.addEventListener("abort", cancel, { once: true });
      if (!dispatch({ type: "request", id, now: scheduler.now() }).refused) return true;
      begin.delete(id);
      signal?.removeEventListener("abort", cancel);
      return false;
    },
  };
}

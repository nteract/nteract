/**
 * Poll primitive contract tests.
 *
 * RxJS timers run on an injected `VirtualTimeScheduler` (cadence is virtual-time
 * total); fetch promises settle on the real microtask queue, drained explicitly
 * with `drainMicrotasks`. The two clocks never mix: `from(promise)` takes no
 * scheduler, and every `timer` takes the injected one, so advancing virtual time
 * fires cadence deterministically while promise resolution stays under test
 * control.
 *
 * The load-bearing case is F4: a wakeup or gate rise landing mid-fetch must not
 * start a second concurrent request. This is the regression guard for the
 * single-`exhaustMap` fixed-rate shape.
 */

import { createPoll, fetchLatest } from "runtimed";
import {
  BehaviorSubject,
  NEVER,
  Observable,
  Subject,
  VirtualAction,
  VirtualTimeScheduler,
  of,
} from "rxjs";
import { describe, expect, it } from "vite-plus/test";

/** Advance the virtual clock by `ms`, stopping at the target frame. */
function advanceBy(scheduler: VirtualTimeScheduler, ms: number): void {
  const target = scheduler.frame + ms;
  scheduler.maxFrames = target;
  scheduler.schedule(() => {}, ms);
  scheduler.flush();
}

/** Let queued microtasks (promise `.then` chains) run to completion. */
async function drainMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

/**
 * A `fetch` whose promises are resolved by the test. Each call is recorded with
 * its `AbortSignal` and a `resolve`/`reject` pair, so a test can hold a request
 * in flight, fire more triggers, then settle it on demand.
 */
function deferredFetch<T>() {
  const calls: Array<{
    signal: AbortSignal;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
  }> = [];
  const fetch = (signal: AbortSignal): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      calls.push({ signal, resolve, reject });
    });
  return { fetch, calls };
}

function collect<T>(observable: Observable<T>): {
  values: T[];
  subscription: { unsubscribe(): void };
} {
  const values: T[] = [];
  const subscription = observable.subscribe((value) => values.push(value));
  return { values, subscription };
}

function newScheduler(): VirtualTimeScheduler {
  return new VirtualTimeScheduler(VirtualAction, Infinity);
}

describe("createPoll (fixed-rate)", () => {
  it("fetches once per interval tick", async () => {
    const scheduler = newScheduler();
    const { fetch, calls } = deferredFetch<string>();
    const { values } = collect(
      createPoll({
        strategy: "fixed-rate",
        interval$: of(30_000),
        fetch,
        scheduler,
      }),
    );

    advanceBy(scheduler, 30_000);
    expect(calls).toHaveLength(1);
    calls[0].resolve("a");
    await drainMicrotasks();

    advanceBy(scheduler, 30_000);
    expect(calls).toHaveLength(2);
    calls[1].resolve("b");
    await drainMicrotasks();

    expect(values).toEqual(["a", "b"]);
  });

  it("does not double-fetch when a wakeup lands mid-flight (F4)", async () => {
    const scheduler = newScheduler();
    const { fetch, calls } = deferredFetch<string>();
    const wakeups$ = new Subject<void>();
    const { values } = collect(
      createPoll({
        strategy: "fixed-rate",
        interval$: of(30_000),
        wakeups$,
        fetch,
        scheduler,
      }),
    );

    advanceBy(scheduler, 30_000);
    expect(calls).toHaveLength(1);

    // Two wakeups while the first fetch is still in flight: exhaustMap drops
    // both rather than starting a concurrent request.
    wakeups$.next();
    wakeups$.next();
    expect(calls).toHaveLength(1);

    calls[0].resolve("a");
    await drainMicrotasks();
    expect(values).toEqual(["a"]);

    // The loop stays live: the next interval tick fetches again.
    advanceBy(scheduler, 30_000);
    expect(calls).toHaveLength(2);
  });

  it("fires an immediate fetch on a wakeup once no fetch is in flight", async () => {
    const scheduler = newScheduler();
    const { fetch, calls } = deferredFetch<string>();
    const wakeups$ = new Subject<void>();
    collect(
      createPoll({
        strategy: "fixed-rate",
        interval$: of(30_000),
        wakeups$,
        fetch,
        scheduler,
      }),
    );

    // No timer advance: the wakeup alone drives the fetch.
    wakeups$.next();
    expect(calls).toHaveLength(1);
  });

  it("skips a tick while the gate is closed but keeps the cadence", async () => {
    const scheduler = newScheduler();
    const active$ = new BehaviorSubject(true);
    const { fetch, calls } = deferredFetch<string>();
    collect(
      createPoll({
        strategy: "fixed-rate",
        interval$: of(30_000),
        active$,
        fetch,
        scheduler,
      }),
    );

    // Frame 30_000: active, fetch fires.
    advanceBy(scheduler, 30_000);
    expect(calls).toHaveLength(1);
    calls[0].resolve("a");
    await drainMicrotasks();

    // Close the gate (true->false is not a rise, so no immediate tick).
    active$.next(false);
    // Frame 60_000: tick dropped, no fetch.
    advanceBy(scheduler, 30_000);
    expect(calls).toHaveLength(1);

    // Re-open the gate: the false->true rise fires one immediate fetch.
    active$.next(true);
    expect(calls).toHaveLength(2);
    calls[1].resolve("b");
    await drainMicrotasks();

    // The periodic timer was never torn down: its frame-90_000 tick still fires.
    advanceBy(scheduler, 30_000);
    expect(calls).toHaveLength(3);
  });

  it("pauses when interval$ emits null and resumes on a new cadence", async () => {
    const scheduler = newScheduler();
    const interval$ = new BehaviorSubject<number | null>(null);
    const { fetch, calls } = deferredFetch<string>();
    collect(
      createPoll({
        strategy: "fixed-rate",
        interval$,
        fetch,
        scheduler,
      }),
    );

    // Paused: no timer scheduled, advancing does nothing.
    advanceBy(scheduler, 120_000);
    expect(calls).toHaveLength(0);

    interval$.next(30_000);
    advanceBy(scheduler, 30_000);
    expect(calls).toHaveLength(1);
    calls[0].resolve("a");
    await drainMicrotasks();

    // Pause again: cadence stops.
    interval$.next(null);
    advanceBy(scheduler, 120_000);
    expect(calls).toHaveLength(1);
  });

  it("aborts an in-flight fetch when the interval changes and restarts at the new cadence", async () => {
    const scheduler = newScheduler();
    const interval$ = new BehaviorSubject<number | null>(30_000);
    const { fetch, calls } = deferredFetch<string>();
    collect(
      createPoll({
        strategy: "fixed-rate",
        interval$,
        fetch,
        scheduler,
      }),
    );

    advanceBy(scheduler, 30_000);
    expect(calls).toHaveLength(1);
    expect(calls[0].signal.aborted).toBe(false);

    // A new cadence tears down the running loop, aborting the in-flight fetch.
    interval$.next(10_000);
    expect(calls[0].signal.aborted).toBe(true);

    advanceBy(scheduler, 10_000);
    expect(calls).toHaveLength(2);
  });

  it("swallows a rejected fetch and keeps polling", async () => {
    const scheduler = newScheduler();
    const errors: unknown[] = [];
    let call = 0;
    const fetch = (): Promise<string> => {
      call += 1;
      return call === 1 ? Promise.reject(new Error("boom")) : Promise.resolve("ok");
    };
    const { values } = collect(
      createPoll({
        strategy: "fixed-rate",
        interval$: of(30_000),
        fetch,
        scheduler,
        onError: (error) => errors.push(error),
      }),
    );

    advanceBy(scheduler, 30_000);
    await drainMicrotasks();
    expect(errors).toHaveLength(1);
    expect(values).toEqual([]);

    // The stream survived the rejection: the next tick fetches and emits.
    advanceBy(scheduler, 30_000);
    await drainMicrotasks();
    expect(values).toEqual(["ok"]);
  });

  it("aborts the in-flight fetch on unsubscribe", () => {
    const scheduler = newScheduler();
    const { fetch, calls } = deferredFetch<string>();
    const { subscription } = collect(
      createPoll({
        strategy: "fixed-rate",
        interval$: of(30_000),
        fetch,
        scheduler,
      }),
    );

    advanceBy(scheduler, 30_000);
    expect(calls).toHaveLength(1);
    expect(calls[0].signal.aborted).toBe(false);

    subscription.unsubscribe();
    expect(calls[0].signal.aborted).toBe(true);
  });
});

describe("createPoll (after-settle)", () => {
  it("measures the gap after the fetch settles, never overlapping", async () => {
    const scheduler = newScheduler();
    const { fetch, calls } = deferredFetch<string>();
    const { values } = collect(
      createPoll({
        strategy: "after-settle",
        interval$: of(2_000),
        fetch,
        scheduler,
      }),
    );

    // First tick after one interval.
    advanceBy(scheduler, 2_000);
    expect(calls).toHaveLength(1);

    // While the fetch is in flight, further time does not start a second fetch:
    // the next gap is not armed until this one settles.
    advanceBy(scheduler, 10_000);
    expect(calls).toHaveLength(1);

    calls[0].resolve("a");
    await drainMicrotasks();
    expect(values).toEqual(["a"]);

    // The next interval is measured from settle: only after another 2_000ms.
    advanceBy(scheduler, 1_999);
    expect(calls).toHaveLength(1);
    advanceBy(scheduler, 1);
    expect(calls).toHaveLength(2);
  });

  it("pauses when interval$ emits null", async () => {
    const scheduler = newScheduler();
    const interval$ = new BehaviorSubject<number | null>(2_000);
    const { fetch, calls } = deferredFetch<string>();
    collect(
      createPoll({
        strategy: "after-settle",
        interval$,
        fetch,
        scheduler,
      }),
    );

    advanceBy(scheduler, 2_000);
    expect(calls).toHaveLength(1);
    calls[0].resolve("a");
    await drainMicrotasks();

    interval$.next(null);
    advanceBy(scheduler, 120_000);
    expect(calls).toHaveLength(1);
  });

  it("aborts the in-flight fetch on unsubscribe", () => {
    const scheduler = newScheduler();
    const { fetch, calls } = deferredFetch<string>();
    const { subscription } = collect(
      createPoll({
        strategy: "after-settle",
        interval$: of(2_000),
        fetch,
        scheduler,
      }),
    );

    advanceBy(scheduler, 2_000);
    expect(calls).toHaveLength(1);
    expect(calls[0].signal.aborted).toBe(false);

    subscription.unsubscribe();
    expect(calls[0].signal.aborted).toBe(true);
  });
});

describe("fetchLatest", () => {
  it("emits the run's output for each input", () => {
    const inputs$ = new Subject<string>();
    const { values } = collect(fetchLatest(inputs$, (input) => of(`ran:${input}`)));

    inputs$.next("a");
    inputs$.next("b");
    expect(values).toEqual(["ran:a", "ran:b"]);
  });

  it("aborts the prior request when a new input arrives", () => {
    const inputs$ = new Subject<string>();
    const seen: Array<{ input: string; signal: AbortSignal }> = [];
    const run = (input: string, signal: AbortSignal): Observable<string> => {
      seen.push({ input, signal });
      return NEVER;
    };
    collect(fetchLatest(inputs$, run));

    inputs$.next("a");
    expect(seen).toHaveLength(1);
    expect(seen[0].signal.aborted).toBe(false);

    // A new input switches away from the prior run, aborting its signal.
    inputs$.next("b");
    expect(seen[0].signal.aborted).toBe(true);
    expect(seen[1].signal.aborted).toBe(false);
  });

  it("aborts the in-flight request on unsubscribe", () => {
    const inputs$ = new Subject<string>();
    const seen: AbortSignal[] = [];
    const { subscription } = collect(
      fetchLatest(inputs$, (_input, signal) => {
        seen.push(signal);
        return NEVER;
      }),
    );

    inputs$.next("a");
    expect(seen).toHaveLength(1);
    expect(seen[0].aborted).toBe(false);

    subscription.unsubscribe();
    expect(seen[0].aborted).toBe(true);
  });
});

/**
 * Framework-agnostic polling and fetch-on-input primitives.
 *
 * Pure RxJS plus `AbortController`. No `document`/`window`/`Date.now()`: every
 * DOM or clock signal is injected (`interval$`, `active$`, `wakeups$`,
 * `scheduler`), so the primitives are Node-testable and virtual-time-total. A
 * discriminated union on `strategy` keeps the API honest - `active$`/`wakeups$`
 * exist only on `fixed-rate`, because the after-settle consumers re-arm through
 * dedicated store actions rather than the poll loop.
 *
 * Source stores wire their fetch/timer machinery through `createPoll`, and
 * fetch-on-input-change flows (catalog scope resolution) through `fetchLatest`.
 */

import {
  EMPTY,
  catchError,
  concatMap,
  defer,
  distinctUntilChanged,
  exhaustMap,
  filter,
  finalize,
  from,
  merge,
  of,
  pairwise,
  repeat,
  switchMap,
  timer,
  withLatestFrom,
  type Observable,
  type SchedulerLike,
} from "rxjs";

interface PollBase<T> {
  /** One request. `signal` aborts on teardown or interval supersede. */
  fetch: (signal: AbortSignal) => Promise<T>;
  /**
   * ms cadence; `null` pauses the loop (unsubscribes it). Model dynamic
   * policy as this stream - a new value tears down the current loop and
   * restarts at the new cadence.
   */
  interval$: Observable<number | null>;
  /** Injected clock for every timer. Omit to use the default async scheduler. */
  scheduler?: SchedulerLike;
  /** Rejected fetch. The loop continues; errors never kill the stream. */
  onError?: (error: unknown) => void;
}

export interface AfterSettlePoll<T> extends PollBase<T> {
  strategy: "after-settle";
}

export interface FixedRatePoll<T> extends PollBase<T> {
  strategy: "fixed-rate";
  /**
   * Per-tick gate; must emit synchronously on subscribe. `false` skips the
   * tick but keeps the cadence running; a `false`->`true` edge fires one
   * immediate tick.
   */
  active$?: Observable<boolean>;
  /**
   * Extra immediate triggers (focus, manual retry). Funnels through the SAME
   * `exhaustMap` as the cadence, so a wakeup mid-fetch is dropped, never a
   * second concurrent request.
   */
  wakeups$?: Observable<unknown>;
}

export type PollDefinition<T> = AfterSettlePoll<T> | FixedRatePoll<T>;

/**
 * Build a polling observable. The two strategies differ only in when the next
 * tick is measured:
 *
 * - `fixed-rate`: a wall-clock cadence. The interval tick, the gate rise, and
 *   any wakeups share ONE `exhaustMap`, so overlapping triggers collapse into
 *   a single in-flight guard (reproduces a hand-rolled `pollInFlight` boolean).
 * - `after-settle`: the gap is measured AFTER each fetch settles, via
 *   `concatMap` + `repeat`, so slow fetches cannot overlap and cannot be
 *   perturbed by wakeups.
 *
 * Either way, `interval$` drives an outer `switchMap`: a new cadence (or
 * `null`) tears down the running loop and aborts any in-flight fetch.
 */
export function createPoll<T>(def: PollDefinition<T>): Observable<T> {
  const runOnce = (): Observable<T> =>
    defer(() => {
      const controller = new AbortController();
      return from(def.fetch(controller.signal)).pipe(
        // Aborts on unsubscribe (teardown, interval supersede) and on settle.
        finalize(() => controller.abort()),
        catchError((error) => {
          def.onError?.(error);
          return EMPTY;
        }),
      );
    });

  if (def.strategy === "fixed-rate") {
    const active$ = (def.active$ ?? of(true)).pipe(distinctUntilChanged());
    // A gate rise (`false`->`true`) fires an immediate tick; a fall does not.
    const gateRise$ = active$.pipe(
      pairwise(),
      filter(([prev, next]) => !prev && next),
    );
    const wakeups$ = def.wakeups$ ?? EMPTY;

    return def.interval$.pipe(
      distinctUntilChanged(),
      switchMap((ms) => {
        if (ms === null) return EMPTY;
        // One flattening operator: interval tick, gate rise, and wakeups share
        // one in-flight guard. `withLatestFrom(active$)` + `filter` drops a
        // tick while the gate is closed without stopping the cadence.
        return merge(timer(ms, ms, def.scheduler), gateRise$, wakeups$).pipe(
          withLatestFrom(active$),
          filter(([, isActive]) => isActive),
          exhaustMap(() => runOnce()),
        );
      }),
    );
  }

  return def.interval$.pipe(
    distinctUntilChanged(),
    switchMap((ms) => {
      if (ms === null) return EMPTY;
      // `timer(ms)` then one fetch; the sequence completes on settle whether or
      // not it emitted (a swallowed rejection emits nothing), and `repeat()`
      // re-arms on completion. Re-arming on emission instead would let a single
      // failed fetch kill the loop.
      return timer(ms, def.scheduler).pipe(
        concatMap(() => runOnce()),
        repeat(),
      );
    }),
  );
}

/**
 * One-shot abortable latest - for fetch-on-input-change (catalog scope). A new
 * input `switchMap`s away the prior request, and `finalize` aborts its signal.
 * Kept separate from `createPoll`: this is not a poll, it is a cancel-and-refetch
 * on input identity change.
 */
export function fetchLatest<I, T>(
  inputs$: Observable<I>,
  run: (input: I, signal: AbortSignal) => Observable<T>,
): Observable<T> {
  return inputs$.pipe(
    switchMap((input) =>
      defer(() => {
        const controller = new AbortController();
        return run(input, controller.signal).pipe(finalize(() => controller.abort()));
      }),
    ),
  );
}

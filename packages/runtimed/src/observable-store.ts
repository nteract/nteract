/**
 * Framework-agnostic observable store base.
 *
 * `RuntimeStateStore`'s spine, generalized: one `BehaviorSubject` of `T`
 * plus a loaded gate, a synchronous snapshot, and a fluent, deduplicated
 * `select()`. Source stores (cloud viewer auth, access-request, catalog,
 * workstations) extend this and expose their own named public mutators over
 * the protected setters; the base never learns what any store's `T` means.
 *
 * No framework dependency, so subclasses and their projections stay testable
 * headlessly. React binding lives in the apps
 * (`src/components/notebook/state/observable-binding.ts`).
 */

import { BehaviorSubject, distinctUntilChanged, map, type Observable } from "rxjs";

/**
 * Deduped projection off any source observable. The exact body of
 * `RuntimeStateStore.select`, hoisted so stores and ad-hoc pipelines share
 * one impl. `equals` defaults to `Object.is`; pass a named structural
 * comparator when the projector allocates (see the equality convention
 * below).
 */
export function select<S, T>(
  source$: Observable<S>,
  project: (state: S) => T,
  equals: (a: T, b: T) => boolean = Object.is,
): Observable<T> {
  return source$.pipe(map(project), distinctUntilChanged(equals));
}

/**
 * Equality convention for `select`/`distinctUntilChanged` comparators.
 *
 * When a projector allocates (returns a fresh object each tick), pass a
 * named field-by-field `fooEquals(a, b)` comparator so a subscriber
 * re-renders only when a field actually changes. Short-circuit on `a === b`,
 * then compare every field. Nested allocated sub-objects get their own named
 * sub-comparator referenced from the parent, never a deep-equal or JSON pass.
 *
 * Back each comparator with a colocated completeness tripwire:
 *
 * ```ts
 * function fooEquals(a: Foo, b: Foo): boolean {
 *   return a === b || (a.mode === b.mode && a.scope === b.scope);
 * }
 * // Adding a field to `Foo` breaks this manifest's typecheck, flagging the
 * // comparator for update.
 * const _FOO_FIELDS = { mode: true, scope: true } satisfies Record<keyof Foo, true>;
 * ```
 *
 * The manifest forces every *key* to be listed, so a new field fails the
 * build. It does not force the comparator *body* to read each listed key, so
 * "field added -> manifest breaks -> update the comparator body" is a review
 * step, not an automatic guarantee. Reserve `stableCacheKey`/JSON
 * (`projection-cache.ts`) for LRU cache keys, never `distinctUntilChanged`.
 */
export class ObservableStore<T> {
  protected readonly _state$: BehaviorSubject<T>;
  private readonly _loaded$ = new BehaviorSubject<boolean>(false);

  /** Every state pushed since construction, starting with `initial`. */
  readonly state$: Observable<T>;

  /**
   * Whether a real state has been applied since construction/reset. While
   * false, the current value is the `initial`/`defaultState` and must not be
   * treated as authoritative.
   */
  readonly loaded$: Observable<boolean>;

  constructor(initial: T) {
    // `_state$` is constructor-seeded, so the derived observables are wired
    // here rather than as field initializers - a field initializer runs
    // before this body and would read `_state$` while still undefined.
    this._state$ = new BehaviorSubject<T>(initial);
    this.state$ = this._state$.asObservable();
    this.loaded$ = this._loaded$.pipe(distinctUntilChanged());
  }

  /**
   * Fluent projection builder: derive a slice of `T` and emit it only when
   * it changes. `equals` defaults to `Object.is`; pass a named comparator
   * when the projector allocates.
   */
  select<U>(project: (s: T) => U, equals: (a: U, b: U) => boolean = Object.is): Observable<U> {
    return select(this._state$, project, equals);
  }

  /** Current state (synchronous, non-reactive). */
  get snapshot(): T {
    return this._state$.getValue();
  }

  /** Whether a real state has been applied since construction/reset. */
  get isLoaded(): boolean {
    return this._loaded$.getValue();
  }

  /** Apply a new state and mark loaded. Subclasses wrap this in named mutators. */
  protected setState(next: T): void {
    this._loaded$.next(true);
    this._state$.next(next);
  }

  /** Derive the next state from the current snapshot, then `setState`. */
  protected updateState(project: (cur: T) => T): void {
    this.setState(project(this.snapshot));
  }

  /** Reset to a default state and mark unloaded (disconnect, sign-out). */
  protected resetState(defaultState: T): void {
    this._loaded$.next(false);
    this._state$.next(defaultState);
  }
}

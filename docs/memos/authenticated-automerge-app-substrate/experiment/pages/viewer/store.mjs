// One authoritative value with deduplicated projections.
//
// Streams read `select(project, equals)`; React reads `useStore`. Both emit
// the current value synchronously, then only when the projection changes.
// Pass a named comparator as `equals` when `project` allocates.

import { useCallback, useRef, useSyncExternalStore } from "react";
import { BehaviorSubject, distinctUntilChanged, map } from "rxjs";

export class Store {
  #subject;
  #current;
  #pending = [];
  #emitting = false;

  constructor(initial) {
    this.#current = initial;
    this.#subject = new BehaviorSubject(initial);
    this.state$ = this.#subject.asObservable();
  }

  /** The latest value, including one a subscriber is still being told about. */
  snapshot() {
    return this.#current;
  }

  /** Replace the value with `fn(current)`. Returning `current` emits nothing.
   * An update made while subscribers are being notified waits until they have
   * all seen the earlier value, so every subscriber sees values in order. */
  update(fn) {
    const next = fn(this.#current);
    if (Object.is(next, this.#current)) return next;
    this.#current = next;
    this.#pending.push(next);
    if (this.#emitting) return next;
    this.#emitting = true;
    try {
      while (this.#pending.length > 0) this.#subject.next(this.#pending.shift());
    } finally {
      this.#emitting = false;
    }
    return next;
  }

  select(project, equals = Object.is) {
    return this.#subject.pipe(map(project), distinctUntilChanged(equals));
  }
}

const identity = (value) => value;

/** Read `project(store.snapshot())` in a component. The component re-renders
 * only when `equals` says the projection changed; `project` may be inline. */
export function useStore(store, project = identity, equals = Object.is) {
  const memo = useRef(null);
  const subscribe = useCallback(
    (onChange) => {
      const subscription = store.state$.subscribe(onChange);
      return () => subscription.unsubscribe();
    },
    [store],
  );
  const getSnapshot = () => {
    const state = store.snapshot();
    const last = memo.current;
    if (last && last.store === store && last.state === state && last.project === project)
      return last.value;
    const projected = project(state);
    const value =
      last && last.store === store && equals(last.value, projected) ? last.value : projected;
    memo.current = { store, state, project, value };
    return value;
  };
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

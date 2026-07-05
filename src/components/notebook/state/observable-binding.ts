/**
 * Tearing-safe `useSyncExternalStore` binding for synchronous observables.
 *
 * INTERNAL plumbing for store hook modules. Components and views never import
 * from here; they consume named domain hooks (`useRuntimeState`,
 * `useCloudAuthState`, ...) defined next to each store's projections. A store
 * hook module wraps `useObservableProjection` around a stable, module-level
 * projection observable so the WeakMap binding cache below stays hot. Calling
 * `useObservableProjection` with an inline `store.select(...)` per render
 * allocates a fresh observable each render, misses the cache, and churns
 * subscriptions - that is why this is not the advertised component-facing API.
 *
 * There is exactly one implementation of this binding. Both the desktop and
 * cloud apps route their store hooks through it.
 */

import { useSyncExternalStore } from "react";

export interface SynchronousObservable<T> {
  subscribe(callback: (value: T) => void): { unsubscribe(): void };
}

/**
 * Per-observable binding cache so `getSnapshot` returns the same value between
 * emissions. `useSyncExternalStore` requires snapshot stability to avoid render
 * loops. Store projections emit synchronously on subscribe, so the first
 * subscription seeds the cached value.
 */
const projectionCache = new WeakMap<
  SynchronousObservable<unknown>,
  { subscribe: (cb: () => void) => () => void; getSnapshot: () => unknown }
>();

export function bindingFor<T>(observable: SynchronousObservable<T>): {
  subscribe: (cb: () => void) => () => void;
  getSnapshot: () => T;
} {
  let binding = projectionCache.get(observable as SynchronousObservable<unknown>);
  if (!binding) {
    let current: unknown;
    const seed = observable.subscribe((value) => {
      current = value;
    });
    seed.unsubscribe();
    binding = {
      subscribe: (cb: () => void) => {
        const sub = observable.subscribe((value) => {
          current = value;
          cb();
        });
        return () => sub.unsubscribe();
      },
      getSnapshot: () => current,
    };
    projectionCache.set(observable as SynchronousObservable<unknown>, binding);
  }
  return binding as { subscribe: (cb: () => void) => () => void; getSnapshot: () => T };
}

/**
 * Subscribe a React component to a projection observable. The observable must
 * emit synchronously on subscribe. INTERNAL: store hook modules build named
 * domain hooks over this; components consume those hooks, not this function.
 */
export function useObservableProjection<T>(observable: SynchronousObservable<T>): T {
  const binding = bindingFor(observable);
  return useSyncExternalStore(binding.subscribe, binding.getSnapshot, binding.getSnapshot);
}

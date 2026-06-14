import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { Observable } from "rxjs";

export interface CloudFactsProjectionStore<TSource, TProjection> {
  readonly projection$: Observable<TProjection>;
  readonly snapshot: TProjection;
  set(next: TSource): void;
}

/**
 * React adapter for cloud facts stores.
 *
 * Source facts still live in React state and host fetch lifecycles. The store
 * owns the stable derived projection and selector boundary.
 */
export function useCloudFactsProjection<TSource, TProjection>(
  source: TSource,
  createStore: (initial: TSource) => CloudFactsProjectionStore<TSource, TProjection>,
): TProjection {
  const storeRef = useRef<CloudFactsProjectionStore<TSource, TProjection> | null>(null);
  if (storeRef.current === null) {
    storeRef.current = createStore(source);
  }
  const store = storeRef.current;

  useLayoutEffect(() => {
    store.set(source);
  }, [store, source]);

  const subscribe = useCallback(
    (callback: () => void) => {
      const subscription = store.projection$.subscribe(() => callback());
      return () => subscription.unsubscribe();
    },
    [store],
  );
  const getSnapshot = useCallback(() => store.snapshot, [store]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

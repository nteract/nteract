/**
 * Runtime state store — reactive state from RuntimeStateDoc snapshots.
 *
 * The pure RxJS store and projections live in the `runtimed` package. This
 * shared notebook module instantiates the app-wide store and adds React
 * bindings on top, so Desktop and Cloud consume the same projection pipeline
 * without importing through either app.
 */

import { useSyncExternalStore } from "react";

export type {
  CommDocEntry,
  EnvState,
  ExecutionState,
  ExecutionTransition,
  KernelState,
  QueueEntry,
  QueueState,
  RuntimeState,
  TrustState,
  WorkstationAttachmentState,
} from "runtimed";

export { DEFAULT_RUNTIME_STATE, diffExecutions } from "runtimed";

import {
  RuntimeStateStore,
  type RuntimeState,
  type RuntimeStatusKey,
  type WorkstationAttachmentState,
} from "runtimed";

interface SynchronousObservable<T> {
  subscribe(callback: (value: T) => void): { unsubscribe(): void };
}

/**
 * App-wide runtime-state store. Both the desktop sync bridge and the cloud
 * viewer session push daemon/runtime snapshots here; all projections
 * (kernelInfo$, queueState$, workstation$, throttledStatusKey$, ...) hang off
 * this instance.
 */
export const runtimeStateStore = new RuntimeStateStore();

/** Update the runtime state snapshot. Called by host sync pipelines. */
export function setRuntimeState(state: RuntimeState): void {
  runtimeStateStore.set(state);
}

/** Reset to default state, usually on disconnect or notebook switch. */
export function resetRuntimeState(): void {
  runtimeStateStore.reset();
}

/** Read the current snapshot without subscribing. */
export function getRuntimeState(): RuntimeState {
  return runtimeStateStore.snapshot;
}

/**
 * Whether a runtime snapshot has been applied since connect. Consumers that
 * make authoritative decisions from state must check this first: false means
 * the current snapshot is the default state, not a real read.
 */
export function isRuntimeStateLoaded(): boolean {
  return runtimeStateStore.isLoaded;
}

/**
 * Per-observable binding cache so `getSnapshot` returns the same value between
 * emissions. `useSyncExternalStore` requires snapshot stability to avoid render
 * loops. RuntimeStateStore projections emit synchronously on subscribe, so the
 * first subscription seeds the cached value.
 */
const projectionCache = new WeakMap<
  SynchronousObservable<unknown>,
  { subscribe: (cb: () => void) => () => void; getSnapshot: () => unknown }
>();

function bindingFor<T>(observable: SynchronousObservable<T>): {
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
 * Subscribe a React component to a projection observable from the shared store.
 * The observable must emit synchronously on subscribe.
 */
export function useRuntimeProjection<T>(observable: SynchronousObservable<T>): T {
  const binding = bindingFor(observable);
  return useSyncExternalStore(binding.subscribe, binding.getSnapshot, binding.getSnapshot);
}

/** Subscribe to the runtime state from RuntimeStateDoc. */
export function useRuntimeState(): RuntimeState {
  return useRuntimeProjection(runtimeStateStore.state$);
}

/**
 * Subscribe to the loaded flag. Re-renders on the transition from "no snapshot
 * yet" to "first snapshot applied" and back on reset.
 */
export function useRuntimeStateLoaded(): boolean {
  return useRuntimeProjection(runtimeStateStore.loaded$);
}

/**
 * Workstation attachment, deduplicated by the attachment cache key. Shared by
 * desktop and cloud.
 */
export function useWorkstationAttachment(): WorkstationAttachmentState | null {
  return useRuntimeProjection(runtimeStateStore.workstation$);
}

/**
 * Lifecycle status key with the busy flash suppressed by the shared
 * `throttleBusyStatus` pipeline.
 */
export function useThrottledStatusKey(): RuntimeStatusKey {
  return useRuntimeProjection(runtimeStateStore.throttledStatusKey$);
}

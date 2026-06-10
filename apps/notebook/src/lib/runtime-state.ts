/**
 * Runtime state store — reactive state from the daemon's RuntimeStateDoc.
 *
 * The reactive store and its projections live in the `runtimed` package
 * (`RuntimeStateStore`, pure RxJS, no React). This module instantiates the
 * app-wide store and adds the React bindings (useSyncExternalStore) on top,
 * so both desktop and cloud consume the same projection pipeline.
 */

import { useSyncExternalStore } from "react";

// Re-export all types from the package so existing imports work.
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

export {
  DEFAULT_RUNTIME_STATE,
  diffExecutions,
} from "runtimed";

import {
  RuntimeStateStore,
  type RuntimeState,
  type RuntimeStatusKey,
  type WorkstationAttachmentState,
} from "runtimed";
import type { Observable } from "rxjs";

// ── Store ────────────────────────────────────────────────────────────

/**
 * App-wide runtime-state store. Both the desktop sync bridge and the cloud
 * viewer session push daemon snapshots here; all projections
 * (kernelInfo$, queueState$, workstation$, throttledStatusKey$, …) hang
 * off this instance.
 */
export const runtimeStateStore = new RuntimeStateStore();

/** Update the runtime state snapshot. Called by the frame pipeline. */
export function setRuntimeState(state: RuntimeState): void {
  runtimeStateStore.set(state);
}

/** Reset to default state (e.g., on disconnect). */
export function resetRuntimeState(): void {
  runtimeStateStore.reset();
}

/** Read the current snapshot (non-reactive). */
export function getRuntimeState(): RuntimeState {
  return runtimeStateStore.snapshot;
}

/**
 * Whether the daemon has pushed at least one RuntimeStateDoc snapshot
 * since connect. Consumers that make authoritative decisions from state
 * (trust gates, dirty tracking) must check this first — a false value
 * means the current snapshot is `DEFAULT_RUNTIME_STATE`, not a real read.
 */
export function isRuntimeStateLoaded(): boolean {
  return runtimeStateStore.isLoaded;
}

// ── React bindings ───────────────────────────────────────────────────

/**
 * Per-observable binding cache so `getSnapshot` returns the same value
 * between emissions — `useSyncExternalStore` requires snapshot stability
 * to avoid render loops. Projections derive from a BehaviorSubject, so the
 * first subscription seeds the cached value synchronously.
 */
const projectionCache = new WeakMap<
  Observable<unknown>,
  { subscribe: (cb: () => void) => () => void; getSnapshot: () => unknown }
>();

function bindingFor<T>(observable: Observable<T>): {
  subscribe: (cb: () => void) => () => void;
  getSnapshot: () => T;
} {
  let binding = projectionCache.get(observable as Observable<unknown>);
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
    projectionCache.set(observable as Observable<unknown>, binding);
  }
  return binding as { subscribe: (cb: () => void) => () => void; getSnapshot: () => T };
}

/**
 * Subscribe a React component to a projection observable from the shared
 * store. The observable must emit synchronously on subscribe (all
 * `RuntimeStateStore` projections do).
 */
export function useRuntimeProjection<T>(observable: Observable<T>): T {
  const binding = bindingFor(observable);
  return useSyncExternalStore(binding.subscribe, binding.getSnapshot, binding.getSnapshot);
}

/**
 * Subscribe to the runtime state from the daemon's RuntimeStateDoc.
 *
 * Re-renders only when the daemon pushes a new state snapshot via
 * Automerge sync. The frontend never writes to this state.
 */
export function useRuntimeState(): RuntimeState {
  return useRuntimeProjection(runtimeStateStore.state$);
}

/**
 * Subscribe to the loaded flag. Re-renders on the transition from
 * "no snapshot yet" to "first snapshot applied" (and back on reset).
 */
export function useRuntimeStateLoaded(): boolean {
  return useRuntimeProjection(runtimeStateStore.loaded$);
}

/**
 * Workstation attachment, deduplicated by the attachment cache key —
 * re-renders only when attachment facts change, not on every daemon tick.
 * Shared by desktop and cloud (replaces cloud's shadow state; see
 * `shared-store-projection-convergence.md` item 2).
 */
export function useWorkstationAttachment(): WorkstationAttachmentState | null {
  return useRuntimeProjection(runtimeStateStore.workstation$);
}

/**
 * Lifecycle status key with the busy flash suppressed (the shared
 * `throttleBusyStatus` pipeline). This is the stream UI status chips
 * should render.
 */
export function useThrottledStatusKey(): RuntimeStatusKey {
  return useRuntimeProjection(runtimeStateStore.throttledStatusKey$);
}

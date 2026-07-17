/**
 * Runtime state store — reactive state from RuntimeStateDoc snapshots.
 *
 * The pure RxJS store and projections live in the `runtimed` package. This
 * shared notebook module instantiates the app-wide store and adds React
 * bindings on top, so Desktop and Cloud consume the same projection pipeline
 * without importing through either app.
 */

import { useObservableProjection, type SynchronousObservable } from "./observable-binding";

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
 * Runtime store's named domain binding. Subscribes a component to a projection
 * observable from the shared store; the observable must emit synchronously on
 * subscribe. Wraps the shared tearing-safe binding so the runtime projections
 * (`state$`, `loaded$`, `workstation$`, ...) route through one cache.
 */
export function useRuntimeProjection<T>(observable: SynchronousObservable<T>): T {
  return useObservableProjection(observable);
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
 * `throttleBusyStatus` pipeline. The underlying store gates reset windows on
 * `loaded$`, so reconnects retain the last loaded runtime status until fresh
 * RuntimeStateDoc data arrives.
 */
export function useThrottledStatusKey(): RuntimeStatusKey {
  return useRuntimeProjection(runtimeStateStore.throttledStatusKey$);
}

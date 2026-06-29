/**
 * Reactive runtime-state store — framework-agnostic projections over the
 * daemon's RuntimeStateDoc snapshots.
 *
 * One BehaviorSubject of `RuntimeState` plus fluent, deduplicated
 * projections. Hosts (desktop bridge, cloud viewer session) push snapshots
 * with `set()`; consumers subscribe to a projection observable or read the
 * synchronous snapshot. React bindings stay in the apps — this module has
 * no framework dependency, so projections are testable headlessly and any
 * future host (CLI, MCP surface) consumes the same streams.
 *
 * Why projections live here and not in `useMemo` chains: a `useMemo` on the
 * whole `RuntimeState` recomputes (and re-renders its component) on every
 * daemon tick, even when the projected slice is unchanged. A
 * `distinctUntilChanged` projection emits only when its slice actually
 * changes, and that dedup is shared by every subscriber instead of
 * re-derived per component instance. See
 * `docs/memos/shared-store-projection-convergence.md`.
 */

import {
  BehaviorSubject,
  Observable,
  defer,
  distinctUntilChanged,
  map,
  of,
  shareReplay,
  startWith,
  switchMap,
  timer,
} from "rxjs";
import {
  deriveEnvSyncState,
  deriveKernelInfo,
  deriveQueueState,
  runtimeStatusKey,
  RUNTIME_STATUS,
  type EnvSyncState,
  type KernelInfo,
  type DaemonQueueState,
  type RuntimeStatusKey,
} from "./derived-state";
import { notebookShellWorkstationAttachmentCacheKey } from "./notebook-shell-capabilities";
import {
  DEFAULT_RUNTIME_STATE,
  type RuntimeState,
  type WorkstationAttachmentState,
} from "./runtime-state";

/**
 * How long a `RUNNING_BUSY` transition is held back before being shown.
 * Quick execute→idle cycles complete inside this window, so the user never
 * sees a "busy" flash for trivial executions.
 */
export const BUSY_THROTTLE_MS = 60;

/**
 * Hold back `RUNNING_BUSY` so quick execute→idle cycles never flash "busy".
 *
 * Every non-busy key emits immediately and cancels any pending busy commit
 * (`switchMap` drops the in-flight timer). Only the busy key waits
 * [`BUSY_THROTTLE_MS`] before committing. This is the pipeline form of the
 * imperative `setTimeout` throttle that used to live in
 * `useDaemonKernel` — same UX, but shared, declarative, and testable with
 * virtual time.
 *
 * `scheduler` is injectable for tests (pass the TestScheduler's scheduler);
 * production callers omit it.
 */
export function throttleBusyStatus(
  scheduler?: Parameters<typeof timer>[1],
): (source: Observable<RuntimeStatusKey>) => Observable<RuntimeStatusKey> {
  return (source) =>
    source.pipe(
      switchMap((key) =>
        key === RUNTIME_STATUS.RUNNING_BUSY
          ? timer(BUSY_THROTTLE_MS, scheduler).pipe(map(() => key))
          : of(key),
      ),
      distinctUntilChanged(),
    );
}

/**
 * Reactive store over daemon RuntimeStateDoc snapshots.
 *
 * The store itself is host-agnostic: desktop's sync bridge and the cloud
 * viewer session both `set()` snapshots from `SyncEngine.runtimeState$`,
 * and both apps' React hooks subscribe to the same projections.
 */
export class RuntimeStateStore {
  private readonly _state$ = new BehaviorSubject<RuntimeState>(DEFAULT_RUNTIME_STATE);
  private readonly _loaded$ = new BehaviorSubject<boolean>(false);

  /** Every snapshot pushed by the host, starting with the default state. */
  readonly state$: Observable<RuntimeState> = this._state$.asObservable();

  /**
   * Whether the daemon has pushed at least one snapshot since
   * connect/reset. While false, the current snapshot is
   * `DEFAULT_RUNTIME_STATE` and fields like `trust.status` must not be
   * treated as authoritative (the default would fail-open trust gates).
   */
  readonly loaded$: Observable<boolean> = this._loaded$.pipe(distinctUntilChanged());

  /** Kernel type + env source. Emits only when the projection changes. */
  readonly kernelInfo$: Observable<KernelInfo> = this.select(deriveKernelInfo, kernelInfoEquals);

  /** Executing/queued entries. Emits only when queue membership changes. */
  readonly queueState$: Observable<DaemonQueueState> = this.select(
    deriveQueueState,
    queueStateEquals,
  );

  /**
   * Environment sync state (null = unknown: pre-launch, shutdown, error).
   * Emits only when sync status or the diff changes.
   */
  readonly envSyncState$: Observable<EnvSyncState | null> = this.select(
    deriveEnvSyncState,
    envSyncStateEquals,
  );

  /**
   * Raw lifecycle status key (no busy throttle). For UI status chips,
   * prefer [`RuntimeStateStore.throttledStatusKey$`].
   */
  readonly statusKey$: Observable<RuntimeStatusKey> = this.select((state) =>
    runtimeStatusKey(state.kernel.lifecycle),
  );

  /**
   * Lifecycle status key with the busy flash suppressed
   * ([`throttleBusyStatus`], window [`BUSY_THROTTLE_MS`]). This is the
   * stream UI status indicators should render.
   *
   * Shared (`shareReplay`) so all subscribers ride one throttle pipeline
   * and late subscribers get the current value synchronously. Seeded with
   * the raw key at first subscribe — matching the old hook, a mount during
   * a busy phase shows busy immediately; only *transitions* into busy are
   * held back.
   */
  readonly throttledStatusKey$: Observable<RuntimeStatusKey> = defer(() =>
    this.statusKey$.pipe(
      throttleBusyStatus(),
      startWith(runtimeStatusKey(this.snapshot.kernel.lifecycle)),
      distinctUntilChanged(),
    ),
  ).pipe(shareReplay({ bufferSize: 1, refCount: false }));

  /**
   * Workstation attachment, deduplicated by
   * [`notebookShellWorkstationAttachmentCacheKey`] so consumers re-render
   * only when attachment facts actually change — not on every daemon tick.
   * Replaces per-host shadow state (see
   * `shared-store-projection-convergence.md` item 2).
   */
  readonly workstation$: Observable<WorkstationAttachmentState | null> = this.select(
    (state) => state.workstation ?? null,
    (a, b) =>
      notebookShellWorkstationAttachmentCacheKey(a) ===
      notebookShellWorkstationAttachmentCacheKey(b),
  );

  /**
   * Fluent projection builder: derive a slice of `RuntimeState` and emit it
   * only when it changes. `equals` defaults to `Object.is`; pass a
   * structural comparator when the projector allocates.
   */
  select<T>(
    project: (state: RuntimeState) => T,
    equals: (a: T, b: T) => boolean = Object.is,
  ): Observable<T> {
    return this._state$.pipe(map(project), distinctUntilChanged(equals));
  }

  /** Current snapshot (synchronous, non-reactive). */
  get snapshot(): RuntimeState {
    return this._state$.getValue();
  }

  /** Whether a real snapshot has been applied since connect/reset. */
  get isLoaded(): boolean {
    return this._loaded$.getValue();
  }

  /** Push a new daemon snapshot. Host bridges call this. */
  set(state: RuntimeState): void {
    this._loaded$.next(true);
    this._state$.next(state);
  }

  /** Reset to the default state (disconnect, room change). */
  reset(): void {
    this._loaded$.next(false);
    this._state$.next(DEFAULT_RUNTIME_STATE);
  }
}

function kernelInfoEquals(a: KernelInfo, b: KernelInfo): boolean {
  return a.kernelType === b.kernelType && a.envSource === b.envSource;
}

function queueStateEquals(a: DaemonQueueState, b: DaemonQueueState): boolean {
  if (a.executing?.execution_id !== b.executing?.execution_id) return false;
  if (a.queued.length !== b.queued.length) return false;
  return a.queued.every((entry, i) => entry.execution_id === b.queued[i]?.execution_id);
}

function envSyncStateEquals(a: EnvSyncState | null, b: EnvSyncState | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a.inSync !== b.inSync) return false;
  if (a.diff === undefined || b.diff === undefined) return a.diff === b.diff;
  return (
    a.diff.channelsChanged === b.diff.channelsChanged &&
    a.diff.denoChanged === b.diff.denoChanged &&
    arrayEquals(a.diff.added, b.diff.added) &&
    arrayEquals(a.diff.removed, b.diff.removed)
  );
}

function arrayEquals(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

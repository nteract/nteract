/**
 * SyncEngine — transport-agnostic notebook sync engine.
 *
 * Owns all sync state between a local WASM NotebookHandle and the daemon:
 *   - Inbound frame processing (WASM demux → typed events)
 *   - Inline sync reply with rollback on transport failure
 *   - Explicit session-status tracking for notebook/runtime/load readiness
 *   - Coalescing buffer (32ms) for cell changesets
 *   - RuntimeStateDoc sync + execution lifecycle diffing
 *   - Debounced outbound flush of local CRDT mutations
 *
 * Emits typed RxJS observables that consumers subscribe to for
 * materialization, broadcast dispatch, presence routing, etc.
 *
 * Zero Tauri / React / browser dependencies.
 */

import {
  type SchedulerLike,
  bufferTime,
  concatMap,
  debounceTime,
  distinctUntilChanged,
  EMPTY,
  filter,
  from,
  interval,
  map,
  mergeMap,
  Observable,
  ReplaySubject,
  share,
  Subject,
  Subscription,
} from "rxjs";

import { type CommBroadcast, isCommBroadcast } from "./broadcast-types";
import { type CellChangeset, mergeChangesets } from "./cell-changeset";
import {
  type CommChanges,
  type CommDiffState,
  type ResolvedComm,
  detectUnresolvedOutputs,
  diffComms,
} from "./comm-diff";
import type {
  CommsState,
  CommentsProjection,
  ExecutionQueueProjection,
  ExecutionViewChangeset,
  FrameEvent,
  InitialLoadPhase,
  SessionStatus,
  SyncableHandle,
} from "./handle";
import type { PoolState } from "./pool-state";
import {
  type CommDocEntry,
  type ExecutionTransition,
  type RuntimeState,
  type ExecutionState,
  diffExecutions,
} from "./runtime-state";
import { createTextAttributionEvent } from "./text-attribution-event";
import { FrameType } from "./transport";
import type { NotebookTransport } from "./transport";

// ── Constants ────────────────────────────────────────────────────────

/** Coalescing window for incoming sync frames (ms). */
const COALESCE_MS = 32;

/** Debounce interval for outbound source sync (ms). */
const FLUSH_DEBOUNCE_MS = 20;

/** Maximum wait for a host transport to accept an outbound sync frame. */
const DEFAULT_FLUSH_DELIVERY_TIMEOUT_MS = 5000;

type FlushDocKey = "notebook" | "runtimeState" | "commsDoc" | "commentsDoc" | "pool";

// ── Logger interface ─────────────────────────────────────────────────

export interface SyncEngineLogger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

const nullLogger: SyncEngineLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export interface PresenceHeartbeatOptions {
  /** Interval in milliseconds between idle presence heartbeats. */
  intervalMs: number;

  /** Encode a Presence heartbeat payload using the caller's WASM module. */
  encode: () => Uint8Array;
}

function initialLoadPhaseName(phase: InitialLoadPhase): InitialLoadPhase["phase"] {
  return phase.phase;
}

function formatSessionStatus(status: SessionStatus): string {
  return `notebook=${status.notebook_doc} runtime=${status.runtime_state} load=${initialLoadPhaseName(status.initial_load)}`;
}

function isInitialLoadStreamingStatus(status: SessionStatus | null): boolean {
  return status?.initial_load.phase === "streaming";
}

// ── Comm state helpers ───────────────────────────────────────────────

/**
 * Backoff delays between text-blob fetch attempts, in milliseconds.
 *
 * Under "run all cells" load the daemon's blob write can race the
 * frontend's GET — especially for large pywidget `_py_render` payloads.
 * Three retries with exponential backoff covers that window without
 * stalling the UI for long on genuinely missing blobs.
 *
 * The first attempt is immediate (no entry). Each subsequent entry is
 * the delay *before* the next attempt.
 */
const TEXT_BLOB_RETRY_DELAYS_MS = [100, 300, 1000];

/** Sleep helper for `inlineTextBlobs` retry backoff. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * For each JSON path in `paths`, read the blob-server URL currently at that
 * position in `state`, fetch its body as text, and replace the URL with the
 * decoded string in place.
 *
 * Used by `projectComms` to resolve text blobs (e.g. anywidget `_py_render`
 * source code) that the WASM resolver left as URL strings — widget code
 * consumes synced string traits directly and can't fetch URLs on its own.
 *
 * Retries transient failures (network errors, 5xx) with exponential
 * backoff; gives up on 4xx (the blob genuinely isn't there). After all
 * attempts fail the URL stays in place and a warning is logged — the
 * widget will render broken, but better than throwing away the whole
 * comm emission.
 */
async function inlineTextBlobs(
  state: Record<string, unknown>,
  paths: string[][],
  logger: SyncEngineLogger,
): Promise<void> {
  if (paths.length === 0) return;
  await Promise.all(
    paths.map(async (path) => {
      const url = readPath(state, path);
      if (typeof url !== "string") return;
      const text = await fetchTextBlobWithRetry(url, logger);
      if (text !== null) {
        writePath(state, path, text);
      }
    }),
  );
}

/**
 * Fetch `url` as text, retrying transient failures.
 *
 * Returns the decoded body on success, or `null` after all retries are
 * exhausted. 4xx responses are treated as permanent and returned
 * immediately without retry (the daemon doesn't know about that hash).
 */
async function fetchTextBlobWithRetry(
  url: string,
  logger: SyncEngineLogger,
): Promise<string | null> {
  let lastReason = "";
  for (let attempt = 0; attempt <= TEXT_BLOB_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      await delay(TEXT_BLOB_RETRY_DELAYS_MS[attempt - 1]);
    }
    try {
      const res = await fetch(url);
      if (res.ok) {
        return await res.text();
      }
      lastReason = `HTTP ${res.status}`;
      // 4xx is permanent — don't burn retries.
      if (res.status >= 400 && res.status < 500) {
        logger.warn(`[sync-engine] text blob ${url} returned ${res.status}, giving up`);
        return null;
      }
    } catch (err) {
      lastReason = err instanceof Error ? err.message : String(err);
    }
  }
  logger.warn(
    `[sync-engine] text blob ${url} failed after ${TEXT_BLOB_RETRY_DELAYS_MS.length + 1} attempts: ${lastReason}`,
  );
  return null;
}

/** Read `obj[path[0]][path[1]]...` — returns undefined if any step is missing. */
function readPath(obj: unknown, path: string[]): unknown {
  let cursor: unknown = obj;
  for (const seg of path) {
    if (cursor == null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return cursor;
}

/** Write `value` at `obj[path[0]][path[1]]...`. No-op if the path is missing. */
function writePath(obj: unknown, path: string[], value: unknown): void {
  if (path.length === 0) return;
  let cursor: unknown = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (cursor == null || typeof cursor !== "object") return;
    cursor = (cursor as Record<string, unknown>)[path[i]];
  }
  if (cursor == null || typeof cursor !== "object") return;
  (cursor as Record<string, unknown>)[path[path.length - 1]] = value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRuntimeStateSnapshot(value: unknown): value is RuntimeState {
  return isRecord(value) && isRecord(value.comms);
}

function isCommsStateSnapshot(value: unknown): value is CommsState {
  return isRecord(value) && isRecord(value.comms);
}

function containsContentRef(value: unknown): boolean {
  if (!isRecord(value)) {
    return Array.isArray(value) ? value.some(containsContentRef) : false;
  }
  const keys = Object.keys(value);
  if (keys.length === 1 && Object.prototype.hasOwnProperty.call(value, "inline")) {
    return true;
  }
  if (
    typeof value.blob === "string" &&
    typeof value.size === "number" &&
    keys.every((key) => key === "blob" || key === "size" || key === "media_type")
  ) {
    return true;
  }
  return Object.values(value).some(containsContentRef);
}

// ── Options ──────────────────────────────────────────────────────────

export interface SyncEngineOptions {
  /**
   * Read the current WASM handle (null during bootstrap).
   *
   * A getter rather than a direct reference so the engine never holds
   * a stale handle across bootstrap cycles.
   */
  getHandle: () => SyncableHandle | null;

  /** Pluggable transport to the daemon. */
  transport: NotebookTransport;

  /** Required client-side idle heartbeat for keeping the daemon peer alive. */
  presenceHeartbeat: PresenceHeartbeatOptions;

  /** Optional logger (defaults to silent). */
  logger?: SyncEngineLogger;

  /** Optional RxJS scheduler for time-based operators (for testing). */
  scheduler?: SchedulerLike;

  /**
   * Maximum time to wait for outbound sync frame delivery.
   *
   * Save paths call flushAndWait(); execute paths normally fire a flush and
   * attach the current notebook heads as `required_heads` so the daemon can
   * wait until the document has caught up before it queues execution. Keeping
   * this bounded prevents a stuck host transport from permanently blocking a
   * caller that does need a delivery acknowledgement.
   */
  flushDeliveryTimeoutMs?: number;
}

// ── SyncEngine ───────────────────────────────────────────────────────

export class SyncEngine {
  private readonly opts: Required<
    Pick<SyncEngineOptions, "getHandle" | "transport" | "logger" | "presenceHeartbeat">
  > &
    Pick<SyncEngineOptions, "scheduler">;
  private readonly flushDeliveryTimeoutMs: number;
  private subscription: Subscription | null = null;
  private latestSessionStatus: SessionStatus | null = null;
  private prevExecutions: Record<string, ExecutionState> = {};
  private commDiffState: CommDiffState = { comms: {}, json: {} };
  private lastRuntimeState: RuntimeState | null = null;
  private lastCommsState: CommsState | null = null;
  /**
   * Serial queue for async comm emissions.
   *
   * `projectComms` is invoked synchronously from several observable
   * pipelines. Text blobs require HTTP fetches to the blob server, which
   * are async. Chaining each emission's async resolution onto this promise
   * preserves the order of `commChanges$` emissions regardless of which
   * fetch completes first.
   */
  private commEmitQueue: Promise<void> = Promise.resolve();

  // Internal subjects
  private readonly frameIn$ = new Subject<number[]>();
  private readonly flushRequest$ = new Subject<void>();
  /** The running pipeline's materialize subject (null while stopped). */
  private materializeIn: Subject<CellChangeset | null> | null = null;

  /** Delivery promises for fire-and-forget flushes that already claimed sync state. */
  private inflightFlushes = new Map<FlushDocKey, Promise<boolean>>();

  // ── Public observables ───────────────────────────────────────────

  /**
   * Coalesced cell changesets from inbound sync frames.
   *
   * Each emission is a merged CellChangeset covering a 32ms window,
   * or `null` when a full materialization is needed (no changeset
   * available from WASM).
   */
  readonly cellChanges$: Observable<CellChangeset | null>;

  /**
   * Daemon broadcast payloads. Only Comm traffic (ipywidget messages,
   * custom widget events) flows here — kernel status, execution, outputs,
   * env progress, and text attributions all live in RuntimeStateDoc now.
   */
  readonly broadcasts$: Observable<unknown>;

  /** Remote peer presence updates (cursor, selection, snapshot, left, heartbeat). */
  readonly presence$: Observable<unknown>;

  /** RuntimeState snapshots from the daemon's RuntimeStateDoc. */
  readonly runtimeState$: Observable<RuntimeState>;

  /** PoolState snapshots from the daemon's PoolDoc (global pool state). */
  readonly poolState$: Observable<PoolState>;

  /** Execution lifecycle transitions detected from RuntimeState diffs. */
  readonly executionTransitions$: Observable<ExecutionTransition[]>;

  /**
   * Per-output changes emitted from the WASM runtime-state sync path.
   *
   * `changed` pairs carry the output_id with its already-narrowed manifest
   * (WASM applied MIME priority + ContentRef resolution). `removed_ids`
   * covers outputs no longer present in any execution. Consumers route
   * these into the per-output React store; no second state-doc lookup is
   * needed, so a stream append on one output only touches its own
   * `<Output>` subscriber.
   *
   * See `apps/notebook/src/lib/notebook-outputs.ts`.
   */
  readonly outputIdChanges$: Observable<{
    changed: Array<[string, unknown]>;
    removed_ids: string[];
  }>;

  /** Cross-document execution materialized-view changes emitted by WASM. */
  readonly executionViewChanges$: Observable<ExecutionViewChangeset>;

  /**
   * Execution queue projection, deduplicated.
   *
   * The fluent surface for queue-only consumers (toolbar run indicators,
   * queue badges): emits the `queue` field of [`executionViewChanges$`]
   * only when queue membership actually changes, so per-output upserts and
   * pointer churn during a long execution never reach subscribers. Derived
   * from the same WASM-computed projection both hosts already receive —
   * no second diff.
   */
  readonly executionQueue$: Observable<ExecutionQueueProjection>;

  // ── Typed broadcast observables ──────────────────────────────────

  /** Custom comm messages (buttons, model.send()). */
  readonly commBroadcasts$: Observable<CommBroadcast>;

  /**
   * Comm state projection from RuntimeStateDoc topology + CommsDoc state.
   *
   * Emits resolved comm lifecycle changes (opened/updated/closed) with
   * ContentRef blobs replaced by URL strings. Subscribers drive their
   * widget store directly — no Jupyter message synthesis needed.
   *
   * Uses `handle.resolve_comm_state()` when available. Plain JSON CommsDoc
   * state that has no ContentRefs can project directly from document truth;
   * ContentRef-backed state defers until the host provides a resolver.
   */
  readonly commChanges$: Observable<CommChanges>;

  /** Durable comment thread projection from CommentsDoc. */
  readonly commentsProjection$: Observable<CommentsProjection>;

  /** Ordered bootstrap/readiness status emitted by the daemon. */
  readonly sessionStatus$: Observable<SessionStatus>;

  /**
   * Fires each time the notebook document becomes interactive.
   *
   * Emits once per bootstrap cycle when `SessionStatus.notebook_doc`
   * first reaches `interactive`. Consumers should do a full
   * materialization in response.
   */
  readonly initialSyncComplete$: Observable<void>;

  /**
   * Save hint: the notebook CRDT document may have changed.
   *
   * Emitted from two sources:
   * - the `sync_applied` pipeline when `changed=true` (remote changes), and
   * - the outbound flush path whenever `flush_local_changes()` yields bytes.
   *   Emission happens on the flush *attempt*, regardless of delivery
   *   success — `cancel_last_flush()` rolls back sync-state bookkeeping,
   *   not the document, and offline flush attempts are exactly the ones
   *   persistence must capture.
   *
   * The flush source can over-fire: `flush_local_changes()` also yields
   * bytes for protocol-only messages (the initial handshake on a fresh
   * sync state, resync negotiation), so an emission means "a sync message
   * was generated; the doc may have changed". It never under-fires for
   * committed local changes. Consumers must treat saves as idempotent —
   * throttle this signal and call `handle.save()` to snapshot the
   * `NotebookDoc` bytes for local storage.
   *
   * Note: only `NotebookDoc` bytes may seed a syncing handle —
   * `RuntimeStateDoc` is runtime-authoritative and must never be restored
   * into a regular client sync path. (A render-only RuntimeStateDoc paint
   * cache is the one storage exception; see `RUNTIME_STATE_CACHE_KEY_SEGMENT`.)
   */
  readonly notebookDocChanged$: Observable<void>;

  /**
   * Fires once per APPLIED inbound NotebookDoc sync frame, whether or not
   * the document changed.
   *
   * `cellChanges$` and `notebookDocChanged$` are silent for no-op
   * exchanges, but converging with a peer whose doc already matches ours
   * is exactly such an exchange — e.g. a hosted room at genesis answers
   * the bootstrap handshake with heads only and no changes. Hosts that
   * must act once the exchange settles (the cloud viewer polls
   * `notebook_doc_caught_up()` on each emission to let an authoritative
   * empty room displace painted content) listen here. Derived 1:1 from
   * the existing WASM `sync_applied` event — no second diff, no payload.
   */
  readonly notebookSyncApplied$: Observable<void>;

  // Backing subjects for public observables
  private readonly _cellChanges$ = new Subject<CellChangeset | null>();
  private readonly _broadcasts$ = new Subject<unknown>();
  private readonly _presence$ = new Subject<unknown>();
  private readonly _runtimeState$ = new Subject<RuntimeState>();
  private readonly _poolState$ = new Subject<PoolState>();
  private readonly _executionTransitions$ = new Subject<ExecutionTransition[]>();
  private readonly _sessionStatus$ = new ReplaySubject<SessionStatus>(1);
  private readonly _initialSyncComplete$ = new Subject<void>();
  private readonly _commChanges$ = new Subject<CommChanges>();
  private readonly _commentsProjection$ = new Subject<CommentsProjection>();
  private readonly _outputIdChanges$ = new Subject<{
    changed: Array<[string, unknown]>;
    removed_ids: string[];
  }>();
  private readonly _executionViewChanges$ = new Subject<ExecutionViewChangeset>();
  private readonly _notebookDocChanged$ = new Subject<void>();
  private readonly _notebookSyncApplied$ = new Subject<void>();

  constructor(opts: SyncEngineOptions) {
    this.opts = {
      ...opts,
      logger: opts.logger ?? nullLogger,
      scheduler: opts.scheduler,
    };
    this.flushDeliveryTimeoutMs = opts.flushDeliveryTimeoutMs ?? DEFAULT_FLUSH_DELIVERY_TIMEOUT_MS;

    // Expose as readonly Observable (hide Subject internals)
    this.cellChanges$ = this._cellChanges$.asObservable();
    this.broadcasts$ = this._broadcasts$.asObservable();
    this.presence$ = this._presence$.asObservable();
    this.runtimeState$ = this._runtimeState$.asObservable();
    this.poolState$ = this._poolState$.asObservable();
    this.executionTransitions$ = this._executionTransitions$.asObservable();
    this.sessionStatus$ = this._sessionStatus$.asObservable();
    this.initialSyncComplete$ = this._initialSyncComplete$.asObservable();
    this.commChanges$ = this._commChanges$.asObservable();
    this.commentsProjection$ = this._commentsProjection$.asObservable();
    this.outputIdChanges$ = this._outputIdChanges$.asObservable();
    this.executionViewChanges$ = this._executionViewChanges$.asObservable();
    this.notebookDocChanged$ = this._notebookDocChanged$.asObservable();
    this.notebookSyncApplied$ = this._notebookSyncApplied$.asObservable();

    // Typed broadcast sub-observables (derived from broadcasts$)
    this.commBroadcasts$ = this.broadcasts$.pipe(filter(isCommBroadcast));

    // Queue-only projection derived from the execution view changeset.
    this.executionQueue$ = this.executionViewChanges$.pipe(
      map((changeset) => changeset.queue),
      filter((queue): queue is ExecutionQueueProjection => queue != null),
      distinctUntilChanged(executionQueueEquals),
    );
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  /**
   * Start processing frames from the transport.
   *
   * Subscribes to the transport's frame listener and wires up all
   * internal RxJS pipelines. Call `stop()` to tear everything down.
   */
  start(): void {
    if (this.subscription) return; // already running
    this.opts.logger.info("[sync-engine] Starting");

    const sub = (this.subscription = new Subscription());
    const log = this.opts.logger;

    // Wire transport frames into the internal subject
    const unlisten = this.opts.transport.onFrame((payload) => {
      this.frameIn$.next(payload);
    });
    sub.add(() => unlisten());

    const sendHeartbeat = () => {
      let payload: Uint8Array;
      try {
        payload = this.opts.presenceHeartbeat.encode();
      } catch (e) {
        log.warn("[sync-engine] encode presence heartbeat failed:", e);
        return;
      }
      this.opts.transport
        .sendFrame(FrameType.PRESENCE, payload)
        .catch((e: unknown) => log.warn("[sync-engine] send presence heartbeat failed:", e));
    };

    sendHeartbeat();
    sub.add(
      interval(this.opts.presenceHeartbeat.intervalMs, this.opts.scheduler).subscribe(
        sendHeartbeat,
      ),
    );

    // Subject bridging sync_applied events into the coalescing buffer.
    // Held on the instance while running so applyLocalPeerChanges (the
    // cross-tab bridge apply) can route through the same coalesce →
    // cellChanges$ pipeline as inbound sync frames.
    const materialize$ = new Subject<CellChangeset | null>();
    this.materializeIn = materialize$;
    sub.add(() => {
      this.materializeIn = null;
      materialize$.complete();
    });

    // ── Source: frames → WASM demux → individual FrameEvents ──────

    let frameCount = 0;
    let lastFrameLogTime = Date.now();

    const frameEvents$ = this.frameIn$.pipe(
      mergeMap((payload) => {
        try {
          const handle = this.opts.getHandle();
          if (!handle) {
            log.debug("[sync-engine] frame dropped: no handle");
            return EMPTY;
          }
          const bytes = new Uint8Array(payload);
          const result = handle.receive_frame(bytes);
          if (!result || !Array.isArray(result)) return EMPTY;

          // Log frame throughput every 5 seconds
          frameCount++;
          const now = Date.now();
          if (now - lastFrameLogTime >= 5000) {
            log.debug(
              `[sync-engine] ${frameCount} frames processed in ${now - lastFrameLogTime}ms (${bytes.length}B last)`,
            );
            frameCount = 0;
            lastFrameLogTime = now;
          }

          return from(result as FrameEvent[]);
        } catch (e) {
          log.warn("[sync-engine] receive_frame failed:", e);
          return EMPTY;
        }
      }),
      share(),
    );

    // ── Sub-pipeline: session_control ──────────────────────────────

    sub.add(
      frameEvents$
        .pipe(filter((e) => e.type === "session_control" && e.status != null))
        .subscribe((e) => {
          const next = e.status as SessionStatus;
          const previous = this.latestSessionStatus;
          this.latestSessionStatus = next;
          this._sessionStatus$.next(next);

          if (previous?.notebook_doc !== "interactive" && next.notebook_doc === "interactive") {
            log.info(`[sync-engine] notebook interactive (${formatSessionStatus(next)})`);
            this._initialSyncComplete$.next();
          } else {
            log.debug(`[sync-engine] session status: ${formatSessionStatus(next)}`);
          }
        }),
    );

    // ── Sub-pipeline: sync_applied → coalesce ─────────────────────

    sub.add(
      frameEvents$
        .pipe(
          filter((e) => e.type === "sync_applied"),
          concatMap((e) => {
            // Attributions → broadcast
            if (e.attributions && e.attributions.length > 0) {
              this._broadcasts$.next(createTextAttributionEvent(e.attributions));
            }

            // Send inline sync reply
            if (e.reply) {
              this.opts.transport
                .sendFrame(FrameType.AUTOMERGE_SYNC, new Uint8Array(e.reply))
                .catch((err: unknown) => {
                  const handle = this.opts.getHandle();
                  if (handle) {
                    handle.cancel_last_flush();
                  }
                  log.warn(
                    "[sync-engine] inline sync reply send failed, rolled back sync state:",
                    err,
                  );
                });
            }

            if (e.changed) {
              const cs = e.changeset;
              if (cs) {
                log.debug(
                  `[sync-engine] changeset: ${cs.changed.length} changed, ${cs.added.length} added, ${cs.removed.length} removed, order_changed=${cs.order_changed}`,
                );
              } else {
                log.debug(
                  "[sync-engine] sync_applied with change but no changeset (full materialization needed)",
                );
              }
              if (isInitialLoadStreamingStatus(this.latestSessionStatus)) {
                log.debug("[sync-engine] streaming load changeset emitted without coalescing");
                this._cellChanges$.next(cs ?? null);
              } else {
                materialize$.next(cs ?? null);
              }
              this._notebookDocChanged$.next();
            }
            this.emitExecutionViewChanges(e.execution_view_changeset);
            // After the changed/reply handling: the handle has already
            // applied the frame (receive_frame is synchronous), so
            // subscribers polling handle facts see post-apply state.
            this._notebookSyncApplied$.next();
            return EMPTY;
          }),
        )
        .subscribe(),
    );

    // ── Coalescing buffer → cellChanges$ ──────────────────────────

    sub.add(
      materialize$
        .pipe(
          bufferTime(COALESCE_MS, this.opts.scheduler),
          filter((batch) => batch.length > 0),
          concatMap((batch) => {
            // Merge all changesets in the batch
            let merged: CellChangeset | null = null;
            let needsFull = false;

            for (const cs of batch) {
              if (cs === null) {
                needsFull = true;
              } else if (merged === null) {
                merged = cs;
              } else {
                merged = mergeChangesets(merged, cs);
              }
            }

            const result = needsFull ? null : merged;
            if (needsFull) {
              log.debug(
                `[sync-engine] coalesced ${batch.length} changesets → full materialization`,
              );
            } else if (result) {
              log.debug(
                `[sync-engine] coalesced ${batch.length} changesets → ${result.changed.length} changed, ${result.added.length} added, ${result.removed.length} removed`,
              );
            }
            this._cellChanges$.next(result);
            return EMPTY;
          }),
        )
        .subscribe(),
    );

    // ── Sub-pipeline: broadcasts ──────────────────────────────────

    sub.add(
      frameEvents$
        .pipe(filter((e) => e.type === "broadcast" && e.payload != null))
        .subscribe((e) => this._broadcasts$.next(e.payload)),
    );

    // ── Sub-pipeline: presence ────────────────────────────────────

    sub.add(
      frameEvents$
        .pipe(filter((e) => e.type === "presence" && e.payload != null))
        .subscribe((e) => this._presence$.next(e.payload)),
    );

    // ── Sub-pipeline: sync error recovery ──────────────────────────

    // Notebook doc sync error: send recovery reply + trigger materialization
    sub.add(
      frameEvents$.pipe(filter((e) => e.type === "sync_error")).subscribe((e) => {
        log.warn("[sync-engine] sync_error: doc rebuilt, sync state normalized");
        if (e.reply) {
          this.opts.transport
            .sendFrame(FrameType.AUTOMERGE_SYNC, new Uint8Array(e.reply))
            .catch((err: unknown) => {
              const handle = this.opts.getHandle();
              if (handle) handle.cancel_last_flush();
              log.warn("[sync-engine] recovery reply send failed:", err);
            });
        }
        // If the doc advanced before the error (partial apply),
        // trigger a full materialization so the UI reflects the
        // recovered state.
        if (e.changed) {
          materialize$.next(null);
        }
      }),
    );

    // Runtime state sync error: send recovery reply + publish state
    sub.add(
      frameEvents$.pipe(filter((e) => e.type === "runtime_state_sync_error")).subscribe((e) => {
        log.warn(
          "[sync-engine] runtime_state_sync_error: state doc rebuilt, sync state normalized",
        );
        if (e.reply) {
          this.opts.transport
            .sendFrame(FrameType.RUNTIME_STATE_SYNC, new Uint8Array(e.reply))
            .catch((err: unknown) => {
              const handle = this.opts.getHandle();
              if (handle) handle.cancel_last_runtime_state_flush();
              log.warn("[sync-engine] state recovery reply send failed:", err);
            });
        }
        // If the state doc advanced, publish the recovered snapshot
        // so kernel status / queue / execution UI stays current.
        if (e.changed && e.state) {
          const state = e.state as RuntimeState;
          const transitions = diffExecutions(this.prevExecutions, state.executions);
          this.prevExecutions = state.executions;
          this._runtimeState$.next(state);
          this.emitExecutionViewChanges(e.execution_view_changeset);
          if (transitions.length > 0) {
            this._executionTransitions$.next(transitions);
          }
          this.lastRuntimeState = state;
          this.projectComms();
        }
      }),
    );

    // ── Sub-pipeline: runtime state sync ──────────────────────────

    sub.add(
      frameEvents$
        .pipe(
          filter((e) => e.type === "runtime_state_sync_applied"),
          concatMap((e) => {
            if (e.changed && e.state) {
              const state = e.state as RuntimeState;

              // Diff executions for lifecycle transitions
              const transitions = diffExecutions(this.prevExecutions, state.executions);
              this.prevExecutions = state.executions;

              log.debug(
                `[sync-engine] runtime state: kernel=${state.kernel?.lifecycle?.lifecycle ?? "?"}, transitions=${transitions.length}`,
              );

              this._runtimeState$.next(state);
              // Publish output payloads before execution view pointers so a
              // cell render that follows a new output_id can read the payload
              // from the output store on its first pass.
              this.emitOutputIdChanges(e.output_changeset);
              this.emitExecutionViewChanges(e.execution_view_changeset);
              if (transitions.length > 0) {
                this._executionTransitions$.next(transitions);
              }

              // ── Comm state projection ──────────────────────────────
              this.lastRuntimeState = state;
              this.projectComms();
            }

            // Send sync reply so the daemon knows our heads
            const handle = this.opts.getHandle();
            if (handle) {
              try {
                const reply = handle.generate_runtime_state_sync_reply();
                if (reply) {
                  return from(
                    this.opts.transport
                      .sendFrame(FrameType.RUNTIME_STATE_SYNC, reply)
                      .catch((err: unknown) =>
                        log.warn("[sync-engine] runtime state sync reply failed:", err),
                      ),
                  );
                }
              } catch (err) {
                log.warn("[sync-engine] generate_runtime_state_sync_reply failed:", err);
              }
            }
            return EMPTY;
          }),
        )
        .subscribe(),
    );

    // ── Sub-pipeline: comms doc sync ───────────────────────────────

    sub.add(
      frameEvents$
        .pipe(
          filter((e) => e.type === "comms_doc_sync_applied"),
          concatMap((e) => {
            if (e.changed && e.state) {
              this.lastCommsState = e.state as CommsState;
              this.projectComms();
            }

            const handle = this.opts.getHandle();
            if (handle) {
              try {
                const reply = handle.generate_comms_doc_sync_reply();
                if (reply) {
                  return from(
                    this.opts.transport
                      .sendFrame(FrameType.COMMS_DOC_SYNC, reply)
                      .catch((err: unknown) =>
                        log.warn("[sync-engine] comms doc sync reply failed:", err),
                      ),
                  );
                }
              } catch (err) {
                log.warn("[sync-engine] generate_comms_doc_sync_reply failed:", err);
              }
            }
            return EMPTY;
          }),
        )
        .subscribe(),
    );

    // CommsDoc sync error: send recovery reply + publish recovered state
    sub.add(
      frameEvents$.pipe(filter((e) => e.type === "comms_doc_sync_error")).subscribe((e) => {
        log.warn("[sync-engine] comms_doc_sync_error: comms doc rebuilt, sync state normalized");
        if (e.reply) {
          this.opts.transport
            .sendFrame(FrameType.COMMS_DOC_SYNC, new Uint8Array(e.reply))
            .catch((err: unknown) => {
              const handle = this.opts.getHandle();
              if (handle) handle.cancel_last_comms_doc_flush();
              log.warn("[sync-engine] comms doc recovery reply send failed:", err);
            });
        }
        if (e.changed && e.state) {
          this.lastCommsState = e.state as CommsState;
          this.projectComms();
        }
      }),
    );

    // ── Sub-pipeline: comments doc sync ───────────────────────────

    sub.add(
      frameEvents$
        .pipe(
          filter((e) => e.type === "comments_doc_sync_applied"),
          concatMap((e) => {
            if (e.changed && e.projection) {
              this._commentsProjection$.next(e.projection);
            }

            const handle = this.opts.getHandle();
            const generateReply = handle?.generate_comments_doc_sync_reply;
            if (handle && generateReply) {
              try {
                const reply = generateReply.call(handle);
                if (reply) {
                  return from(
                    this.opts.transport
                      .sendFrame(FrameType.COMMENTS_DOC_SYNC, reply)
                      .catch((err: unknown) =>
                        log.warn("[sync-engine] comments doc sync reply failed:", err),
                      ),
                  );
                }
              } catch (err) {
                log.warn("[sync-engine] generate_comments_doc_sync_reply failed:", err);
              }
            }
            return EMPTY;
          }),
        )
        .subscribe(),
    );

    // CommentsDoc sync error: send recovery reply and publish recovered projection.
    sub.add(
      frameEvents$.pipe(filter((e) => e.type === "comments_doc_sync_error")).subscribe((e) => {
        log.warn(
          "[sync-engine] comments_doc_sync_error: comments doc rebuilt, sync state normalized",
        );
        if (e.reply) {
          this.opts.transport
            .sendFrame(FrameType.COMMENTS_DOC_SYNC, new Uint8Array(e.reply))
            .catch((err: unknown) => {
              const handle = this.opts.getHandle();
              handle?.cancel_last_comments_doc_flush?.();
              log.warn("[sync-engine] comments doc recovery reply send failed:", err);
            });
        }
        if (e.changed && e.projection) {
          this._commentsProjection$.next(e.projection);
        }
      }),
    );

    // ── Sub-pipeline: pool state sync ─────────────────────────────

    sub.add(
      frameEvents$
        .pipe(
          filter((e) => e.type === "pool_state_sync_applied"),
          concatMap((e) => {
            if (e.changed && e.state) {
              const state = e.state as PoolState;
              this._poolState$.next(state);
            }

            // Send sync reply so the daemon knows our heads
            const handle = this.opts.getHandle();
            if (handle) {
              try {
                const reply = handle.generate_pool_state_sync_reply();
                if (reply) {
                  return from(
                    this.opts.transport
                      .sendFrame(FrameType.POOL_STATE_SYNC, reply)
                      .catch((err: unknown) =>
                        log.warn("[sync-engine] pool state sync reply failed:", err),
                      ),
                  );
                }
              } catch (err) {
                log.warn("[sync-engine] generate_pool_state_sync_reply failed:", err);
              }
            }
            return EMPTY;
          }),
        )
        .subscribe(),
    );

    // Pool state sync error: send recovery reply + publish state
    sub.add(
      frameEvents$.pipe(filter((e) => e.type === "pool_state_sync_error")).subscribe((e) => {
        log.warn("[sync-engine] pool_state_sync_error: pool doc rebuilt, sync state normalized");
        if (e.reply) {
          this.opts.transport
            .sendFrame(FrameType.POOL_STATE_SYNC, new Uint8Array(e.reply))
            .catch((err: unknown) => {
              const handle = this.opts.getHandle();
              if (handle) handle.cancel_last_pool_state_flush();
              log.warn("[sync-engine] pool state recovery reply send failed:", err);
            });
        }
        if (e.changed && e.state) {
          this._poolState$.next(e.state as PoolState);
        }
      }),
    );

    // ── Debounced outbound flush ──────────────────────────────────

    sub.add(
      this.flushRequest$
        .pipe(debounceTime(FLUSH_DEBOUNCE_MS, this.opts.scheduler))
        .subscribe(() => {
          this.flush();
        }),
    );
  }

  /**
   * Stop all pipelines and clean up subscriptions.
   */
  stop(): void {
    if (!this.subscription) return;
    this.opts.logger.info("[sync-engine] Stopping");
    this.subscription.unsubscribe();
    this.subscription = null;
  }

  /** Whether the engine is currently running. */
  get running(): boolean {
    return this.subscription !== null;
  }

  // ── Comm state projection ──────────────────────────────────────────

  /**
   * Re-run comm projection against the latest RuntimeState.
   *
   * Call this when blob_port changes — resets diff state so all current
   * comms appear as "opened", then immediately re-projects against the
   * last known state. Without the immediate replay, deferred comms
   * would stay missing until an unrelated runtime-state change arrives.
   */
  reProjectComms(): void {
    this.commDiffState = { comms: {}, json: {} };
    this.refreshCommProjectionSnapshotsFromHandle();
    this.projectComms();
  }

  private refreshCommProjectionSnapshotsFromHandle(): void {
    const handle = this.opts.getHandle();
    const runtimeState = handle?.get_runtime_state?.();
    if (isRuntimeStateSnapshot(runtimeState)) {
      this.lastRuntimeState = runtimeState as RuntimeState;
    }
    const commsState = handle?.get_comms_state?.();
    if (isCommsStateSnapshot(commsState)) {
      this.lastCommsState = commsState as CommsState;
    }
  }

  /**
   * Project widget comms from RuntimeStateDoc topology plus CommsDoc state.
   *
   * Diffs against previous state, resolves ContentRefs via the WASM handle,
   * fetches any text blob references, and emits to commChanges$.
   *
   * The diff computation and `commDiffState` update happen synchronously
   * so successive calls see correct incremental deltas. The final emission
   * is queued on `commEmitQueue` so emissions stay in order even when text
   * blob fetches from one batch outlive a later batch's fetches.
   */
  private projectComms(): void {
    if (!this.lastRuntimeState) return;
    const comms = this.projectableComms();
    const { result, next } = diffComms(this.commDiffState, comms);

    if (result.opened.length === 0 && result.updated.length === 0 && result.closed.length === 0) {
      this.commDiffState = next;
      return;
    }

    const handle = this.opts.getHandle();
    const resolve = (commId: string, entry: CommDocEntry) => {
      const resolved = handle?.resolve_comm_state?.(commId) as
        | {
            state: Record<string, unknown>;
            buffer_paths: string[][];
            text_paths?: string[][];
          }
        | undefined;
      if (resolved) return resolved;
      if (containsContentRef(entry.state)) return undefined;
      return {
        state: isRecord(entry.state) ? entry.state : {},
        buffer_paths: [] as string[][],
        text_paths: [] as string[][],
      };
    };

    // Pending entries carry the raw resolved state plus the text paths that
    // still need to be fetched before emission.
    const opened: Array<{ comm: ResolvedComm; textPaths: string[][] }> = [];
    for (const { commId, entry } of result.opened) {
      const resolved = resolve(commId, entry);
      if (!resolved) {
        // blob_port not ready — defer by excluding from next state.
        // On the next runtimeState$ emission (after blob_port is set),
        // diffComms will see this comm as "new" again and retry.
        delete next.comms[commId];
        delete next.json[commId];
        continue;
      }
      opened.push({
        comm: {
          commId,
          targetName: entry.target_name,
          modelModule: entry.model_module,
          modelName: entry.model_name,
          state: {
            ...resolved.state,
            _model_module: entry.model_module || undefined,
            _model_name: entry.model_name || undefined,
          },
          bufferPaths: resolved.buffer_paths,
          unresolvedOutputs:
            detectUnresolvedOutputs(entry.state as Record<string, unknown>)?.outputs ?? null,
        },
        textPaths: resolved.text_paths ?? [],
      });
    }

    const updated: Array<{ comm: ResolvedComm; textPaths: string[][] }> = [];
    for (const { commId, entry } of result.updated) {
      const resolved = resolve(commId, entry);
      if (!resolved) {
        // resolver not ready (e.g. blob_port transiently missing after
        // reconnect). Revert `next` to the previous state for this comm
        // so the next diff re-surfaces this update instead of swallowing
        // it. Without this revert, `next.json[commId]` would record the
        // new state, and the next projection would see "no change" and
        // never re-emit — the update would be lost permanently until an
        // unrelated future change to the same comm.
        const prevEntry = this.commDiffState.comms[commId];
        const prevJson = this.commDiffState.json[commId];
        if (prevEntry !== undefined && prevJson !== undefined) {
          next.comms[commId] = prevEntry;
          next.json[commId] = prevJson;
        }
        continue;
      }
      updated.push({
        comm: {
          commId,
          targetName: entry.target_name,
          modelModule: entry.model_module,
          modelName: entry.model_name,
          state: resolved.state,
          bufferPaths: resolved.buffer_paths,
          unresolvedOutputs:
            detectUnresolvedOutputs(entry.state as Record<string, unknown>)?.outputs ?? null,
        },
        textPaths: resolved.text_paths ?? [],
      });
    }

    this.commDiffState = next;

    if (opened.length === 0 && updated.length === 0 && result.closed.length === 0) {
      return;
    }

    // Serialize async resolution + emit so ordering is preserved across
    // overlapping projectComms calls. A `.catch` keeps one failing fetch
    // from poisoning the queue for subsequent batches.
    const log = this.opts.logger;
    this.commEmitQueue = this.commEmitQueue
      .then(async () => {
        await Promise.all([
          ...opened.map((o) => inlineTextBlobs(o.comm.state, o.textPaths, log)),
          ...updated.map((u) => inlineTextBlobs(u.comm.state, u.textPaths, log)),
        ]);
        this._commChanges$.next({
          opened: opened.map((o) => o.comm),
          updated: updated.map((u) => u.comm),
          closed: result.closed,
        });
      })
      .catch((err) => {
        log.warn("[sync-engine] comm emission failed:", err);
      });
  }

  private projectableComms(): Record<string, CommDocEntry> {
    const runtimeState = this.lastRuntimeState;
    if (!runtimeState) return {};

    const splitComms = this.lastCommsState?.comms ?? null;
    const projected: Record<string, CommDocEntry> = {};
    for (const [commId, topology] of Object.entries(runtimeState.comms ?? {})) {
      const splitState = splitComms?.[commId];
      const legacyState = topology.state ?? {};
      projected[commId] = {
        ...topology,
        state: isRecord(splitState) ? splitState : legacyState,
      };
    }
    return projected;
  }

  private emitExecutionViewChanges(changeset: ExecutionViewChangeset | undefined): void {
    if (!changeset) return;
    const cellChanges = changeset.cell_pointer_changes?.length ?? 0;
    const upserts = changeset.execution_upserts?.length ?? 0;
    const removals = changeset.removed_execution_ids?.length ?? 0;
    if (cellChanges === 0 && upserts === 0 && removals === 0 && !changeset.queue) return;
    this._executionViewChanges$.next(changeset);
  }

  private emitOutputIdChanges(changeset: FrameEvent["output_changeset"] | undefined): void {
    const changed = changeset?.changed ?? [];
    const removed_ids = changeset?.removed ?? [];
    if (changed.length === 0 && removed_ids.length === 0) return;
    this._outputIdChanges$.next({ changed, removed_ids });
  }

  private routeLocalSyncAppliedEvent(event: FrameEvent, opts: { scheduleFlush: boolean }): boolean {
    if (event.attributions && event.attributions.length > 0) {
      this._broadcasts$.next(createTextAttributionEvent(event.attributions));
    }
    if (event.changed) {
      this.materializeIn?.next(event.changeset ?? null);
      this._notebookDocChanged$.next();
      if (opts.scheduleFlush) {
        this.scheduleFlush();
      }
    }
    this.emitExecutionViewChanges(event.execution_view_changeset);
    return event.changed === true;
  }

  // ── Local mutation apply ─────────────────────────────────────────

  /**
   * Route a WASM local-mutation `sync_applied` event through the same
   * materialization and execution-view projection path as peer-applied
   * changes, without touching sync state or scheduling an outbound flush.
   */
  applyLocalMutationEvent(event: FrameEvent | null | undefined): boolean {
    if (this.materializeIn === null) {
      this.opts.logger.warn("[sync-engine] local mutation event dropped: engine not running");
      return false;
    }
    if (!event || !event.changed) {
      return false;
    }

    if (event.type === "comments_doc_sync_applied") {
      if (event.projection) {
        this._commentsProjection$.next(event.projection);
        return true;
      }
      return false;
    }

    if (event.type !== "sync_applied") {
      return false;
    }

    return this.routeLocalSyncAppliedEvent(event, { scheduleFlush: false });
  }

  // ── Cross-tab apply ──────────────────────────────────────────────

  /**
   * Apply serialized NotebookDoc changes from a same-principal peer tab
   * (the BroadcastChannel bridge) and route the result through the SAME
   * pipeline section as an inbound `sync_applied` frame: attributions →
   * broadcast, changeset → the coalescing buffer (→ `cellChanges$`),
   * `notebookDocChanged$` for persistence, execution-view changes — one
   * WASM-computed diff, no second diff path (projection-convergence ADR).
   *
   * Returns true when the document changed. Known changes dedupe inside
   * `apply_change_bytes` to `changed: false` and emit NOTHING — the
   * property that terminates two-tab ping-pong: a peer re-broadcasting
   * our own changes back at us cannot re-trigger persistence or another
   * broadcast.
   *
   * Deliberate differences from the inbound-frame path:
   * - No sync reply (the apply never touches sync state) — instead a
   *   changed apply schedules the normal debounced flush, so the room
   *   stays authoritative and receives the changes through ordinary
   *   sync. Offline, that flush attempt fails and rolls back exactly
   *   like any local edit's.
   * - `notebookSyncApplied$` does not fire: it reports applied ROOM
   *   frames (consumers poll room catch-up facts on it), and a tab
   *   apply changes nothing about room catch-up.
   */
  applyLocalPeerChanges(bytes: Uint8Array): boolean {
    if (this.materializeIn === null) {
      // Stopped engine: drop BEFORE touching the doc. Applying here
      // would mutate the handle while the projection pipelines are gone
      // — the changeset and flush would vanish silently, and per-frame
      // diffs after the next start() could never backfill the gap
      // (permanent UI divergence). Dropping is safe: the peer tab's
      // changes reach this doc through the room sync or the next
      // session's seed instead.
      this.opts.logger.warn("[sync-engine] peer changes dropped: engine not running");
      return false;
    }
    const handle = this.opts.getHandle();
    if (!handle?.apply_change_bytes) {
      this.opts.logger.debug("[sync-engine] peer changes dropped: no handle/apply export");
      return false;
    }
    let event: FrameEvent | undefined;
    try {
      event = handle.apply_change_bytes(bytes);
    } catch (e) {
      this.opts.logger.warn("[sync-engine] apply_change_bytes failed:", e);
      return false;
    }
    if (!event || event.type !== "sync_applied") {
      return false;
    }

    return this.routeLocalSyncAppliedEvent(event, { scheduleFlush: true });
  }

  // ── Outbound sync ────────────────────────────────────────────────

  /**
   * Flush local CRDT mutations to the daemon immediately.
   *
   * Sends notebook doc, RuntimeStateDoc, CommsDoc, and PoolDoc sync messages.
   * On transport failure, rolls back sync state to prevent the consumption
   * race from #1067.
   */
  flush(): void {
    const handle = this.opts.getHandle();
    if (!handle) {
      this.opts.logger.debug("[sync-engine] flush skipped: no handle");
      return;
    }

    const msg = handle.flush_local_changes();
    if (msg) {
      // A sync message was generated — the doc may have changed (protocol-
      // only handshakes also yield bytes, so this can over-fire; saves are
      // idempotent). Notify persistence on the attempt regardless of
      // delivery outcome: cancel_last_flush rolls back sync bookkeeping,
      // not the doc.
      this._notebookDocChanged$.next();
      this.opts.logger.debug(`[sync-engine] flushing sync message (${msg.byteLength}B)`);
      const done = this.awaitFrameDelivery(
        this.opts.transport.sendFrame(FrameType.AUTOMERGE_SYNC, msg),
        "sync to relay",
        () => handle.cancel_last_flush(),
      );
      // Track the in-flight flush so flushAndWait() can await it.
      this.trackInflightFlush("notebook", done);
    }

    // Also flush RuntimeStateDoc sync so the daemon sends kernel status,
    // trust state, etc. Without this, if the daemon's initial RuntimeStateSync
    // frame arrived before the WASM handle was ready, the frontend would stay
    // stuck on "not_started" (#runtime-state-race).
    const stateMsg = handle.flush_runtime_state_sync();
    if (stateMsg) {
      this.trackInflightFlush(
        "runtimeState",
        this.awaitFrameDelivery(
          this.opts.transport.sendFrame(FrameType.RUNTIME_STATE_SYNC, stateMsg),
          "runtime state sync to relay",
          () => handle.cancel_last_runtime_state_flush(),
        ),
      );
    }

    // Also flush CommsDoc sync so widget state updates reach the daemon
    // independently from runtime topology/status.
    const commsMsg = handle.flush_comms_doc_sync();
    if (commsMsg) {
      this.trackInflightFlush(
        "commsDoc",
        this.awaitFrameDelivery(
          this.opts.transport.sendFrame(FrameType.COMMS_DOC_SYNC, commsMsg),
          "comms doc sync to relay",
          () => handle.cancel_last_comms_doc_flush(),
        ),
      );
    }

    // Also flush CommentsDoc sync when the current handle has comments identity.
    const commentsMsg = handle.flush_comments_doc_sync?.();
    if (commentsMsg) {
      this.trackInflightFlush(
        "commentsDoc",
        this.awaitFrameDelivery(
          this.opts.transport.sendFrame(FrameType.COMMENTS_DOC_SYNC, commentsMsg),
          "comments doc sync to relay",
          () => handle.cancel_last_comments_doc_flush?.(),
        ),
      );
    }

    // Also flush PoolDoc sync so the daemon sends pool state.
    const poolMsg = handle.flush_pool_state_sync();
    if (poolMsg) {
      this.trackInflightFlush(
        "pool",
        this.awaitFrameDelivery(
          this.opts.transport.sendFrame(FrameType.POOL_STATE_SYNC, poolMsg),
          "pool state sync to relay",
          () => handle.cancel_last_pool_state_flush(),
        ),
      );
    }
  }

  /**
   * Flush local changes and wait for delivery.
   *
   * Unlike `flush()` (fire-and-forget), this method:
   * 1. Awaits any in-flight debounced flush that may have already claimed
   *    changes from `flush_local_changes()`.
   * 2. Flushes any remaining local changes and awaits delivery.
   *
   * Returns false if source delivery failed or timed out. Use before
   * execute/save to guarantee the daemon has the latest source.
   */
  async flushAndWait(): Promise<boolean> {
    // Drain all in-flight debounced/fire-and-forget flushes. A new debounced
    // flush can start while we're awaiting current deliveries (the 20ms timer
    // fires independently), so loop until stable.
    if (!(await this.drainInflightFlushes())) {
      return false;
    }

    const handle = this.opts.getHandle();
    if (!handle) return true;

    // Flush any remaining notebook doc changes (may be none if debounce got them).
    const msg = handle.flush_local_changes();
    if (msg) {
      // Same save-hint contract as flush(): emit on the attempt, before
      // delivery resolves; may over-fire for protocol-only messages.
      this._notebookDocChanged$.next();
      this.opts.logger.debug(`[sync-engine] flushAndWait: sending ${msg.byteLength}B sync message`);
      const delivered = await this.awaitFrameDelivery(
        this.opts.transport.sendFrame(FrameType.AUTOMERGE_SYNC, msg),
        "flushAndWait sync to relay",
        () => handle.cancel_last_flush(),
      );
      if (!delivered) {
        return false;
      }
    }

    // Also flush RuntimeStateDoc sync.
    const stateMsg = handle.flush_runtime_state_sync();
    if (stateMsg) {
      const delivered = await this.awaitFrameDelivery(
        this.opts.transport.sendFrame(FrameType.RUNTIME_STATE_SYNC, stateMsg),
        "flushAndWait runtime state sync",
        () => handle.cancel_last_runtime_state_flush(),
      );
      if (!delivered) {
        return false;
      }
    }

    // Also flush CommsDoc sync.
    const commsMsg = handle.flush_comms_doc_sync();
    if (commsMsg) {
      const delivered = await this.awaitFrameDelivery(
        this.opts.transport.sendFrame(FrameType.COMMS_DOC_SYNC, commsMsg),
        "flushAndWait comms doc sync",
        () => handle.cancel_last_comms_doc_flush(),
      );
      if (!delivered) {
        return false;
      }
    }

    // Also flush CommentsDoc sync.
    const commentsMsg = handle.flush_comments_doc_sync?.();
    if (commentsMsg) {
      const delivered = await this.awaitFrameDelivery(
        this.opts.transport.sendFrame(FrameType.COMMENTS_DOC_SYNC, commentsMsg),
        "flushAndWait comments doc sync",
        () => handle.cancel_last_comments_doc_flush?.(),
      );
      if (!delivered) {
        return false;
      }
    }

    // Also flush PoolDoc sync.
    const poolMsg = handle.flush_pool_state_sync();
    if (poolMsg) {
      const delivered = await this.awaitFrameDelivery(
        this.opts.transport.sendFrame(FrameType.POOL_STATE_SYNC, poolMsg),
        "flushAndWait pool state sync",
        () => handle.cancel_last_pool_state_flush(),
      );
      if (!delivered) {
        return false;
      }
    }
    return true;
  }

  private async awaitFrameDelivery(
    delivery: Promise<void>,
    label: string,
    onFailure: () => void,
  ): Promise<boolean> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      const result = await Promise.race([
        delivery.then(
          () => ({ status: "ok" as const }),
          (error: unknown) => ({ status: "error" as const, error }),
        ),
        new Promise<{ status: "timeout" }>((resolve) => {
          timeoutId = setTimeout(() => resolve({ status: "timeout" }), this.flushDeliveryTimeoutMs);
        }),
      ]);

      if (result.status === "timeout") {
        onFailure();
        this.opts.logger.warn(
          `[sync-engine] ${label} timed out after ${this.flushDeliveryTimeoutMs}ms; rolled back sync state`,
        );
        return false;
      }
      if (result.status === "error") {
        onFailure();
        this.opts.logger.warn(
          `[sync-engine] ${label} failed; rolled back sync state:`,
          result.error,
        );
        return false;
      }
      return true;
    } catch (e) {
      onFailure();
      this.opts.logger.warn(`[sync-engine] ${label} failed; rolled back sync state:`, e);
      return false;
    } finally {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
    }
  }

  private trackInflightFlush(key: FlushDocKey, delivery: Promise<boolean>): void {
    this.inflightFlushes.set(key, delivery);
  }

  private async drainInflightFlushes(): Promise<boolean> {
    while (this.inflightFlushes.size > 0) {
      const entries = Array.from(this.inflightFlushes.entries());
      const results = await Promise.all(
        entries.map(async ([key, current]) => {
          const delivered = await current;
          // Only clear if no newer flush replaced it while we awaited.
          if (this.inflightFlushes.get(key) === current) {
            this.inflightFlushes.delete(key);
          }
          return delivered;
        }),
      );
      if (results.some((delivered) => !delivered)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Schedule a debounced flush (for batching rapid keystrokes).
   *
   * Each call resets the 20ms debounce timer. Call `flush()` directly
   * when you need an immediate sync (e.g. before execute or save).
   */
  scheduleFlush(): void {
    this.flushRequest$.next();
  }

  /**
   * Reset sync state and resend the initial sync message.
   *
   * Manual recovery helper for tests and explicit resync flows. Resets
   * the WASM handle's sync state so `flush_local_changes()` produces a
   * fresh request.
   */
  resetAndResync(): void {
    const handle = this.opts.getHandle();
    if (!handle) return;
    handle.reset_sync_state();
    this.flush();
  }

  /**
   * Reset the engine for a new bootstrap cycle (e.g. daemon:ready).
   *
   * Clears status / execution tracking so the next round of frames is
   * treated as a fresh connection. Also emits a fully-pending
   * `SessionStatus` so late subscribers (ReplaySubject(1) cache) see
   * "not ready" immediately — without this, downstream consumers that
   * gate on `sessionStatus.runtime_state === "ready"` would keep the
   * previous session's `ready` value until the next daemon status
   * frame arrives, leaving a rebootstrap-sized fail-open window.
   */
  resetForBootstrap(): void {
    this.opts.logger.info("[sync-engine] Resetting for bootstrap");
    this.latestSessionStatus = null;
    this.prevExecutions = {};
    this.commDiffState = { comms: {}, json: {} };
    this.lastRuntimeState = null;
    this.lastCommsState = null;
    this._sessionStatus$.next({
      notebook_doc: "pending",
      runtime_state: "pending",
      initial_load: { phase: "not_needed" },
    });
  }
}

/** Queue membership equality for the deduplicated `executionQueue$`. */
function executionQueueEquals(a: ExecutionQueueProjection, b: ExecutionQueueProjection): boolean {
  if ((a.executing_execution_id ?? null) !== (b.executing_execution_id ?? null)) return false;
  if (!stringArrayEquals(a.queued_execution_ids, b.queued_execution_ids)) return false;
  const an = a.notebook ?? null;
  const bn = b.notebook ?? null;
  if (an === null || bn === null) return an === bn;
  return (
    (an.executing_cell_id ?? null) === (bn.executing_cell_id ?? null) &&
    stringArrayEquals(an.queued_cell_ids, bn.queued_cell_ids)
  );
}

function stringArrayEquals(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

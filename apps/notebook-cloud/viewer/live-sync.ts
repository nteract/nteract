import { BehaviorSubject, ReplaySubject, type Observable } from "rxjs";
import {
  SyncEngine,
  splitNotebookActorPrincipalOperator,
  type ConnectionStatus,
  type FrameTypeValue,
  type NotebookRequest,
  type NotebookRequestOptions,
  type NotebookResponse,
  type NotebookTransport,
  type PersistedNotebookDoc,
  type SyncableHandle,
  type NotebookInteractionTarget,
} from "runtimed";
import { isConnectionScope, type ConnectionScope } from "../src/auth-shared";
import { identityDisplayLabel } from "../src/display-label";
import {
  FrameType,
  LIVENESS_PING,
  LIVENESS_PONG,
  type SessionControlMessage,
} from "../src/protocol";
import {
  cloudPrototypeAuthFromWindow,
  cloudSyncAuthFromPrototypeAuthState,
  type CloudSyncAuth,
} from "./collaborator-auth";
import {
  createBootstrapNotebookHandle,
  encodeCursorPresenceAfterInit,
  encodeHeartbeatPresenceAfterInit,
  encodeInteractionPresenceAfterInit,
  encodeSelectionPresenceAfterInit,
  loadNotebookHandleFromBytes,
  type NotebookHandle,
} from "./runtimed-wasm-client";

export type CloudRoomReady = Extract<SessionControlMessage, { type: "cloud_room_ready" }>;

export interface CloudConnectTarget {
  url: URL;
  protocols: string[];
}

export interface CloudSyncRuntime {
  /** Latest connection identity — updated on every cloud_room_ready. */
  readonly actorLabel: string;
  readonly connectionScope: ConnectionScope;
  readonly peerId: string;
  readonly peerLabel: string;
  handle: NotebookHandle;
  engine: SyncEngine;
  transport: CloudWebSocketTransport;
  /** True when the handle was seeded from locally persisted NotebookDoc bytes. */
  seededFromPersistence: boolean;
  /** How the persisted-seed attempt resolved; "read_failed" must not arm saves. */
  persistenceSeedOutcome: CloudPersistenceSeedOutcome;
  /**
   * Adopt a reconnect handshake on the PRESERVED runtime: update identity,
   * `set_actor` with the fresh label, reset engine caches and sync state.
   * Returns false when the ready belongs to the connection already adopted
   * (`roomReady$` replays the latest handshake to new subscribers).
   *
   * Must be invoked synchronously from the `roomReady$` subscription — see
   * `reestablishCloudConnection` for the ordering constraint.
   */
  applyRoomReady: (ready: CloudRoomReady) => boolean;
  sendCursorPresence: (cellId: string, line: number, column: number) => void;
  sendSelectionPresence: (
    cellId: string,
    anchorLine: number,
    anchorCol: number,
    headLine: number,
    headCol: number,
  ) => void;
  sendInteractionPresence: (target: NotebookInteractionTarget) => void;
}

export interface CloudSyncConnectOptions {
  /**
   * Per-attempt connection target (see `createCloudConnectTarget`). The
   * transport re-invokes it on every retry so auth material is re-resolved
   * and the operator nonce is re-minted.
   */
  connectTarget: () => Promise<CloudConnectTarget>;
  runtimedWasmModulePath: string;
  runtimedWasmPath: string;
  /** Locally persisted NotebookDoc seed; omitted when storage is unavailable. */
  persistence?: CloudSyncPersistenceSeed;
  onControl?: (message: SessionControlMessage) => void;
  /**
   * Informational: a connection dropped or an attempt failed. The transport
   * keeps retrying — this is a notice surface, not a teardown signal.
   */
  onConnectionLost?: (reason: Error) => void;
  /**
   * Receives the transport as soon as it exists, so callers can disconnect
   * an in-flight connect on unmount — `ready` may stay pending for as long
   * as the retry loop runs.
   */
  onTransportCreated?: (transport: CloudWebSocketTransport) => void;
}

export interface CloudSyncPersistenceSeed {
  /** Read the persisted NotebookDoc record for this notebook, if any. */
  loadPersisted: () => Promise<PersistedNotebookDoc | undefined>;
  /** Discard the persisted record (principal mismatch, corrupt bytes). */
  clear: () => Promise<void>;
}

/**
 * How the persisted-seed attempt resolved:
 * - `"seeded"` — handle loaded from persisted bytes (principal matched).
 * - `"bootstrap"` — no persistence wired, anonymous principal, or no record.
 * - `"cleared"` — record was unverifiable or unloadable and was discarded.
 * - `"read_failed"` — storage read rejected or timed out; the record (which
 *   may hold offline-only edits) was left in place, so the session must NOT
 *   arm the save loop — the next throttled save would overwrite it.
 */
export type CloudPersistenceSeedOutcome = "seeded" | "bootstrap" | "cleared" | "read_failed";

export interface ResolvedCloudNotebookHandle<Handle> {
  handle: Handle;
  outcome: CloudPersistenceSeedOutcome;
}

type FrameListener = Parameters<NotebookTransport["onFrame"]>[0];

/** Per-attempt bound on cloud_room_ready after the socket is created. */
const HANDSHAKE_TIMEOUT_MS = 30_000;
const CLOUD_REQUEST_TIMEOUT_MS = 30_000;

const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
/** ±50% full jitter on every retry delay. */
const RECONNECT_JITTER_RATIO = 0.5;

/**
 * App-level liveness probe cadence. A zombie socket (OS-level offline,
 * upstream loss with the interface up) keeps `readyState === OPEN` and
 * buffers sends silently — without traffic that DEMANDS a reply, the only
 * loss signal is the OS TCP retransmit abort, minutes later. The room DO
 * answers `LIVENESS_PING` via `setWebSocketAutoResponse` (no DO wake), so a
 * missed pong within the deadline means the link is dead: recycle it.
 */
const LIVENESS_PING_INTERVAL_MS = 20_000;
const LIVENESS_PONG_DEADLINE_MS = 10_000;

/**
 * Bound on the persisted-seed IndexedDB read at connect time. A hung IDB
 * open (corrupt browser profile) must degrade to bootstrap, not stall the
 * live session after the room handshake succeeded.
 */
const PERSISTED_SEED_READ_TIMEOUT_MS = 2_000;

interface PendingFrameAck {
  reject: (error: Error) => void;
  resolve: () => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

/**
 * Browser timers are numbers; Node timers are objects whose `unref()`
 * releases the event loop. The liveness probe's periodic timers must never
 * keep a Node process (tests) alive on their own — a transport that is
 * still connected when a test file finishes would otherwise wedge the
 * runner forever. No-op in browsers.
 */
function unrefTimer(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  (timer as { unref?: () => void }).unref?.();
}

function requestTimeoutMs(request: NotebookRequest): number {
  switch (request.type) {
    case "launch_kernel":
    case "sync_environment":
      return 300_000;
    case "complete":
      return 7_000;
    default:
      return CLOUD_REQUEST_TIMEOUT_MS;
  }
}

export function cloudSyncAuthFromLocalStorage(): CloudSyncAuth {
  return cloudSyncAuthFromPrototypeAuthState(cloudPrototypeAuthFromWindow());
}

export async function connectCloudSyncRuntime({
  connectTarget,
  runtimedWasmModulePath,
  runtimedWasmPath,
  persistence,
  onControl,
  onConnectionLost,
  onTransportCreated,
}: CloudSyncConnectOptions): Promise<CloudSyncRuntime> {
  const transport = new CloudWebSocketTransport({ connectTarget, onControl, onConnectionLost });
  onTransportCreated?.(transport);
  try {
    // No timeout: the transport retries with backoff until manual
    // disconnect, so initial-connect failures ride the same loop instead
    // of dead-ending the session. `ready` resolves on the first successful
    // handshake, whenever that happens.
    const ready = await transport.ready;
    const wasmModuleUrl = new URL(runtimedWasmModulePath, location.href);
    const wasmUrl = new URL(runtimedWasmPath, location.href);
    const { handle, outcome: persistenceSeedOutcome } = await resolveCloudNotebookHandle({
      actorLabel: ready.actor_label,
      persistence,
      createBootstrap: () =>
        createBootstrapNotebookHandle(ready.actor_label, wasmModuleUrl, wasmUrl),
      loadFromBytes: (bytes) =>
        loadNotebookHandleFromBytes(bytes, ready.actor_label, wasmModuleUrl, wasmUrl),
    });
    const syncHandle = syncableCloudHandle(handle);
    // Mutable connection identity: presence encoders and the runtime's
    // identity getters always read the LATEST handshake's values, so a
    // reconnect never sends presence under a dead peer id.
    const identity = cloudConnectionIdentityFromReady(ready);
    const engine = new SyncEngine({
      getHandle: () => syncHandle,
      transport,
      presenceHeartbeat: {
        intervalMs: 15_000,
        encode: () => encodeHeartbeatPresenceAfterInit(identity.peerId),
      },
      logger: consoleSyncLogger,
    });

    startCloudBootstrapSync(engine);

    const sendPresence = (payload: Uint8Array, label: string) => {
      void transport
        .sendFrame(FrameType.PRESENCE, payload)
        .catch((error: unknown) =>
          console.warn(`[notebook-cloud] ${label} presence failed`, error),
        );
    };

    return {
      get actorLabel() {
        return identity.actorLabel;
      },
      get connectionScope() {
        return identity.connectionScope;
      },
      get peerId() {
        return identity.peerId;
      },
      get peerLabel() {
        return identity.peerLabel;
      },
      handle,
      engine,
      transport,
      seededFromPersistence: persistenceSeedOutcome === "seeded",
      persistenceSeedOutcome,
      applyRoomReady: (nextReady) =>
        applyCloudRoomReady(identity, nextReady, () =>
          reestablishCloudConnection(handle, engine, nextReady.actor_label),
        ),
      sendCursorPresence: (cellId, line, column) => {
        sendPresence(
          encodeCursorPresenceAfterInit(
            identity.peerId,
            identity.peerLabel,
            identity.actorLabel,
            cellId,
            line,
            column,
          ),
          "cursor",
        );
      },
      sendSelectionPresence: (cellId, anchorLine, anchorCol, headLine, headCol) => {
        sendPresence(
          encodeSelectionPresenceAfterInit(
            identity.peerId,
            identity.peerLabel,
            identity.actorLabel,
            cellId,
            anchorLine,
            anchorCol,
            headLine,
            headCol,
          ),
          "selection",
        );
      },
      sendInteractionPresence: (target) => {
        sendPresence(
          encodeInteractionPresenceAfterInit(
            identity.peerId,
            identity.peerLabel,
            identity.actorLabel,
            target,
          ),
          "interaction",
        );
      },
    };
  } catch (error) {
    transport.disconnect();
    throw error;
  }
}

/**
 * Re-establish per-connection sync state on a PRESERVED runtime after a
 * reconnect handshake — mirrors the daemon cloud agent's reconnect
 * (runtime_agent.rs keeps the kernel, queue, and docs; only sync states
 * are recreated).
 *
 * Ordering constraint: this must run synchronously inside the roomReady$
 * emission. The room host kicks host-initiated sync immediately after
 * cloud_room_ready, and an inbound sync frame applied against the previous
 * connection's sync state is garbage. The transport emits roomReady$
 * before dispatching any frame from the new connection, and every call in
 * here is synchronous WASM — no awaits allowed before these calls.
 *
 * Actor safety: preserve the handle XOR reuse the actor label. The handle
 * is preserved (unflushed local edits live in it), so it MUST adopt the
 * new connection's fresh label — set_actor starts a fresh (actor, seq)
 * chain, avoiding DuplicateSeqNumber.
 */
export function reestablishCloudConnection(
  handle: Pick<NotebookHandle, "set_actor">,
  engine: Pick<SyncEngine, "resetForBootstrap" | "resetAndResync">,
  actorLabel: string,
): void {
  handle.set_actor(actorLabel);
  engine.resetForBootstrap();
  engine.resetAndResync();
}

/** Mutable per-runtime connection identity (latest handshake's values). */
export interface CloudConnectionIdentity {
  actorLabel: string;
  peerId: string;
  peerLabel: string;
  connectionScope: ConnectionScope;
}

export function cloudConnectionIdentityFromReady(ready: CloudRoomReady): CloudConnectionIdentity {
  return {
    actorLabel: ready.actor_label,
    peerId: ready.peer_id,
    peerLabel: cloudRoomReadyPeerLabel(ready),
    connectionScope: normalizeConnectionScope(ready.connection_scope),
  };
}

/**
 * Adopt a handshake on a preserved runtime's identity: dedup against the
 * connection already adopted (`roomReady$` replays the latest handshake to
 * new subscribers), update the mutable identity so presence encoders stamp
 * the fresh peer id, then run the synchronous re-establish.
 */
export function applyCloudRoomReady(
  identity: CloudConnectionIdentity,
  ready: CloudRoomReady,
  reestablish: () => void,
): boolean {
  if (ready.peer_id === identity.peerId) {
    return false;
  }
  identity.actorLabel = ready.actor_label;
  identity.peerId = ready.peer_id;
  identity.peerLabel = cloudRoomReadyPeerLabel(ready);
  identity.connectionScope = normalizeConnectionScope(ready.connection_scope);
  reestablish();
  return true;
}

/**
 * Mint the per-connection-attempt session id.
 *
 * Load-bearing for actor uniqueness: the worker derives the anonymous
 * principal and the `browser:<sessionId>` operator nonce from this value
 * and only rewrites the principal segment, so a collision would reuse an
 * actor label across doc instances (DuplicateSeqNumber). The fallbacks for
 * environments without crypto.randomUUID must stay collision-resistant —
 * never a bare timestamp.
 */
export function mintCloudSessionId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Build the per-attempt connect target factory for the transport's retry
 * loop. Each invocation re-resolves auth (tokens expire mid-session) and
 * mints a FRESH operator nonce.
 *
 * Fresh-per-attempt nonce rationale: the actor-safety rule is "preserve
 * the handle XOR reuse the actor label". A preserved handle with a NEW
 * label is safe (set_actor starts a fresh seq chain); a fresh handle with
 * a REUSED label collides (DuplicateSeqNumber). Fresh-per-attempt is the
 * universally safe choice for both shapes and matches the previous
 * per-effect-run behavior.
 */
export function createCloudConnectTarget({
  syncEndpoint,
  resolveAuth,
  mintSessionId = mintCloudSessionId,
}: {
  syncEndpoint: string;
  resolveAuth: (sessionId: string) => Promise<CloudSyncAuth> | CloudSyncAuth;
  mintSessionId?: () => string;
}): () => Promise<CloudConnectTarget> {
  return async () => {
    const sessionId = mintSessionId();
    const auth = await resolveAuth(sessionId);
    return { url: syncUrl(syncEndpoint, sessionId, auth), protocols: auth.protocols };
  };
}

export function normalizeConnectionScope(value: string): ConnectionScope {
  if (isConnectionScope(value)) {
    return value;
  }
  console.warn(
    `[notebook-cloud] unknown connection scope ${JSON.stringify(value)}; falling back to viewer`,
  );
  return "viewer";
}

export function startCloudBootstrapSync(
  engine: Pick<SyncEngine, "start" | "resetForBootstrap" | "flush">,
): void {
  engine.start();
  // Match the desktop `useAutomergeNotebook` bootstrap path: a newly-created
  // bootstrap handle must initiate the sync exchange before it can materialize
  // the room. Viewer-scope peers still use normal sync state so incoming
  // changes apply locally; the room host rejects any viewer-authored changes.
  engine.resetForBootstrap();
  engine.flush();
}

/**
 * The connection's authenticated principal, derived from the
 * server-assigned actor label.
 *
 * `cloud_room_ready.actor_label` is `${principal}/${operator}` and the
 * worker rewrites the principal segment to the authenticated principal on
 * every connection (`rewriteActorLabelPrincipal` in src/identity.ts), so
 * the segment before the first "/" is the authoritative principal. The
 * other ready fields (identity_provider, principal_namespace,
 * display_name, email) describe the principal but never carry its full
 * value.
 */
export function cloudPrincipalFromActorLabel(actorLabel: string): string {
  const [principal] = splitNotebookActorPrincipalOperator(actorLabel);
  return principal;
}

/**
 * Anonymous principals (`anonymous:<encodedSession>`, minted by the worker
 * from the per-connection viewer_session nonce) change on every connect,
 * so a persisted record can never match the next session — and an
 * anonymous session must never clear a signed-in user's record on
 * principal mismatch. Persistence is skipped entirely for them: no seed,
 * no save, no clear.
 */
export function isAnonymousCloudPrincipal(principal: string): boolean {
  return principal.startsWith("anonymous:");
}

/**
 * Choose the initial NotebookHandle for a live cloud session: seed from
 * locally persisted NotebookDoc bytes when their authoring principal
 * matches the connection's, else create a bootstrap skeleton.
 *
 * A seeded doc and the room host share the frozen genesis, so the normal
 * `startCloudBootstrapSync` exchange converges by sending only the delta —
 * offline edits captured in the persisted bytes flow to the room as
 * ordinary sync.
 *
 * Records that cannot be verified (missing/corrupt meta, torn envelope)
 * or whose principal mismatches are cleared — the room's actor-principal
 * authorization would reject their replayed changes on every reconnect,
 * looping forever. Corrupt bytes (`load()` throwing) likewise clear and
 * fall back to bootstrap. Storage reads are bounded by a short timeout
 * and fail open to bootstrap WITHOUT clearing (`"read_failed"`); callers
 * must not arm the save loop in that case. Rejection of seeded changes by
 * the room is escalated by the session (clear + bootstrap-only retry),
 * not here.
 */
export async function resolveCloudNotebookHandle<Handle>({
  actorLabel,
  persistence,
  createBootstrap,
  loadFromBytes,
  readTimeoutMs = PERSISTED_SEED_READ_TIMEOUT_MS,
}: {
  actorLabel: string;
  persistence?: CloudSyncPersistenceSeed;
  createBootstrap: () => Promise<Handle>;
  loadFromBytes: (bytes: Uint8Array) => Promise<Handle>;
  readTimeoutMs?: number;
}): Promise<ResolvedCloudNotebookHandle<Handle>> {
  if (!persistence || isAnonymousCloudPrincipal(cloudPrincipalFromActorLabel(actorLabel))) {
    return { handle: await createBootstrap(), outcome: "bootstrap" };
  }

  let persisted: PersistedNotebookDoc | undefined;
  try {
    persisted = await withReadyTimeout(
      persistence.loadPersisted(),
      readTimeoutMs,
      `persisted NotebookDoc read did not settle within ${readTimeoutMs}ms`,
    );
  } catch (error) {
    console.warn("[notebook-cloud] persisted NotebookDoc read failed; bootstrapping", error);
    return { handle: await createBootstrap(), outcome: "read_failed" };
  }
  if (!persisted) {
    return { handle: await createBootstrap(), outcome: "bootstrap" };
  }

  if (
    !persisted.meta ||
    !persisted.bytes ||
    persisted.meta.principal !== cloudPrincipalFromActorLabel(actorLabel)
  ) {
    await clearPersistedSeed(persistence);
    return { handle: await createBootstrap(), outcome: "cleared" };
  }

  try {
    return { handle: await loadFromBytes(persisted.bytes), outcome: "seeded" };
  } catch (error) {
    console.warn(
      "[notebook-cloud] persisted NotebookDoc bytes failed to load; clearing and bootstrapping",
      error,
    );
    await clearPersistedSeed(persistence);
    return { handle: await createBootstrap(), outcome: "cleared" };
  }
}

async function clearPersistedSeed(persistence: CloudSyncPersistenceSeed): Promise<void> {
  try {
    await persistence.clear();
  } catch (error) {
    console.warn("[notebook-cloud] failed to clear persisted NotebookDoc record", error);
  }
}

export function isRecoverableCloudFrameRejection(message: SessionControlMessage): boolean {
  return message.type === "cloud_frame_rejected" && message.frame_type === FrameType.AUTOMERGE_SYNC;
}

/**
 * Poison-pill guard: a room-rejected NotebookDoc sync frame on a session
 * seeded from persisted bytes means the record replays changes the room
 * will never accept (scope downgrade, room history regression). Without
 * discarding it, every reconnect reseeds the same record and hits the
 * identical rejection — a permanent loop. The rejected changes are
 * unauthorized; losing them is the intended outcome.
 */
export function shouldDiscardPersistedSeedOnRejection(
  message: SessionControlMessage,
  seededFromPersistence: boolean,
): boolean {
  return seededFromPersistence && isRecoverableCloudFrameRejection(message);
}

export type CloudRejectionDisposition = "absorb" | "resync_in_place" | "escalate";

/**
 * Per-connection strike tracker for recoverable sync rejections.
 *
 * First recoverable sync rejection on a connection: recover in place —
 * `resetAndResync()` on the live connection, no teardown. A repeat within
 * the same connection means in-place recovery cannot converge (the resync
 * regenerated the same refused content), so escalate to the full teardown
 * path, where the poison-pill seed discard applies. A rejection before the
 * runtime exists escalates directly — there is nothing to resync in place.
 *
 * Pipelining guard: the hosted-room ack protocol carries only frame_type
 * (no id), and the engine routinely has several AUTOMERGE_SYNC frames in
 * flight (debounced flushes, inline replies). A rejection that arrives
 * before the strike-1 resync's outbound flush has been DELIVERED cannot
 * have observed the resync — it is the same divergence event, not evidence
 * that recovery failed. Such rejections `"absorb"` into strike 1; callers
 * mark delivery via `resyncSettled()` (e.g. after `engine.flushAndWait()`),
 * and only post-delivery rejections escalate. The poison-pill seed discard
 * therefore never fires from a pipelined rejection.
 */
export class CloudRecoverableRejectionTracker {
  private strikes = 0;
  private resyncPending = false;

  /** Reset on each cloud_room_ready (fresh connection, fresh strike count). */
  reset(): void {
    this.strikes = 0;
    this.resyncPending = false;
  }

  /**
   * Record a recoverable rejection and return its disposition. For
   * `"resync_in_place"` the caller must run the resync and call
   * `resyncSettled()` once its outbound flush has been delivered.
   */
  record(hasLiveRuntime: boolean): CloudRejectionDisposition {
    if (this.resyncPending) {
      return "absorb";
    }
    this.strikes += 1;
    if (this.strikes <= 1 && hasLiveRuntime) {
      this.resyncPending = true;
      return "resync_in_place";
    }
    return "escalate";
  }

  /** The strike-1 resync's outbound flush was delivered (or failed terminally). */
  resyncSettled(): void {
    this.resyncPending = false;
  }
}

/**
 * Poison-pill discard chain for an escalated rejection on a seeded session:
 * dispose FIRST — the teardown's `flushNow` re-writes the record with the
 * rejected changes — then clear once that write has settled. The returned
 * promise never rejects; callers must gate the next attempt's persistence
 * arming on it (clear-then-arm), or a straggling clear could delete the
 * next attempt's first persisted record.
 */
export function discardPersistedSeedAfterTeardown(
  disposeRuntime: () => Promise<void>,
  clearSeed: () => Promise<void>,
): Promise<void> {
  return disposeRuntime()
    .catch(() => undefined)
    .then(() => clearSeed())
    .catch((error: unknown) => {
      console.warn("[notebook-cloud] failed to clear rejected persisted NotebookDoc record", error);
    });
}

export async function withReadyTimeout<T>(
  ready: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([ready, timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export interface CloudWebSocketTransportOptions {
  /**
   * Resolve the connection target for one attempt. Re-invoked on every
   * retry so auth material is re-resolved (tokens expire mid-session) and
   * the operator nonce is re-minted (`createCloudConnectTarget`).
   */
  connectTarget: () => Promise<CloudConnectTarget>;
  onControl?: (message: SessionControlMessage) => void;
  /**
   * Informational: an established or in-progress connection was lost. The
   * retry loop keeps running — this is a notice surface, not a teardown
   * signal. Never fires for manual `disconnect()`.
   */
  onConnectionLost?: (reason: Error) => void;
  /** Backoff/handshake tuning for tests. */
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  handshakeTimeoutMs?: number;
  /**
   * Liveness probe tuning for tests. After each cloud_room_ready the
   * transport sends `LIVENESS_PING` every `livenessPingIntervalMs`; if no
   * `LIVENESS_PONG` arrives within `livenessPongDeadlineMs` of a ping, the
   * connection is treated as lost. `livenessPingIntervalMs: 0` disables
   * the probe entirely.
   */
  livenessPingIntervalMs?: number;
  livenessPongDeadlineMs?: number;
  /** Jitter source (default Math.random); injectable for deterministic tests. */
  random?: () => number;
}

/**
 * Multi-connection cloud transport: one re-entrant connect loop serves the
 * initial connect and every retry (exponential backoff + full jitter,
 * reset on the cloud_room_ready app-level ack, short-circuit on the
 * browser `online` event, retry forever until manual `disconnect()`).
 *
 * Drop, don't buffer: sends while the current socket is not OPEN reject,
 * and pending FIFO frame ACKs are rejected per connection loss — they
 * cannot span sockets. Sync correctness lives in the protocol: the engine
 * rolls back via `cancel_last_flush` and regenerates from sync state after
 * the next handshake.
 */
export class CloudWebSocketTransport implements NotebookTransport {
  private readonly options: CloudWebSocketTransportOptions;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly livenessPingIntervalMs: number;
  private readonly livenessPongDeadlineMs: number;
  private readonly random: () => number;

  private socket: WebSocket | null = null;
  private detachSocket: (() => void) | null = null;
  /** True once the CURRENT connection's cloud_room_ready was handled. */
  private connectionReady = false;
  /** Bumped per connect attempt and on disconnect to invalidate stale async work. */
  private connectEpoch = 0;
  /** Consecutive attempts without a cloud_room_ready ack (backoff input). */
  private failedAttempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private livenessPingTimer: ReturnType<typeof setInterval> | null = null;
  private livenessPongTimer: ReturnType<typeof setTimeout> | null = null;
  private manualDisconnect = false;
  private everReady = false;
  private readySettled = false;
  private listeners = new Set<FrameListener>();
  private queuedFrames: number[][] = [];
  // Hosted room accept/reject controls currently carry only the frame type, not
  // a request id, so pending acknowledgements are matched FIFO per frame type.
  private pendingFrameAcks = new Map<number, PendingFrameAck[]>();
  private readyResolve!: (message: CloudRoomReady) => void;
  private readyReject!: (error: Error) => void;
  /**
   * Resolves on the FIRST successful handshake; rejects only on manual
   * disconnect. Later handshakes emit on `roomReady$`.
   */
  readonly ready: Promise<CloudRoomReady>;
  private readonly _roomReady$ = new ReplaySubject<CloudRoomReady>(1);
  /**
   * Emits per successful cloud_room_ready handshake (initial and every
   * reconnect) with the new peer_id / actor_label / connection_scope.
   *
   * Emission is synchronous within the ready message's handling, BEFORE
   * any subsequent frame from that connection is dispatched — subscribers
   * reset per-connection sync state in the same tick so host-initiated
   * sync never lands on stale state. Replays the latest handshake to new
   * subscribers (a reconnect during session setup is adopted on
   * subscribe).
   */
  readonly roomReady$: Observable<CloudRoomReady> = this._roomReady$.asObservable();
  private status: ConnectionStatus = "connecting";
  private readonly _status$ = new BehaviorSubject<ConnectionStatus>("connecting");
  readonly connectionStatus$: Observable<ConnectionStatus> = this._status$.asObservable();
  /** navigator 'online': skip the rest of the current backoff wait. */
  private readonly handleBrowserOnline = () => {
    if (this.manualDisconnect) return;
    if (this.retryTimer !== null) {
      this.clearRetryTimer();
      void this.connect();
      return;
    }
    // No retry timer and no socket means an attempt is parked awaiting
    // connectTarget() (auth resolution can outlive the outage that caused
    // the reconnect). Connectivity returning supersedes it: connect() bumps
    // the epoch, so the late-settling target is discarded harmlessly.
    if (this.socket === null) {
      void this.connect();
    }
  };

  /**
   * navigator 'offline': proactively recycle the current socket. An
   * OS-level offline window never fires WS `close`/`error` — the socket
   * stays `OPEN` and buffers sends silently until the TCP retransmit abort
   * minutes later. The browser telling us it is offline is trustworthy in
   * the direction that matters; tear down now so status flips to
   * reconnecting and the `online` handler can short-circuit recovery.
   */
  private readonly handleBrowserOffline = () => {
    if (this.manualDisconnect) return;
    const socket = this.socket;
    if (socket === null) return;
    this.connectionLost(new Error("browser reported offline"), socket);
  };

  constructor(options: CloudWebSocketTransportOptions) {
    this.options = options;
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? RECONNECT_BASE_DELAY_MS;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? RECONNECT_MAX_DELAY_MS;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
    this.livenessPingIntervalMs = options.livenessPingIntervalMs ?? LIVENESS_PING_INTERVAL_MS;
    this.livenessPongDeadlineMs = options.livenessPongDeadlineMs ?? LIVENESS_PONG_DEADLINE_MS;
    this.random = options.random ?? Math.random;
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // Callers that never await `ready` (tests, fire-and-forget teardown)
    // must not produce an unhandled rejection on manual disconnect.
    this.ready.catch(() => undefined);
    if (typeof window !== "undefined") {
      window.addEventListener("online", this.handleBrowserOnline);
      window.addEventListener("offline", this.handleBrowserOffline);
    }
    void this.connect();
  }

  get connected(): boolean {
    return !this.manualDisconnect && this.socket?.readyState === WebSocket.OPEN;
  }

  private async connect(): Promise<void> {
    if (this.manualDisconnect) return;
    const epoch = ++this.connectEpoch;
    this.clearRetryTimer();

    let target: CloudConnectTarget;
    try {
      // Bounded by the per-attempt budget: a hung auth fetch must become a
      // normal failed attempt riding connectionLost → backoff, not a wedge
      // with no socket, no handshake timer, and no retry timer.
      target = await withReadyTimeout(
        this.options.connectTarget(),
        this.handshakeTimeoutMs,
        `cloud sync connect target did not settle within ${this.handshakeTimeoutMs}ms`,
      );
    } catch (error) {
      if (epoch !== this.connectEpoch || this.manualDisconnect) return;
      this.connectionLost(
        error instanceof Error
          ? new Error(`cloud sync connect target failed: ${error.message}`)
          : new Error(`cloud sync connect target failed: ${String(error)}`),
        null,
      );
      return;
    }
    if (epoch !== this.connectEpoch || this.manualDisconnect) return;

    this.teardownSocket();
    let socket: WebSocket;
    try {
      socket =
        target.protocols.length > 0
          ? new WebSocket(target.url, target.protocols)
          : new WebSocket(target.url);
    } catch (error) {
      this.connectionLost(
        error instanceof Error
          ? new Error(`cloud sync socket creation failed: ${error.message}`)
          : new Error(`cloud sync socket creation failed: ${String(error)}`),
        null,
      );
      return;
    }
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    this.connectionReady = false;
    const onMessage = (event: MessageEvent) => {
      if (socket !== this.socket) return; // superseded connection
      void this.handleMessage(event.data, socket).catch((error: unknown) => {
        const reason =
          error instanceof Error
            ? new Error(`cloud sync socket message failed: ${error.message}`)
            : new Error(`cloud sync socket message failed: ${String(error)}`);
        this.connectionLost(reason, socket);
        socket.close();
      });
    };
    const onError = () => {
      this.connectionLost(new Error("cloud sync socket failed"), socket);
    };
    const onClose = (event: CloseEvent) => {
      const detail = event.reason ? `: ${event.reason}` : "";
      this.connectionLost(new Error(`cloud sync socket closed (${event.code})${detail}`), socket);
    };
    socket.addEventListener("message", onMessage as EventListener);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose as EventListener);
    this.detachSocket = () => {
      socket.removeEventListener("message", onMessage as EventListener);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose as EventListener);
    };
    this.armHandshakeTimer(socket);
  }

  private connectionLost(reason: Error, socket: WebSocket | null): void {
    if (socket !== null && socket !== this.socket) return; // superseded connection
    this.teardownSocket();
    this.connectionReady = false;
    this.clearHandshakeTimer();
    this.stopLivenessProbe();
    // Pending FIFO frame ACKs cannot span sockets.
    this.rejectPendingFrameAcks(reason);
    // Frames queued from a dead connection are bound to that connection's
    // sync state; never replay them into the next one.
    this.queuedFrames = [];
    if (this.manualDisconnect) return;
    this.setStatus(this.everReady ? "reconnecting" : "connecting");
    this.options.onConnectionLost?.(reason);
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.manualDisconnect || this.retryTimer !== null) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, this.nextRetryDelay());
  }

  private nextRetryDelay(): number {
    // Exponential backoff with full ±50% jitter so a fleet of dropped
    // clients does not reconnect in lockstep. The attempt counter resets on
    // cloud_room_ready (the app-level ack), NOT on WS open — a load
    // balancer can accept sockets while the room is unreachable.
    const exponent = Math.min(this.failedAttempts, 16);
    this.failedAttempts += 1;
    const base = Math.min(this.reconnectBaseDelayMs * 2 ** exponent, this.reconnectMaxDelayMs);
    const jitter = 1 + RECONNECT_JITTER_RATIO * (2 * this.random() - 1);
    return Math.round(base * jitter);
  }

  private armHandshakeTimer(socket: WebSocket): void {
    this.clearHandshakeTimer();
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      if (socket !== this.socket) return;
      // The socket opened (or is still connecting) but the room never sent
      // cloud_room_ready — recycle the attempt.
      this.connectionLost(
        new Error(`cloud room handshake did not complete within ${this.handshakeTimeoutMs}ms`),
        socket,
      );
      socket.close();
    }, this.handshakeTimeoutMs);
  }

  private teardownSocket(): void {
    this.detachSocket?.();
    this.detachSocket = null;
    const socket = this.socket;
    this.socket = null;
    if (
      socket &&
      socket.readyState !== WebSocket.CLOSED &&
      socket.readyState !== WebSocket.CLOSING
    ) {
      try {
        socket.close();
      } catch {
        // already closing
      }
    }
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== null) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  /**
   * (Re)start the liveness probe for the connection that just completed
   * its cloud_room_ready handshake. The captured socket pins the probe to
   * that connection: a superseding connect tears the old probe down via
   * `connectionLost` → `stopLivenessProbe`, and the captured-socket guard
   * makes a straggling tick harmless besides.
   */
  private startLivenessProbe(socket: WebSocket): void {
    this.stopLivenessProbe();
    if (this.livenessPingIntervalMs <= 0) return;
    this.livenessPingTimer = setInterval(() => {
      if (socket !== this.socket) {
        this.stopLivenessProbe();
        return;
      }
      this.sendLivenessPing(socket);
    }, this.livenessPingIntervalMs);
    // Node-only (tests): a probe interval must never keep the process
    // alive on its own. No-op in browsers, where timers are numbers.
    unrefTimer(this.livenessPingTimer);
  }

  private sendLivenessPing(socket: WebSocket): void {
    if (socket.readyState !== WebSocket.OPEN) return; // close handler will recycle
    try {
      // Raw text send on purpose: the room's WebSocketRequestResponsePair
      // matches the exact string and replies without waking the DO. The
      // typed-frame channel stays binary-only.
      socket.send(LIVENESS_PING);
    } catch (error) {
      const reason =
        error instanceof Error
          ? new Error(`cloud sync liveness ping failed: ${error.message}`)
          : new Error(`cloud sync liveness ping failed: ${String(error)}`);
      this.connectionLost(reason, socket);
      return;
    }
    // One deadline per OUTSTANDING ping: if a pong is already overdue,
    // keep the original (earlier) deadline rather than extending it.
    if (this.livenessPongTimer !== null) return;
    this.livenessPongTimer = setTimeout(() => {
      this.livenessPongTimer = null;
      if (socket !== this.socket) return;
      // The link is zombie: readyState stays OPEN and sends buffer
      // silently, but the room's auto-response never made it back.
      this.connectionLost(
        new Error(
          `cloud sync liveness pong missed (no reply within ${this.livenessPongDeadlineMs}ms)`,
        ),
        socket,
      );
      socket.close();
    }, this.livenessPongDeadlineMs);
    unrefTimer(this.livenessPongTimer);
  }

  private noteLivenessPong(): void {
    if (this.livenessPongTimer !== null) {
      clearTimeout(this.livenessPongTimer);
      this.livenessPongTimer = null;
    }
  }

  private stopLivenessProbe(): void {
    if (this.livenessPingTimer !== null) {
      clearInterval(this.livenessPingTimer);
      this.livenessPingTimer = null;
    }
    this.noteLivenessPong();
  }

  async sendFrame(frameType: number, payload: Uint8Array): Promise<void> {
    if (this.manualDisconnect) {
      throw new Error("cloud sync socket is closed");
    }
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      // Drop, don't buffer: the engine rolls back via cancel_last_flush and
      // regenerates from sync state after the next handshake.
      throw new Error("cloud sync socket is not open");
    }
    if (!this.connectionReady) {
      // The open→ready handshake window: frames sent now would go out under
      // the PREVIOUS connection's sync state and actor (re-establish runs on
      // cloud_room_ready). Drop-don't-buffer governs here too — the engine
      // rolls back and the post-ready resync regenerates everything.
      throw new Error("cloud sync connection is not ready");
    }
    const frame = new Uint8Array(payload.byteLength + 1);
    frame[0] = frameType;
    frame.set(payload, 1);
    try {
      socket.send(frame);
    } catch (error) {
      const reason =
        error instanceof Error
          ? new Error(`cloud sync socket send failed: ${error.message}`)
          : new Error(`cloud sync socket send failed: ${String(error)}`);
      this.connectionLost(reason, socket);
      throw reason;
    }
  }

  async sendTypedRequest(
    frameType: FrameTypeValue,
    payload: Uint8Array,
    _id: string,
    timeoutMs: number,
    timeoutLabel = "cloud request",
  ): Promise<NotebookResponse> {
    if (frameType !== FrameType.REQUEST) {
      throw new Error(
        `cloud viewer transport does not support typed request frame 0x${frameType.toString(16)}`,
      );
    }

    const pendingAck = this.registerFrameAck(frameType, timeoutMs, timeoutLabel);
    try {
      await this.sendFrame(frameType, payload);
      await pendingAck.promise;
      return { result: "ok" };
    } catch (error) {
      pendingAck.cancel();
      throw error;
    }
  }

  async sendRequest(request: unknown, options?: NotebookRequestOptions): Promise<unknown> {
    const req = request as NotebookRequest;
    const envelope = notebookRequestEnvelope(req, options);
    const payload = new TextEncoder().encode(JSON.stringify(envelope));
    return this.sendTypedRequest(
      FrameType.REQUEST,
      payload,
      envelope.id,
      requestTimeoutMs(req),
      envelope.action,
    );
  }

  onFrame(callback: FrameListener): () => void {
    this.listeners.add(callback);
    for (const frame of this.queuedFrames.splice(0)) {
      callback(frame);
    }
    return () => {
      this.listeners.delete(callback);
    };
  }

  disconnect(): void {
    if (this.manualDisconnect) return;
    this.manualDisconnect = true;
    this.connectEpoch += 1; // invalidate any in-flight connect attempt
    this.clearRetryTimer();
    this.clearHandshakeTimer();
    this.stopLivenessProbe();
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.handleBrowserOnline);
      window.removeEventListener("offline", this.handleBrowserOffline);
    }
    this.teardownSocket();
    this.rejectPendingFrameAcks(new Error("cloud sync socket disconnected"));
    this.listeners.clear();
    this.queuedFrames = [];
    if (!this.readySettled) {
      this.readySettled = true;
      this.readyReject(new Error("cloud sync transport disconnected before ready"));
    }
    this.setStatus("offline");
    this._roomReady$.complete();
  }

  private async handleMessage(data: unknown, socket: WebSocket): Promise<void> {
    // Liveness pongs are the only text frames the room ever sends; handle
    // them before binary decoding (which rejects strings).
    if (data === LIVENESS_PONG) {
      if (socket !== this.socket) return; // superseded connection
      this.noteLivenessPong();
      return;
    }
    const bytes = await bytesFromWebSocketMessage(data);
    if (socket !== this.socket) return; // superseded while decoding
    if (bytes.byteLength === 0) return;

    if (bytes[0] === FrameType.SESSION_CONTROL) {
      const control = JSON.parse(new TextDecoder().decode(bytes.slice(1))) as SessionControlMessage;
      this.options.onControl?.(control);
      if (control.type === "cloud_room_ready") {
        this.handleRoomReady(control, socket);
      } else if (control.type === "cloud_frame_accepted") {
        this.resolveFrameAck(control.frame_type);
      } else if (control.type === "cloud_frame_rejected") {
        this.rejectFrameAck(
          control.frame_type,
          new Error(`cloud room rejected frame: ${control.reason}`),
        );
      }
      return;
    }

    const frame = Array.from(bytes);
    this.emitFrame(frame);
  }

  private handleRoomReady(control: CloudRoomReady, socket: WebSocket): void {
    this.failedAttempts = 0; // backoff resets on the app-level ack
    this.everReady = true;
    // Before the roomReady$ emission: subscribers' resync flush sends on
    // this connection within the same tick.
    this.connectionReady = true;
    this.clearHandshakeTimer();
    this.startLivenessProbe(socket);
    this.setStatus("online");
    if (!this.readySettled) {
      this.readySettled = true;
      this.readyResolve(control);
    }
    // Synchronous emission BEFORE any subsequent frame is dispatched: the
    // room host kicks host-initiated sync immediately after ready, and
    // subscribers must reset per-connection sync state before the first
    // frame of the new connection is applied. WS messages are delivered in
    // order, so emitting inside the ready message's handling precedes them.
    this._roomReady$.next(control);
  }

  private emitFrame(frame: number[]): void {
    if (this.listeners.size === 0) {
      this.queuedFrames.push(frame);
      return;
    }

    for (const listener of this.listeners) {
      listener(frame);
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this._status$.next(status);
  }

  private registerFrameAck(
    frameType: FrameTypeValue,
    timeoutMs: number,
    timeoutLabel: string,
  ): { cancel: () => void; promise: Promise<void> } {
    let pending!: PendingFrameAck;
    const promise = new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.removeFrameAck(frameType, pending);
        reject(new Error(`${timeoutLabel} timed out waiting for cloud room frame acceptance`));
      }, timeoutMs);
      pending = { reject, resolve, timeoutId };
      const queue = this.pendingFrameAcks.get(frameType) ?? [];
      queue.push(pending);
      this.pendingFrameAcks.set(frameType, queue);
    });
    promise.catch(() => undefined);

    return {
      cancel: () => this.removeFrameAck(frameType, pending),
      promise,
    };
  }

  private resolveFrameAck(frameType: number): void {
    const pending = this.shiftFrameAck(frameType);
    if (!pending) return;
    clearTimeout(pending.timeoutId);
    pending.resolve();
  }

  private rejectFrameAck(frameType: number | undefined, error: Error): void {
    if (frameType === undefined) {
      this.rejectPendingFrameAcks(error);
      return;
    }

    const pending = this.shiftFrameAck(frameType);
    if (!pending) return;
    clearTimeout(pending.timeoutId);
    pending.reject(error);
  }

  private shiftFrameAck(frameType: number): PendingFrameAck | undefined {
    const queue = this.pendingFrameAcks.get(frameType);
    const pending = queue?.shift();
    if (!queue || queue.length === 0) {
      this.pendingFrameAcks.delete(frameType);
    }
    return pending;
  }

  private removeFrameAck(frameType: number, pending: PendingFrameAck): void {
    const queue = this.pendingFrameAcks.get(frameType);
    if (!queue) return;
    const index = queue.indexOf(pending);
    if (index === -1) return;
    queue.splice(index, 1);
    clearTimeout(pending.timeoutId);
    if (queue.length === 0) {
      this.pendingFrameAcks.delete(frameType);
    }
  }

  private rejectPendingFrameAcks(error: Error): void {
    for (const queue of this.pendingFrameAcks.values()) {
      for (const pending of queue) {
        clearTimeout(pending.timeoutId);
        pending.reject(error);
      }
    }
    this.pendingFrameAcks.clear();
  }
}

function notebookRequestEnvelope(
  request: NotebookRequest,
  options?: NotebookRequestOptions,
): { action: string; id: string; required_heads?: string[]; [key: string]: unknown } {
  if (!isRecord(request) || typeof request.type !== "string") {
    throw new Error("cloud viewer notebook request must include a string type");
  }

  const { type, ...rest } = request;
  const requiredHeads = options?.required_heads?.filter((head) => head.length > 0);
  return {
    id: crypto.randomUUID(),
    action: type,
    ...(requiredHeads?.length ? { required_heads: requiredHeads } : {}),
    ...rest,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function syncUrl(syncEndpoint: string, sessionId: string, auth: CloudSyncAuth): URL {
  const url = new URL(syncEndpoint, pageHref());
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (auth.user) {
    url.searchParams.set("user", auth.user);
  } else {
    url.searchParams.set("viewer_session", sessionId);
  }
  if (auth.operator) {
    url.searchParams.set("operator", auth.operator);
  } else if (hasAuthenticatedBrowserCredential(auth)) {
    url.searchParams.set("operator", `browser:${encodeURIComponent(sessionId)}`);
  }
  if (auth.requestedScope) {
    url.searchParams.set("scope", auth.requestedScope);
  }
  return url;
}

function pageHref(): string {
  return typeof location === "undefined" ? "http://localhost/" : location.href;
}

function hasAuthenticatedBrowserCredential(auth: CloudSyncAuth): boolean {
  return Boolean(auth.user || auth.protocols.length > 0 || auth.headers.Authorization);
}

async function bytesFromWebSocketMessage(data: unknown): Promise<Uint8Array> {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  throw new Error(`unsupported WebSocket message ${Object.prototype.toString.call(data)}`);
}

export function cloudRoomReadyPeerLabel(
  ready: Pick<
    Extract<SessionControlMessage, { type: "cloud_room_ready" }>,
    "actor_label" | "display_name" | "email"
  >,
): string {
  return identityDisplayLabel({
    displayName: ready.display_name,
    email: ready.email,
    principal: ready.actor_label,
  });
}

const consoleSyncLogger = {
  debug: () => {},
  info: () => {},
  warn: (message: string, ...args: unknown[]) => console.warn(message, ...args),
  error: (message: string, ...args: unknown[]) => console.error(message, ...args),
};

export function syncableCloudHandle(handle: NotebookHandle): SyncableHandle {
  const commsSync = cloudCommsDocSyncMethods(handle);
  return {
    receive_frame: (bytes) =>
      handle.receive_frame(bytes) as ReturnType<SyncableHandle["receive_frame"]>,
    flush_local_changes: () => handle.flush_local_changes() ?? null,
    cancel_last_flush: () => handle.cancel_last_flush(),
    flush_runtime_state_sync: () => handle.flush_runtime_state_sync() ?? null,
    cancel_last_runtime_state_flush: () => handle.cancel_last_runtime_state_flush(),
    generate_runtime_state_sync_reply: () => handle.generate_runtime_state_sync_reply() ?? null,
    flush_comms_doc_sync: commsSync.flush_comms_doc_sync,
    cancel_last_comms_doc_flush: commsSync.cancel_last_comms_doc_flush,
    generate_comms_doc_sync_reply: commsSync.generate_comms_doc_sync_reply,
    // notebook-cloud does not host or display daemon pool state. The shared
    // SyncEngine flushes pool sync opportunistically for Desktop, so the cloud
    // adapter intentionally presents PoolDoc as absent instead of sending a
    // frame the Durable Object should reject for viewer/editor scopes.
    flush_pool_state_sync: () => null,
    cancel_last_pool_state_flush: () => undefined,
    generate_pool_state_sync_reply: () => null,
    reset_sync_state: () => handle.reset_sync_state(),
    cell_count: () => handle.cell_count(),
    get_heads_hex: () => handle.get_heads_hex(),
    get_dependency_fingerprint: () => handle.get_dependency_fingerprint(),
    get_runtime_state: () => handle.get_runtime_state(),
    get_comms_state: () => handle.get_comms_state(),
    resolve_comm_state: (commId) =>
      handle.resolve_comm_state(commId) as
        | {
            state: Record<string, unknown>;
            buffer_paths: string[][];
            text_paths?: string[][];
          }
        | undefined,
  };
}

type CloudCommsDocSyncMethods = Pick<
  SyncableHandle,
  "flush_comms_doc_sync" | "cancel_last_comms_doc_flush" | "generate_comms_doc_sync_reply"
>;

function cloudCommsDocSyncMethods(handle: NotebookHandle): CloudCommsDocSyncMethods {
  const candidate = handle as NotebookHandle &
    Partial<
      Pick<
        NotebookHandle,
        "flush_comms_doc_sync" | "cancel_last_comms_doc_flush" | "generate_comms_doc_sync_reply"
      >
    >;

  if (
    typeof candidate.flush_comms_doc_sync === "function" &&
    typeof candidate.cancel_last_comms_doc_flush === "function" &&
    typeof candidate.generate_comms_doc_sync_reply === "function"
  ) {
    return {
      flush_comms_doc_sync: () => candidate.flush_comms_doc_sync?.() ?? null,
      cancel_last_comms_doc_flush: () => candidate.cancel_last_comms_doc_flush?.(),
      generate_comms_doc_sync_reply: () => candidate.generate_comms_doc_sync_reply?.() ?? null,
    };
  }

  console.warn(
    "[notebook-cloud] runtimed WASM handle is missing CommsDoc sync methods; widget state sync is disabled for this connection",
  );
  return {
    flush_comms_doc_sync: () => null,
    cancel_last_comms_doc_flush: () => undefined,
    generate_comms_doc_sync_reply: () => null,
  };
}

import { BehaviorSubject, type Observable } from "rxjs";
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
import { FrameType, type SessionControlMessage } from "../src/protocol";
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

export interface CloudSyncRuntime {
  actorLabel: string;
  connectionScope: ConnectionScope;
  peerId: string;
  peerLabel: string;
  handle: NotebookHandle;
  engine: SyncEngine;
  transport: CloudWebSocketTransport;
  /** True when the handle was seeded from locally persisted NotebookDoc bytes. */
  seededFromPersistence: boolean;
  /** How the persisted-seed attempt resolved; "read_failed" must not arm saves. */
  persistenceSeedOutcome: CloudPersistenceSeedOutcome;
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
  syncEndpoint: string;
  runtimedWasmModulePath: string;
  runtimedWasmPath: string;
  sessionId: string;
  auth: CloudSyncAuth;
  /** Locally persisted NotebookDoc seed; omitted when storage is unavailable. */
  persistence?: CloudSyncPersistenceSeed;
  onControl?: (message: SessionControlMessage) => void;
  onDisconnect?: (reason: Error) => void;
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

const LIVE_SYNC_READY_TIMEOUT_MS = 30_000;
const CLOUD_REQUEST_TIMEOUT_MS = 30_000;

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
  syncEndpoint,
  runtimedWasmModulePath,
  runtimedWasmPath,
  sessionId,
  auth,
  persistence,
  onControl,
  onDisconnect,
}: CloudSyncConnectOptions): Promise<CloudSyncRuntime> {
  const url = syncUrl(syncEndpoint, sessionId, auth);
  const transport = new CloudWebSocketTransport(url, auth.protocols, onControl, onDisconnect);
  try {
    const ready = await withReadyTimeout(
      transport.ready,
      LIVE_SYNC_READY_TIMEOUT_MS,
      `notebook cloud WebSocket did not become ready within ${LIVE_SYNC_READY_TIMEOUT_MS}ms`,
    );
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
    const peerLabel = cloudRoomReadyPeerLabel(ready);
    const heartbeatPeerId = ready.peer_id;
    const connectionScope = normalizeConnectionScope(ready.connection_scope);
    const engine = new SyncEngine({
      getHandle: () => syncHandle,
      transport,
      presenceHeartbeat: {
        intervalMs: 15_000,
        encode: () => encodeHeartbeatPresenceAfterInit(heartbeatPeerId),
      },
      logger: consoleSyncLogger,
    });

    startCloudBootstrapSync(engine);

    return {
      actorLabel: ready.actor_label,
      connectionScope,
      peerId: ready.peer_id,
      peerLabel,
      handle,
      engine,
      transport,
      seededFromPersistence: persistenceSeedOutcome === "seeded",
      persistenceSeedOutcome,
      sendCursorPresence: (cellId, line, column) => {
        const payload = encodeCursorPresenceAfterInit(
          heartbeatPeerId,
          peerLabel,
          ready.actor_label,
          cellId,
          line,
          column,
        );
        void transport
          .sendFrame(FrameType.PRESENCE, payload)
          .catch((error: unknown) =>
            console.warn("[notebook-cloud] cursor presence failed", error),
          );
      },
      sendSelectionPresence: (cellId, anchorLine, anchorCol, headLine, headCol) => {
        const payload = encodeSelectionPresenceAfterInit(
          heartbeatPeerId,
          peerLabel,
          ready.actor_label,
          cellId,
          anchorLine,
          anchorCol,
          headLine,
          headCol,
        );
        void transport
          .sendFrame(FrameType.PRESENCE, payload)
          .catch((error: unknown) =>
            console.warn("[notebook-cloud] selection presence failed", error),
          );
      },
      sendInteractionPresence: (target) => {
        const payload = encodeInteractionPresenceAfterInit(
          heartbeatPeerId,
          peerLabel,
          ready.actor_label,
          target,
        );
        void transport
          .sendFrame(FrameType.PRESENCE, payload)
          .catch((error: unknown) =>
            console.warn("[notebook-cloud] interaction presence failed", error),
          );
      },
    };
  } catch (error) {
    transport.disconnect();
    throw error;
  }
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

export class CloudWebSocketTransport implements NotebookTransport {
  private socket: WebSocket;
  private listeners = new Set<FrameListener>();
  private queuedFrames: number[][] = [];
  // Hosted room accept/reject controls currently carry only the frame type, not
  // a request id, so pending acknowledgements are matched FIFO per frame type.
  private pendingFrameAcks = new Map<number, PendingFrameAck[]>();
  private readySettled = false;
  private readyResolved = false;
  private closed = false;
  private manualDisconnect = false;
  private readyResolve!: (
    message: Extract<SessionControlMessage, { type: "cloud_room_ready" }>,
  ) => void;
  private readyReject!: (error: Error) => void;
  readonly ready: Promise<Extract<SessionControlMessage, { type: "cloud_room_ready" }>>;
  private status: ConnectionStatus = "connecting";
  private readonly _status$ = new BehaviorSubject<ConnectionStatus>("connecting");
  readonly connectionStatus$: Observable<ConnectionStatus> = this._status$.asObservable();

  constructor(
    url: URL,
    protocols: string[],
    private readonly onControl?: (message: SessionControlMessage) => void,
    private readonly onDisconnect?: (reason: Error) => void,
  ) {
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = (message) => {
        this.readySettled = true;
        this.readyResolved = true;
        this.setStatus("online");
        resolve(message);
      };
      this.readyReject = (error) => {
        this.readySettled = true;
        reject(error);
      };
    });
    this.socket = protocols.length > 0 ? new WebSocket(url, protocols) : new WebSocket(url);
    this.socket.binaryType = "arraybuffer";
    this.socket.addEventListener("message", (event) => {
      void this.handleMessage(event.data).catch((error: unknown) => {
        const reason =
          error instanceof Error
            ? new Error(`cloud sync socket message failed: ${error.message}`)
            : new Error(`cloud sync socket message failed: ${String(error)}`);
        if (!this.readySettled) {
          this.readyReject(reason);
        }
        this.markClosed(reason);
        this.socket.close();
      });
    });
    this.socket.addEventListener("error", () => {
      const reason = new Error(`cloud sync socket failed`);
      if (!this.readySettled) {
        this.readyReject(new Error(`failed to connect ${url.href}`));
      }
      this.markClosed(reason);
    });
    this.socket.addEventListener("close", (event) => {
      const detail = event.reason ? `: ${event.reason}` : "";
      const reason = new Error(`cloud sync socket closed (${event.code})${detail}`);
      if (!this.readySettled) {
        this.readyReject(new Error(`cloud sync socket closed before ready`));
      }
      this.markClosed(reason);
    });
  }

  get connected(): boolean {
    return !this.closed && this.socket.readyState === WebSocket.OPEN;
  }

  async sendFrame(frameType: number, payload: Uint8Array): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("cloud sync socket is closed"));
    }
    await this.waitUntilOpen();
    const frame = new Uint8Array(payload.byteLength + 1);
    frame[0] = frameType;
    frame.set(payload, 1);
    try {
      this.socket.send(frame);
    } catch (error) {
      const reason =
        error instanceof Error
          ? new Error(`cloud sync socket send failed: ${error.message}`)
          : new Error(`cloud sync socket send failed: ${String(error)}`);
      this.markClosed(reason);
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
    this.manualDisconnect = true;
    this.markClosed(new Error("cloud sync socket disconnected"));
    this.socket.close();
  }

  private async handleMessage(data: unknown): Promise<void> {
    const bytes = await bytesFromWebSocketMessage(data);
    if (bytes.byteLength === 0) return;

    if (bytes[0] === FrameType.SESSION_CONTROL) {
      const control = JSON.parse(new TextDecoder().decode(bytes.slice(1))) as SessionControlMessage;
      this.onControl?.(control);
      if (control.type === "cloud_room_ready") {
        this.readyResolve(control);
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

  private emitFrame(frame: number[]): void {
    if (this.listeners.size === 0) {
      this.queuedFrames.push(frame);
      return;
    }

    for (const listener of this.listeners) {
      listener(frame);
    }
  }

  private waitUntilOpen(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    if (
      this.socket.readyState === WebSocket.CLOSED ||
      this.socket.readyState === WebSocket.CLOSING
    ) {
      const reason = new Error("cloud sync socket is closed");
      this.markClosed(reason);
      return Promise.reject(reason);
    }

    return new Promise((resolve, reject) => {
      this.socket.addEventListener("open", () => resolve(), { once: true });
      this.socket.addEventListener("error", () => reject(new Error("cloud sync socket failed")), {
        once: true,
      });
      this.socket.addEventListener("close", () => reject(new Error("cloud sync socket closed")), {
        once: true,
      });
    });
  }

  private markClosed(reason: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.setStatus("offline");
    this.listeners.clear();
    this.queuedFrames = [];
    this.rejectPendingFrameAcks(reason);
    if (this.readyResolved && !this.manualDisconnect) {
      this.onDisconnect?.(reason);
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

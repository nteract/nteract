import {
  SyncEngine,
  type FrameTypeValue,
  type NotebookRequestOptions,
  type NotebookResponse,
  type NotebookTransport,
  type SyncableHandle,
} from "runtimed";
import { isConnectionScope, type ConnectionScope } from "../src/auth-shared";
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
  encodeSelectionPresenceAfterInit,
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
  sendCursorPresence: (cellId: string, line: number, column: number) => void;
  sendSelectionPresence: (
    cellId: string,
    anchorLine: number,
    anchorCol: number,
    headLine: number,
    headCol: number,
  ) => void;
}

export interface CloudSyncConnectOptions {
  syncEndpoint: string;
  runtimedWasmModulePath: string;
  runtimedWasmPath: string;
  sessionId: string;
  auth: CloudSyncAuth;
  onControl?: (message: SessionControlMessage) => void;
  onDisconnect?: (reason: Error) => void;
}

type FrameListener = Parameters<NotebookTransport["onFrame"]>[0];

const LIVE_SYNC_READY_TIMEOUT_MS = 30_000;

export function cloudSyncAuthFromLocalStorage(): CloudSyncAuth {
  return cloudSyncAuthFromPrototypeAuthState(cloudPrototypeAuthFromWindow());
}

export async function connectCloudSyncRuntime({
  syncEndpoint,
  runtimedWasmModulePath,
  runtimedWasmPath,
  sessionId,
  auth,
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
    const handle = await createBootstrapNotebookHandle(
      ready.actor_label,
      new URL(runtimedWasmModulePath, location.href),
      new URL(runtimedWasmPath, location.href),
    );
    const syncHandle = syncableCloudHandle(handle);
    const peerLabel = actorPeerLabel(ready.actor_label);
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
  private readySettled = false;
  private readyResolved = false;
  private closed = false;
  private manualDisconnect = false;
  private readyResolve!: (
    message: Extract<SessionControlMessage, { type: "cloud_room_ready" }>,
  ) => void;
  private readyReject!: (error: Error) => void;
  readonly ready: Promise<Extract<SessionControlMessage, { type: "cloud_room_ready" }>>;

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
      void this.handleMessage(event.data);
    });
    this.socket.addEventListener("error", () => {
      this.readyReject(new Error(`failed to connect ${url.href}`));
    });
    this.socket.addEventListener("close", (event) => {
      this.closed = true;
      this.listeners.clear();
      this.queuedFrames = [];
      const detail = event.reason ? `: ${event.reason}` : "";
      const reason = new Error(`cloud sync socket closed (${event.code})${detail}`);
      if (!this.readySettled) {
        this.readyReject(new Error(`cloud sync socket closed before ready`));
      }
      if (this.readyResolved && !this.manualDisconnect) {
        this.onDisconnect?.(reason);
      }
    });
  }

  get connected(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  async sendFrame(frameType: number, payload: Uint8Array): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("cloud sync socket is closed"));
    }
    await this.waitUntilOpen();
    const frame = new Uint8Array(payload.byteLength + 1);
    frame[0] = frameType;
    frame.set(payload, 1);
    this.socket.send(frame);
  }

  async sendTypedRequest(
    _frameType: FrameTypeValue,
    _payload: Uint8Array,
    _id: string,
    _timeoutMs: number,
    _timeoutLabel?: string,
  ): Promise<NotebookResponse> {
    throw new Error("cloud viewer transport does not support request/response frames yet");
  }

  async sendRequest(_request: unknown, _options?: NotebookRequestOptions): Promise<unknown> {
    throw new Error("cloud viewer transport does not support notebook requests yet");
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
    this.closed = true;
    this.listeners.clear();
    this.queuedFrames = [];
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
      }
      return;
    }

    this.emitFrame(Array.from(bytes));
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
      return Promise.reject(new Error("cloud sync socket is closed"));
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
}

function syncUrl(syncEndpoint: string, sessionId: string, auth: CloudSyncAuth): URL {
  const url = new URL(syncEndpoint, location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (auth.user) {
    url.searchParams.set("user", auth.user);
  } else {
    url.searchParams.set("viewer_session", sessionId);
  }
  if (auth.operator) {
    url.searchParams.set("operator", auth.operator);
  }
  if (auth.requestedScope) {
    url.searchParams.set("scope", auth.requestedScope);
  }
  return url;
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

function actorPeerLabel(actorLabel: string): string {
  const [principal, operator] = actorLabel.split("/", 2);
  return operator ? `${principal} (${operator})` : actorLabel;
}

const consoleSyncLogger = {
  debug: (message: string, ...args: unknown[]) => console.debug(message, ...args),
  info: (message: string, ...args: unknown[]) => console.info(message, ...args),
  warn: (message: string, ...args: unknown[]) => console.warn(message, ...args),
  error: (message: string, ...args: unknown[]) => console.error(message, ...args),
};

export function syncableCloudHandle(handle: NotebookHandle): SyncableHandle {
  return {
    receive_frame: (bytes) =>
      handle.receive_frame(bytes) as ReturnType<SyncableHandle["receive_frame"]>,
    flush_local_changes: () => handle.flush_local_changes() ?? null,
    cancel_last_flush: () => handle.cancel_last_flush(),
    flush_runtime_state_sync: () => handle.flush_runtime_state_sync() ?? null,
    cancel_last_runtime_state_flush: () => handle.cancel_last_runtime_state_flush(),
    generate_runtime_state_sync_reply: () => handle.generate_runtime_state_sync_reply() ?? null,
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
  };
}

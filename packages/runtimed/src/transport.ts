/**
 * NotebookTransport interface and frame type constants.
 *
 * The transport is the pluggable boundary between the SyncEngine and the
 * underlying connection to the daemon. Implementations:
 *   - TauriTransport (desktop app, lives in packages/notebook-host)
 *   - CloudWebSocketTransport (cloud viewer, lives in apps/notebook-cloud)
 *   - DirectTransport (testing, lives in this package)
 */

import type { Observable } from "rxjs";

import type { NotebookResponse } from "./request-types";

import { FrameType } from "./wire-constants";
import type { FrameTypeValue } from "./wire-constants";
export {
  FrameType,
  MAX_CONTROL_FRAME_SIZE,
  MAX_FRAME_SIZE,
  frameSizeLimits,
} from "./wire-constants";
export type { FrameSizeLimits, FrameTypeValue } from "./wire-constants";

export function sendAutomergeSyncFrame(
  transport: Pick<NotebookTransport, "sendFrame">,
  payload: Uint8Array,
): Promise<void> {
  return transport.sendFrame(FrameType.AUTOMERGE_SYNC, payload);
}

export function sendPresenceFrame(
  transport: Pick<NotebookTransport, "sendFrame">,
  payload: Uint8Array,
): Promise<void> {
  return transport.sendFrame(FrameType.PRESENCE, payload);
}

// ── Transport interface ──────────────────────────────────────────────

/** Callback for receiving inbound frames from the daemon. */
export type FrameListener = (payload: number[]) => void;

/**
 * Connection lifecycle state emitted by `NotebookTransport.connectionStatus$`.
 *
 * - `"connecting"` — initial state before the first successful connection.
 * - `"online"` — transport is connected and operational.
 * - `"offline"` — transport has lost its connection (non-manual close).
 * - `"reconnecting"` — reconnect attempt in progress (reserved for transports with retry logic).
 */
export type ConnectionStatus = "connecting" | "online" | "offline" | "reconnecting";

export interface NotebookRequestOptions {
  /** Causal precondition: daemon must have these notebook heads before handling. */
  required_heads?: string[];
}

/**
 * Pluggable connection layer between SyncEngine and the daemon.
 *
 * Implementations handle the mechanics of sending/receiving bytes
 * (Tauri IPC, WebSocket, in-memory for tests) while the SyncEngine
 * owns all sync logic.
 */
export interface NotebookTransport {
  /**
   * Send a typed frame to the daemon.
   *
   * Prepends the frame type byte to the payload and delivers the
   * resulting bytes via the underlying connection.
   */
  sendFrame(frameType: number, payload: Uint8Array): Promise<void>;

  /**
   * Send a typed request-like frame and await a NotebookResponse.
   *
   * This is the generic correlation path for outbound frames that receive a
   * `FrameType.RESPONSE` envelope by id. `sendRequest` is the JSON request
   * wrapper over this path; PutBlob uses it with `FrameType.PUT_BLOB`.
   */
  sendTypedRequest(
    frameType: FrameTypeValue,
    payload: Uint8Array,
    id: string,
    timeoutMs: number,
    timeoutLabel?: string,
  ): Promise<NotebookResponse>;

  /**
   * Register a callback for inbound frames from the daemon.
   *
   * Returns an unsubscribe function. The payload is the raw byte array
   * from the daemon (including frame type prefix, depending on transport).
   */
  onFrame(callback: FrameListener): () => void;

  /**
   * Send a typed request to the daemon and await its response.
   *
   * The request is a `NotebookRequest` discriminated union. The
   * transport is responsible for encoding, delivery, and correlation.
   *
   * - TauriTransport: maps to Tauri `invoke()` commands
   * - WebSocketTransport: serializes as frame type 0x01 with correlation ID
   * - DirectTransport: delegates to a configurable handler
   */
  sendRequest(request: unknown, options?: NotebookRequestOptions): Promise<unknown>;

  /** Whether the transport is currently connected. */
  readonly connected: boolean;

  /**
   * Observable that emits the current connection state whenever it changes.
   *
   * Reflects the physical transport connection: whether the underlying socket
   * or IPC channel is open. This is not a sync-readiness signal — consumers
   * that need to know when the notebook doc is ready to read should use
   * `SyncEngine.initialSyncComplete$`; those that want to persist on each
   * change should debounce `SyncEngine.notebookDocChanged$`.
   */
  readonly connectionStatus$: Observable<ConnectionStatus>;

  /** Tear down the transport (unlisten, close connections). */
  disconnect(): void;
}

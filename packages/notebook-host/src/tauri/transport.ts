/**
 * `TauriTransport` — `NotebookTransport` implementation for the Tauri desktop app.
 *
 * Bridges the `runtimed` `SyncEngine` to the daemon via Tauri IPC:
 *   - `sendFrame` → `invoke("send_frame", bytes)`
 *   - `onFrame` → fanout from a Tauri `Channel` registered with Rust
 *   - `sendRequest` → encode `NotebookRequestEnvelope`, send as `0x01` frame,
 *                     wait for matching `0x02` response via an internal
 *                     channel dispatch keyed by correlation id.
 *
 * The pending map is dispatched directly off the same inbound channel as sync
 * frames so Rust and JS callers can share the same socket concurrently —
 * responses are dispatched by id, not by serialization order.
 */

import { Channel, invoke } from "@tauri-apps/api/core";
import {
  FrameType,
  type FrameTypeValue,
  type FrameListener,
  type NotebookRequest,
  type NotebookRequestOptions,
  type NotebookResponse,
  type NotebookTransport,
} from "runtimed";

const FRAME_TYPE_REQUEST = 0x01;
const FRAME_TYPE_RESPONSE = 0x02;

type ChannelFramePayload = ArrayBuffer | Uint8Array | number[];

/** Per-request-type timeouts. Mirror `relay_task::request_timeout` in Rust. */
function requestTimeoutMs(request: NotebookRequest): number {
  switch (request.type) {
    case "launch_kernel":
    case "sync_environment":
      return 300_000;
    case "complete":
      return 7_000;
    default:
      return 30_000;
  }
}

function normalizeFramePayload(payload: ChannelFramePayload): number[] {
  if (payload instanceof Uint8Array) return Array.from(payload);
  if (payload instanceof ArrayBuffer) return Array.from(new Uint8Array(payload));
  return payload;
}

interface PendingEntry {
  resolve: (response: NotebookResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class TauriTransport implements NotebookTransport {
  private _connected = true;
  private subscribers = new Set<FrameListener>();
  private frameChannel = new Channel<ChannelFramePayload>((payload) =>
    this.dispatchInboundFrame(payload),
  );
  private frameChannelGeneration: number | undefined;
  private frameChannelSubscription: Promise<void> | null = null;
  /** In-flight requests keyed by correlation id. */
  private pending = new Map<string, PendingEntry>();

  get connected(): boolean {
    return this._connected;
  }

  async subscribeNotebookFrames(generation?: number): Promise<void> {
    if (this.frameChannelSubscription && this.frameChannelGeneration === generation) {
      return this.frameChannelSubscription;
    }

    this.frameChannelGeneration = generation;
    const subscription = invoke<void>("subscribe_notebook_frames", {
      generation,
      channel: this.frameChannel,
    })
      .then(() => undefined)
      .catch((err) => {
        if (this.frameChannelGeneration === generation) {
          this.frameChannelSubscription = null;
        }
        throw err;
      });
    this.frameChannelSubscription = subscription;

    return subscription;
  }

  async sendFrame(frameType: number, payload: Uint8Array): Promise<void> {
    if (frameType === FrameType.SESSION_CONTROL) {
      throw new Error("SESSION_CONTROL is server-originated only");
    }
    const frame = new Uint8Array(1 + payload.length);
    frame[0] = frameType;
    frame.set(payload, 1);
    return invoke("send_frame", frame);
  }

  async sendTypedRequest(
    frameType: FrameTypeValue,
    payload: Uint8Array,
    id: string,
    timeoutMs: number,
    timeoutLabel?: string,
  ): Promise<NotebookResponse> {
    const promise = this.awaitResponse(id, timeoutMs, timeoutLabel);
    void this.sendFrame(frameType, payload).catch((err) => this.failPending(id, err));
    return promise;
  }

  onFrame(callback: FrameListener): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async sendRequest(request: unknown, options?: NotebookRequestOptions): Promise<unknown> {
    const req = request as NotebookRequest;
    const id = crypto.randomUUID();

    // Wire shape matches Rust's `NotebookRequestEnvelope` with
    // `#[serde(tag = "action")]` on the flattened `NotebookRequest`:
    //   { id: "...", action: "execute_cell", cell_id: "..." }
    // TS uses `type:` as the discriminator internally, so translate on
    // the way out.
    const { type, ...rest } = req as { type: string } & Record<string, unknown>;
    const envelope = {
      id,
      ...(options?.required_heads?.length ? { required_heads: options.required_heads } : {}),
      action: type,
      ...rest,
    };
    const payload = new TextEncoder().encode(JSON.stringify(envelope));

    const timeoutMs = requestTimeoutMs(req);

    return this.sendTypedRequest(FRAME_TYPE_REQUEST, payload, id, timeoutMs, type);
  }

  disconnect(): void {
    this._connected = false;
    this.subscribers.clear();
    // Reject any still-pending requests so callers don't hang.
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`Transport disconnected (request ${id})`));
    }
    this.pending.clear();
  }

  private dispatchInboundFrame(payload: ChannelFramePayload): void {
    if (!this._connected) return;

    const frame = normalizeFramePayload(payload);
    try {
      this.dispatchResponseFrame(frame);
    } catch (err) {
      console.error("[tauri-transport] response dispatch failed:", err);
    }

    const subscribers = Array.from(this.subscribers);
    for (const callback of subscribers) {
      try {
        callback(frame);
      } catch (err) {
        console.error("[tauri-transport] frame subscriber failed:", err);
      }
    }
  }

  private awaitResponse(
    id: string,
    timeoutMs: number,
    timeoutLabel?: string,
  ): Promise<NotebookResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          const suffix = timeoutLabel ? `: ${timeoutLabel}` : "";
          reject(new Error(`Request timeout after ${timeoutMs}ms${suffix}`));
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  private failPending(id: string, err: unknown): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.reject(err instanceof Error ? err : new Error(String(err)));
  }

  private dispatchResponseFrame(bytes: number[] | Uint8Array): void {
    const first = (bytes as { [i: number]: number })[0];
    if (first !== FRAME_TYPE_RESPONSE) return;

    const view =
      bytes instanceof Uint8Array ? bytes.subarray(1) : new Uint8Array(Array.from(bytes).slice(1));
    const json = new TextDecoder().decode(view);

    let envelope: { id?: string } & Record<string, unknown>;
    try {
      envelope = JSON.parse(json);
    } catch (err) {
      console.error("[tauri-transport] malformed response envelope:", err);
      return;
    }

    const id = envelope.id;
    if (typeof id !== "string") return;

    const entry = this.pending.get(id);
    if (!entry) return;

    this.pending.delete(id);
    clearTimeout(entry.timer);

    // Strip the envelope id from the returned response so callers see a
    // clean `NotebookResponse`.
    const { id: _id, ...response } = envelope;
    entry.resolve(response as NotebookResponse);
  }
}

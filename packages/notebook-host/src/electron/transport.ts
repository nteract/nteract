import { BehaviorSubject, type Observable } from "rxjs";
import {
  FrameType,
  type ConnectionStatus,
  type FrameListener,
  type FrameTypeValue,
  type NotebookRequest,
  type NotebookRequestOptions,
  type NotebookResponse,
  type NotebookTransport,
} from "runtimed";
import { ElectronHostClient } from "./client";

const FRAME_TYPE_REQUEST = 0x01;
const FRAME_TYPE_RESPONSE = 0x02;

interface PendingEntry {
  resolve: (response: NotebookResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

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

function normalizeFrame(frame: ArrayBuffer | Uint8Array | number[]): number[] {
  if (frame instanceof ArrayBuffer) return Array.from(new Uint8Array(frame));
  return Array.from(frame);
}

/** NotebookTransport backed by a transferred Electron MessagePort. */
export class ElectronTransport implements NotebookTransport {
  private readonly client: ElectronHostClient;
  private readonly subscribers = new Set<FrameListener>();
  private readonly pending = new Map<string, PendingEntry>();
  private readonly disposers: Array<() => void>;
  private queuedFrames: Array<ArrayBuffer | Uint8Array | number[]> = [];
  private framesReleased = false;
  private _connected = true;
  private readonly _status$ = new BehaviorSubject<ConnectionStatus>("online");
  readonly connectionStatus$: Observable<ConnectionStatus> = this._status$.asObservable();

  constructor(client: ElectronHostClient) {
    this.client = client;
    this.disposers = [
      client.subscribe((message) => {
        if (message.type === "nteract:frame") this.dispatchInboundFrame(message.frame);
      }),
      client.onEvent("transport.status", (status) => this.setStatus(status)),
    ];
  }

  get connected(): boolean {
    return this._connected;
  }

  /** Release bootstrap frames only after SyncEngine has attached its listener. */
  releaseFrames(): void {
    if (this.framesReleased) return;
    this.framesReleased = true;
    for (const frame of this.queuedFrames.splice(0)) this.dispatchInboundFrame(frame);
  }

  async sendFrame(frameType: number, payload: Uint8Array): Promise<void> {
    if (frameType === FrameType.SESSION_CONTROL) {
      throw new Error("SESSION_CONTROL is server-originated only");
    }
    if (!this._connected) throw new Error("Electron transport is offline.");

    const frame = new Uint8Array(1 + payload.length);
    frame[0] = frameType;
    frame.set(payload, 1);
    this.client.postFrame(frame);
  }

  async sendTypedRequest(
    frameType: FrameTypeValue,
    payload: Uint8Array,
    id: string,
    timeoutMs: number,
    timeoutLabel?: string,
  ): Promise<NotebookResponse> {
    const response = this.awaitResponse(id, timeoutMs, timeoutLabel);
    void this.sendFrame(frameType, payload).catch((error) => this.failPending(id, error));
    return response;
  }

  onFrame(callback: FrameListener): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  async sendRequest(request: unknown, options?: NotebookRequestOptions): Promise<unknown> {
    const typedRequest = request as NotebookRequest;
    const id = crypto.randomUUID();
    const { type, ...rest } = typedRequest as { type: string } & Record<string, unknown>;
    const envelope = {
      id,
      ...(options?.required_heads?.length ? { required_heads: options.required_heads } : {}),
      action: type,
      ...rest,
    };
    const payload = new TextEncoder().encode(JSON.stringify(envelope));
    return this.sendTypedRequest(
      FRAME_TYPE_REQUEST,
      payload,
      id,
      requestTimeoutMs(typedRequest),
      type,
    );
  }

  disconnect(): void {
    if (!this._connected && this.disposers.length === 0) return;
    this.setStatus("offline");
    for (const dispose of this.disposers.splice(0)) dispose();
    this.client.close();
    this.subscribers.clear();
    this.rejectPendingRequests(new Error("Electron transport disconnected."));
  }

  private setStatus(status: ConnectionStatus): void {
    this._connected = status === "online";
    this._status$.next(status);
    if (status === "offline") {
      this.rejectPendingRequests(new Error("Electron transport is offline."));
    }
  }

  private dispatchInboundFrame(framePayload: ArrayBuffer | Uint8Array | number[]): void {
    if (!this.framesReleased) {
      this.queuedFrames.push(framePayload);
      return;
    }
    const frame = normalizeFrame(framePayload);
    try {
      this.dispatchResponseFrame(frame);
    } catch (error) {
      console.error("[electron-transport] response dispatch failed:", error);
    }

    for (const callback of Array.from(this.subscribers)) {
      try {
        callback(frame);
      } catch (error) {
        console.error("[electron-transport] frame subscriber failed:", error);
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

  private failPending(id: string, error: unknown): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.reject(error instanceof Error ? error : new Error(String(error)));
  }

  private rejectPendingRequests(error: Error): void {
    for (const [id] of this.pending) this.failPending(id, error);
  }

  private dispatchResponseFrame(frame: number[]): void {
    if (frame[0] !== FRAME_TYPE_RESPONSE) return;
    const envelope = JSON.parse(new TextDecoder().decode(new Uint8Array(frame.slice(1)))) as {
      id?: string;
    } & Record<string, unknown>;
    if (typeof envelope.id !== "string") return;

    const entry = this.pending.get(envelope.id);
    if (!entry) return;
    this.pending.delete(envelope.id);
    clearTimeout(entry.timer);
    const { id: _id, ...response } = envelope;
    entry.resolve(response as NotebookResponse);
  }
}

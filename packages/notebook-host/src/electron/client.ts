import type {
  ElectronHostEvent,
  ElectronHostEventMessage,
  ElectronHostEventMap,
  ElectronHostFailureMessage,
  ElectronHostFrameMessage,
  ElectronHostMethod,
  ElectronHostMethodParams,
  ElectronHostMethodResult,
  ElectronHostNotification,
  ElectronHostSuccessMessage,
} from "./protocol";

type ElectronHostInboundMessage = ElectronHostFrameMessage | ElectronHostEventMessage;
type PortListener = (message: ElectronHostInboundMessage) => void;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout> | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isResponseMessage(
  value: unknown,
): value is ElectronHostSuccessMessage | ElectronHostFailureMessage {
  if (!isRecord(value)) return false;
  if (
    value.type !== "nteract:host-response" ||
    typeof value.id !== "string" ||
    typeof value.ok !== "boolean"
  ) {
    return false;
  }
  return value.ok || typeof value.error === "string";
}

function isInboundMessage(value: unknown): value is ElectronHostInboundMessage {
  if (!isRecord(value)) return false;
  if (value.type === "nteract:frame") {
    return (
      value.frame instanceof ArrayBuffer ||
      value.frame instanceof Uint8Array ||
      (Array.isArray(value.frame) && value.frame.every((byte) => Number.isInteger(byte)))
    );
  }
  return (
    value.type === "nteract:host-event" && typeof value.event === "string" && "payload" in value
  );
}

/**
 * Owns the transferred renderer-side MessagePort and multiplexes runtime
 * frames, host RPC, and host events without exposing Electron's ipcRenderer.
 */
export class ElectronHostClient {
  private readonly port: MessagePort;
  private readonly listeners = new Set<PortListener>();
  private readonly pending = new Map<string, PendingRequest>();
  private closed = false;

  constructor(port: MessagePort) {
    this.port = port;
    this.port.addEventListener("message", this.onMessage);
    this.port.addEventListener("messageerror", this.onMessageError);
  }

  /** Begin delivery after transports and event subscribers are attached. */
  start(): void {
    this.port.start();
  }

  invoke<M extends ElectronHostMethod>(
    method: M,
    params: ElectronHostMethodParams<M>,
    options: { timeoutMs?: number } = {},
  ): Promise<ElectronHostMethodResult<M>> {
    if (this.closed) return Promise.reject(new Error("Electron host connection is closed."));

    const id = crypto.randomUUID();
    const timeoutMs = options.timeoutMs ?? 30_000;
    const promise = new Promise<ElectronHostMethodResult<M>>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              if (this.pending.delete(id)) {
                reject(
                  new Error(`Electron host request timed out after ${timeoutMs}ms: ${method}`),
                );
              }
            }, timeoutMs)
          : null;
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
    });

    try {
      this.port.postMessage({
        type: "nteract:host-request",
        id,
        method,
        params,
      });
    } catch (error) {
      this.rejectPending(id, error);
    }

    return promise;
  }

  notify(notification: ElectronHostNotification): void {
    if (this.closed) return;
    try {
      this.port.postMessage({
        type: "nteract:host-notification",
        notification,
      });
    } catch {
      // Logging and other notifications must never break the notebook UI.
    }
  }

  postFrame(frame: Uint8Array): void {
    if (this.closed) throw new Error("Electron host connection is closed.");
    const copy = frame.slice();
    // Transfer the copied buffer instead of cloning frame bytes across the
    // renderer/main boundary. Detaching `copy` is intentional; the caller's
    // original frame remains untouched.
    this.port.postMessage({ type: "nteract:frame", frame: copy.buffer }, [copy.buffer]);
  }

  subscribe(listener: PortListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onEvent<E extends ElectronHostEvent>(
    eventName: E,
    listener: (payload: ElectronHostEventMap[E]) => void,
  ): () => void {
    return this.subscribe((message) => {
      if (message.type === "nteract:host-event" && message.event === eventName) {
        listener(message.payload as ElectronHostEventMap[E]);
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.port.removeEventListener("message", this.onMessage);
    this.port.removeEventListener("messageerror", this.onMessageError);
    this.port.close();
    this.rejectAll(new Error("Electron host connection is closed."));
    this.listeners.clear();
  }

  private readonly onMessage = (event: MessageEvent<unknown>) => {
    const message = event.data;
    if (isResponseMessage(message)) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (entry.timer !== null) clearTimeout(entry.timer);
      if (message.ok) entry.resolve(message.value);
      else entry.reject(new Error(message.error));
      return;
    }

    if (!isInboundMessage(message)) return;
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(message);
      } catch (error) {
        console.error("[electron-host] port listener failed:", error);
      }
    }
  };

  private readonly onMessageError = () => {
    this.rejectAll(new Error("Electron host sent an unreadable MessagePort payload."));
  };

  private rejectPending(id: string, error: unknown): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.reject(error instanceof Error ? error : new Error(String(error)));
  }

  private rejectAll(error: Error): void {
    for (const [id] of this.pending) this.rejectPending(id, error);
  }
}

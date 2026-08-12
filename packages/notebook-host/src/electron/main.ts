import {
  isElectronHostMethod,
  type ElectronHostEvent,
  type ElectronHostEventMap,
  type ElectronHostMethod,
  type ElectronHostMethodParams,
  type ElectronHostMethodResult,
  type ElectronHostNotification,
} from "./protocol";

/** Structural subset of Electron's MessagePortMain used by this adapter. */
export interface ElectronMainPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): this;
  off(event: "message", listener: (event: { data: unknown }) => void): this;
  start(): void;
  close(): void;
}

/** Structural subset of `@runtimed/node/relay`'s RelaySession. */
export interface ElectronRelaySession {
  send(frame: Uint8Array | ArrayBuffer): Promise<void>;
  onFrame(listener: (frame: Uint8Array) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): Promise<void>;
}

export interface ElectronNotebookHostHandler {
  invoke<M extends ElectronHostMethod>(
    method: M,
    params: ElectronHostMethodParams<M>,
  ): Promise<ElectronHostMethodResult<M>> | ElectronHostMethodResult<M>;
  notify?(notification: ElectronHostNotification): void;
}

export interface ServeElectronNotebookHostOptions {
  /** One endpoint of a MessageChannelMain; transfer the other to the iframe. */
  port: ElectronMainPort;
  /** An already-authorized, notebook-scoped `@runtimed/node/relay` session. */
  relay: ElectronRelaySession;
  /** Capability allowlist implementation for filesystem/window/platform calls. */
  handler: ElectronNotebookHostHandler;
}

export interface ElectronNotebookHostServer {
  emit<E extends ElectronHostEvent>(event: E, payload: ElectronHostEventMap[E]): void;
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeFrame(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value) && value.every((part) => Number.isInteger(part))) {
    return new Uint8Array(value);
  }
  return null;
}

function isHostNotification(value: unknown): value is ElectronHostNotification {
  if (!isRecord(value) || !isRecord(value.params) || typeof value.params.message !== "string") {
    return false;
  }
  return ["log.debug", "log.info", "log.warn", "log.error"].includes(String(value.method));
}

/**
 * Attach an authorized native relay and narrow host handler to MessagePortMain.
 *
 * This is the Electron main-process half of `createElectronHost`. It never
 * opens a TCP/WebSocket listener and never sends the daemon socket path to a
 * renderer. The embedding app remains responsible for authorizing the relay
 * before calling this function.
 */
export function serveElectronNotebookHost(
  options: ServeElectronNotebookHostOptions,
): ElectronNotebookHostServer {
  let closed = false;
  let relayClosed = false;

  const emitEvent = <E extends ElectronHostEvent>(event: E, payload: ElectronHostEventMap[E]) => {
    if (!closed) options.port.postMessage({ type: "nteract:host-event", event, payload });
  };

  const sendResponse = (
    id: string,
    response: { ok: true; value: unknown } | { ok: false; error: string },
  ) => {
    if (closed) return;
    options.port.postMessage({ type: "nteract:host-response", id, ...response });
  };

  const onPortMessage = (event: { data: unknown }) => {
    if (closed || !isRecord(event.data)) return;
    const message = event.data;

    if (message.type === "nteract:frame") {
      const frame = normalizeFrame(message.frame);
      if (frame) void options.relay.send(frame).catch(() => server.close());
      return;
    }

    if (message.type === "nteract:host-notification") {
      const notification = message.notification;
      if (isHostNotification(notification)) options.handler.notify?.(notification);
      return;
    }

    if (
      message.type !== "nteract:host-request" ||
      typeof message.id !== "string" ||
      !isElectronHostMethod(message.method)
    ) {
      return;
    }

    const method = message.method;
    void Promise.resolve(
      options.handler.invoke(method, message.params as ElectronHostMethodParams<typeof method>),
    ).then(
      (value) => sendResponse(message.id as string, { ok: true, value }),
      (error: unknown) =>
        sendResponse(message.id as string, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
  };

  const unlistenFrame = options.relay.onFrame((frame) => {
    if (!closed) options.port.postMessage({ type: "nteract:frame", frame: Uint8Array.from(frame) });
  });
  const unlistenClose = options.relay.onClose(() => {
    relayClosed = true;
    emitEvent("transport.status", "offline");
  });

  const server: ElectronNotebookHostServer = {
    emit: emitEvent,
    async close() {
      if (closed) return;
      closed = true;
      options.port.off("message", onPortMessage);
      unlistenFrame();
      unlistenClose();
      options.port.close();
      await options.relay.close();
    },
  };

  options.port.on("message", onPortMessage);
  options.port.start();
  emitEvent("transport.status", relayClosed ? "offline" : "online");
  return server;
}

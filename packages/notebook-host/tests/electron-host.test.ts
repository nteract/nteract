// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createElectronHost } from "../src/electron";
import {
  ELECTRON_HOST_METHODS as ELECTRON_MAIN_HOST_METHODS,
  serveElectronNotebookHost,
  type ElectronMainPort,
  type ElectronNotebookHostHandler,
  type ElectronRelaySession,
} from "@runtimed/node/electron";
import {
  ELECTRON_HOST_METHODS as ELECTRON_RENDERER_HOST_METHODS,
  ELECTRON_HOST_PROTOCOL_VERSION,
} from "../src/electron/protocol";

class LinkedRendererPort extends EventTarget {
  peer: LinkedMainPort | null = null;
  readonly transferLists: Transferable[][] = [];

  postMessage(message: unknown, transfer?: Transferable[]): void {
    if (transfer) this.transferLists.push(transfer);
    queueMicrotask(() => this.peer?.deliver(message));
  }

  start(): void {}
  close(): void {
    this.peer?.deliverClose();
  }
}

class LinkedMainPort implements ElectronMainPort {
  peer: LinkedRendererPort | null = null;
  private listeners = new Set<(event: { data: unknown }) => void>();
  private closeListeners = new Set<() => void>();

  postMessage(message: unknown): void {
    queueMicrotask(() => this.peer?.dispatchEvent(new MessageEvent("message", { data: message })));
  }

  on(_event: "message", _listener: (event: { data: unknown }) => void): this;
  on(_event: "close", _listener: () => void): this;
  on(
    _event: "message" | "close",
    listener: ((event: { data: unknown }) => void) | (() => void),
  ): this {
    if (_event === "message") this.listeners.add(listener as (event: { data: unknown }) => void);
    else this.closeListeners.add(listener as () => void);
    return this;
  }

  off(_event: "message", listener: (event: { data: unknown }) => void): this;
  off(_event: "close", _listener: () => void): this;
  off(
    _event: "message" | "close",
    listener: ((event: { data: unknown }) => void) | (() => void),
  ): this {
    if (_event === "message") this.listeners.delete(listener as (event: { data: unknown }) => void);
    else this.closeListeners.delete(listener as () => void);
    return this;
  }

  deliver(message: unknown): void {
    for (const listener of this.listeners) listener({ data: message });
  }

  deliverClose(): void {
    for (const listener of this.closeListeners) listener();
  }

  start(): void {}
  close(): void {}
}

function linkedPorts(): {
  renderer: MessagePort;
  rendererPort: LinkedRendererPort;
  main: ElectronMainPort;
} {
  const renderer = new LinkedRendererPort();
  const main = new LinkedMainPort();
  renderer.peer = main;
  main.peer = renderer;
  return { renderer: renderer as unknown as MessagePort, rendererPort: renderer, main };
}

function fakeRelay() {
  let frameListener: ((frame: Uint8Array) => void) | null = null;
  let closeListener: (() => void) | null = null;
  const sent: Uint8Array[] = [];
  let sendHook: ((frame: Uint8Array) => void) | null = null;
  const close = vi.fn(async () => {});
  const relay: ElectronRelaySession = {
    async send(frame) {
      const copy = frame instanceof Uint8Array ? Uint8Array.from(frame) : new Uint8Array(frame);
      sent.push(copy);
      sendHook?.(copy);
    },
    onFrame(listener) {
      frameListener = listener;
      return () => {
        frameListener = null;
      };
    },
    onClose(listener) {
      closeListener = listener;
      return () => {
        closeListener = null;
      };
    },
    close,
  };
  return {
    relay,
    close,
    sent,
    emitFrame(frame: Uint8Array) {
      frameListener?.(frame);
    },
    emitClose() {
      closeListener?.();
    },
    onSend(callback: (frame: Uint8Array) => void) {
      sendHook = callback;
    },
  };
}

const flushMessages = () => new Promise<void>((resolve) => queueMicrotask(resolve));

beforeEach(() => {
  vi.stubGlobal("crypto", { randomUUID: vi.fn(() => `req-${Math.random()}`) });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Electron notebook host", () => {
  it("keeps the renderer and main-process method allowlists in sync", () => {
    expect([...ELECTRON_MAIN_HOST_METHODS].sort()).toEqual(
      [...ELECTRON_RENDERER_HOST_METHODS].sort(),
    );
  });

  it("keeps relay frames buffered until the notebook sync listener is ready", async () => {
    const ports = linkedPorts();
    const nativeRelay = fakeRelay();
    const handler = {
      invoke: vi.fn(async () => undefined),
    } as unknown as ElectronNotebookHostHandler;
    const server = serveElectronNotebookHost({
      port: ports.main,
      relay: nativeRelay.relay,
      handler,
    });
    const host = createElectronHost({
      port: ports.renderer,
      bootstrap: {
        protocolVersion: ELECTRON_HOST_PROTOCOL_VERSION,
        outputDocumentUrl: "app://nteract/output-frame.html",
      },
    });
    const onFrame = vi.fn();
    host.transport.onFrame(onFrame);

    nativeRelay.emitFrame(new Uint8Array([0x00, 1, 2]));
    await flushMessages();
    expect(onFrame).not.toHaveBeenCalled();

    await host.relay.notifySyncReady();
    expect(onFrame).toHaveBeenCalledWith([0x00, 1, 2]);

    await host.transport.sendFrame(0x03, new Uint8Array([4, 5]));
    await flushMessages();
    const crossRealmLikeFrame = new DataView(new Uint8Array([0x05, 6, 7]).buffer);
    (ports.main as LinkedMainPort).deliver({
      type: "nteract:frame",
      frame: crossRealmLikeFrame,
    });
    await flushMessages();
    expect(nativeRelay.sent).toEqual([new Uint8Array([0x03, 4, 5]), new Uint8Array([0x05, 6, 7])]);
    expect(ports.rendererPort.transferLists).toEqual([]);
    await server.close();
  });

  it("routes save dialogs through the host and save-as through the existing relay", async () => {
    const ports = linkedPorts();
    const nativeRelay = fakeRelay();
    const calls: Array<{ method: string; params: unknown }> = [];
    const handler = {
      async invoke(method: string, params: unknown) {
        calls.push({ method, params });
        if (method === "dialog.saveFile") return "/tmp/demo.ipynb";
        return undefined;
      },
    } as unknown as ElectronNotebookHostHandler;
    const server = serveElectronNotebookHost({
      port: ports.main,
      relay: nativeRelay.relay,
      handler,
    });
    const host = createElectronHost({
      port: ports.renderer,
      bootstrap: {
        protocolVersion: ELECTRON_HOST_PROTOCOL_VERSION,
        outputDocumentUrl: "app://nteract/output-frame.html",
      },
    });

    nativeRelay.onSend((frame) => {
      if (frame[0] !== 0x01) return;
      const request = JSON.parse(new TextDecoder().decode(frame.slice(1))) as { id: string };
      const response = new TextEncoder().encode(
        JSON.stringify({
          id: request.id,
          result: "notebook_saved",
          path: "/tmp/demo.ipynb",
          exported_heads: [],
          save_sequence: 1,
        }),
      );
      const responseFrame = new Uint8Array(1 + response.length);
      responseFrame[0] = 0x02;
      responseFrame.set(response, 1);
      nativeRelay.emitFrame(responseFrame);
    });
    await host.relay.notifySyncReady();
    calls.length = 0;

    await expect(
      host.dialog.saveFile({
        defaultPath: "/tmp/untitled.ipynb",
        filters: [{ name: "Notebook", extensions: ["ipynb"] }],
      }),
    ).resolves.toBe("/tmp/demo.ipynb");
    await host.notebook.saveAs("/tmp/demo.ipynb");

    expect(calls).toEqual([
      {
        method: "dialog.saveFile",
        params: {
          defaultPath: "/tmp/untitled.ipynb",
          filters: [{ name: "Notebook", extensions: ["ipynb"] }],
        },
      },
    ]);
    const saveFrame = nativeRelay.sent.find((frame) => frame[0] === 0x01);
    expect(JSON.parse(new TextDecoder().decode(saveFrame?.slice(1)))).toMatchObject({
      action: "save_notebook",
      path: "/tmp/demo.ipynb",
      format_cells: true,
    });
    expect(host.outputDocumentUrl).toBe("app://nteract/output-frame.html");
    await server.close();
  });

  it("surfaces structured save blockers as useful errors", async () => {
    const ports = linkedPorts();
    const nativeRelay = fakeRelay();
    const handler = {
      invoke: vi.fn(async () => undefined),
    } as unknown as ElectronNotebookHostHandler;
    const server = serveElectronNotebookHost({
      port: ports.main,
      relay: nativeRelay.relay,
      handler,
    });
    const host = createElectronHost({
      port: ports.renderer,
      bootstrap: {
        protocolVersion: ELECTRON_HOST_PROTOCOL_VERSION,
        outputDocumentUrl: "app://nteract/output-frame.html",
      },
    });

    nativeRelay.onSend((frame) => {
      if (frame[0] !== 0x01) return;
      const request = JSON.parse(new TextDecoder().decode(frame.slice(1))) as { id: string };
      const response = new TextEncoder().encode(
        JSON.stringify({
          id: request.id,
          result: "notebook_save_blocked",
          save_sequence: 1,
          reason: {
            type: "path_already_open",
            uuid: "other-session",
            path: "/tmp/shared.ipynb",
          },
        }),
      );
      const responseFrame = new Uint8Array(1 + response.length);
      responseFrame[0] = 0x02;
      responseFrame.set(response, 1);
      nativeRelay.emitFrame(responseFrame);
    });
    await host.relay.notifySyncReady();

    await expect(host.notebook.saveAs("/tmp/shared.ipynb")).rejects.toThrow(
      "Another notebook session already has /tmp/shared.ipynb open.",
    );
    await server.close();
  });

  it("rejects renderer calls when the host handler fails", async () => {
    const ports = linkedPorts();
    const nativeRelay = fakeRelay();
    const handler = {
      async invoke() {
        throw new Error("path is outside the authorized workspace");
      },
    } as unknown as ElectronNotebookHostHandler;
    const server = serveElectronNotebookHost({
      port: ports.main,
      relay: nativeRelay.relay,
      handler,
    });
    const host = createElectronHost({
      port: ports.renderer,
      bootstrap: {
        protocolVersion: ELECTRON_HOST_PROTOCOL_VERSION,
        outputDocumentUrl: "app://nteract/output-frame.html",
      },
    });

    await expect(host.notebook.openInNewWindow("/etc/demo.ipynb")).rejects.toThrow(
      "path is outside the authorized workspace",
    );
    await server.close();
  });

  it("closes the relay when Electron reports that the renderer port closed", async () => {
    const ports = linkedPorts();
    const nativeRelay = fakeRelay();
    serveElectronNotebookHost({
      port: ports.main,
      relay: nativeRelay.relay,
      handler: { invoke: vi.fn(async () => undefined) } as unknown as ElectronNotebookHostHandler,
    });

    (ports.main as LinkedMainPort).deliverClose();
    await flushMessages();

    expect(nativeRelay.close).toHaveBeenCalledOnce();
  });

  it("reports the transport offline and closes when a relay send fails", async () => {
    const ports = linkedPorts();
    const nativeRelay = fakeRelay();
    nativeRelay.relay.send = vi.fn(async () => {
      throw new Error("daemon write failed");
    });
    createElectronHost({
      port: ports.renderer,
      bootstrap: {
        protocolVersion: ELECTRON_HOST_PROTOCOL_VERSION,
        outputDocumentUrl: "app://nteract/output-frame.html",
      },
    });
    serveElectronNotebookHost({
      port: ports.main,
      relay: nativeRelay.relay,
      handler: { invoke: vi.fn(async () => undefined) } as unknown as ElectronNotebookHostHandler,
    });
    const received: unknown[] = [];
    ports.renderer.addEventListener("message", (event) => received.push(event.data));
    ports.renderer.start();

    ports.renderer.postMessage({ type: "nteract:frame", frame: new Uint8Array([0x00, 1]) });
    await flushMessages();
    await flushMessages();

    expect(received).toContainEqual({
      type: "nteract:host-event",
      event: "transport.status",
      payload: "offline",
    });
    expect(nativeRelay.close).toHaveBeenCalledOnce();
  });

  it("reports native relay death without closing the port needed to reconnect", async () => {
    const ports = linkedPorts();
    const nativeRelay = fakeRelay();
    const invoke = vi.fn(async () => undefined);
    const host = createElectronHost({
      port: ports.renderer,
      bootstrap: {
        protocolVersion: ELECTRON_HOST_PROTOCOL_VERSION,
        outputDocumentUrl: "app://nteract/output-frame.html",
      },
    });
    serveElectronNotebookHost({
      port: ports.main,
      relay: nativeRelay.relay,
      handler: { invoke } as unknown as ElectronNotebookHostHandler,
    });
    const received: unknown[] = [];
    ports.renderer.addEventListener("message", (event) => received.push(event.data));
    ports.renderer.start();

    nativeRelay.emitClose();
    await flushMessages();

    expect(received).toContainEqual({
      type: "nteract:host-event",
      event: "transport.status",
      payload: "offline",
    });
    expect(nativeRelay.close).not.toHaveBeenCalled();

    await host.daemon.reconnect({ force: true });
    expect(invoke).toHaveBeenCalledWith("daemon.reconnect", { force: true });
  });

  it("closes the relay when the notebook transport disconnects", async () => {
    const ports = linkedPorts();
    const nativeRelay = fakeRelay();
    serveElectronNotebookHost({
      port: ports.main,
      relay: nativeRelay.relay,
      handler: { invoke: vi.fn(async () => undefined) } as unknown as ElectronNotebookHostHandler,
    });
    const host = createElectronHost({
      port: ports.renderer,
      bootstrap: {
        protocolVersion: ELECTRON_HOST_PROTOCOL_VERSION,
        outputDocumentUrl: "app://nteract/output-frame.html",
      },
    });

    host.transport.disconnect();
    await flushMessages();

    expect(nativeRelay.close).toHaveBeenCalledOnce();
  });
});

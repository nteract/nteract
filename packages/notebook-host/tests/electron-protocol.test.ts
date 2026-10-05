// @vitest-environment jsdom
import { describe, expect, it, vi } from "vite-plus/test";
import { ELECTRON_HOST_PROTOCOL_VERSION as NODE_ELECTRON_HOST_PROTOCOL_VERSION } from "@runtimed/node/electron";
import {
  ELECTRON_HOST_PROTOCOL_VERSION,
  connectElectronNotebookFrame,
  isElectronHostConnectMessage,
  onElectronNotebookFrameReady,
  waitForElectronHostConnection,
} from "../src/electron/protocol";

describe("Electron host connection bootstrap", () => {
  it("validates presentation in the existing bootstrap guard", () => {
    const message = {
      type: "nteract:electron-host-connect",
      bootstrap: {
        protocolVersion: ELECTRON_HOST_PROTOCOL_VERSION,
        outputDocumentUrl: "app://nteract/output-frame.html",
        presentation: { rail: { side: "right", initialPanel: "packages" } },
      },
    };
    expect(isElectronHostConnectMessage(message)).toBe(true);
    message.bootstrap.presentation.rail.side = "bottom";
    expect(isElectronHostConnectMessage(message)).toBe(false);
  });

  it("rejects malformed trusted handshakes and closes the transferred port", async () => {
    const port = { close: vi.fn() } as unknown as MessagePort;
    const connection = waitForElectronHostConnection({
      parentOrigin: "app://trusted-parent",
      parentWindow: window,
      timeoutMs: 100,
    });
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        origin: "app://trusted-parent",
        data: {
          type: "nteract:electron-host-connect",
          bootstrap: {
            protocolVersion: ELECTRON_HOST_PROTOCOL_VERSION,
            outputDocumentUrl: "app://nteract/output-frame.html",
            presentation: { rail: { visible: "false" } },
          },
        },
        ports: [port],
      }),
    );
    await expect(connection).rejects.toThrow("Invalid Electron host connection bootstrap");
    expect(port.close).toHaveBeenCalledOnce();
  });

  it("advertises presentation support without changing the protocol version", async () => {
    const postMessage = vi.fn();
    const controller = new AbortController();
    const connection = waitForElectronHostConnection({
      parentOrigin: "app://trusted-parent",
      parentWindow: { postMessage } as unknown as WindowProxy,
      signal: controller.signal,
    });
    expect(postMessage).toHaveBeenCalledWith(
      {
        type: "nteract:electron-host-ready",
        protocolVersion: 1,
        capabilities: ["presentation.rail"],
      },
      "app://trusted-parent",
    );
    controller.abort();
    await expect(connection).rejects.toThrow("aborted");
  });

  it("passes advertised capabilities to the parent readiness callback", () => {
    const onReady = vi.fn();
    onElectronNotebookFrameReady({
      iframeWindow: window,
      iframeOrigin: "app://notebook-frame",
      onReady,
    });
    const data = {
      type: "nteract:electron-host-ready",
      protocolVersion: ELECTRON_HOST_PROTOCOL_VERSION,
      capabilities: ["presentation.rail"],
    };
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        origin: "app://notebook-frame",
        data: { ...data, capabilities: "presentation.rail" },
      }),
    );
    expect(onReady).not.toHaveBeenCalled();
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        origin: "app://notebook-frame",
        data,
      }),
    );
    expect(onReady).toHaveBeenCalledExactlyOnceWith(data);
  });

  it("transfers presentation bootstrap unchanged and rejects invalid parent config", () => {
    const targetWindow = { postMessage: vi.fn() } as unknown as WindowProxy;
    const connection = {
      port: {} as MessagePort,
      bootstrap: {
        protocolVersion: ELECTRON_HOST_PROTOCOL_VERSION,
        outputDocumentUrl: "app://nteract/output-frame.html",
        presentation: { rail: { side: "right" as const } },
      },
    };
    connectElectronNotebookFrame(targetWindow, "app://notebook-frame", connection);
    expect(targetWindow.postMessage).toHaveBeenCalledWith(
      {
        type: "nteract:electron-host-connect",
        bootstrap: connection.bootstrap,
      },
      "app://notebook-frame",
      [connection.port],
    );
    expect(() =>
      connectElectronNotebookFrame(targetWindow, "app://notebook-frame", {
        ...connection,
        bootstrap: { ...connection.bootstrap, presentation: null as never },
      }),
    ).toThrow("Invalid Electron host connection bootstrap");
    expect(targetWindow.postMessage).toHaveBeenCalledOnce();
  });

  it("uses the protocol version shipped by the native Node host", () => {
    expect(ELECTRON_HOST_PROTOCOL_VERSION).toBe(NODE_ELECTRON_HOST_PROTOCOL_VERSION);
  });

  it("binds only an exact parent window and origin", async () => {
    const port = { start() {}, postMessage() {}, close() {} } as unknown as MessagePort;
    const connection = waitForElectronHostConnection({
      parentOrigin: "app://trusted-parent",
      parentWindow: window,
      timeoutMs: 100,
    });

    window.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        origin: "app://wrong-parent",
        data: {
          type: "nteract:electron-host-connect",
          bootstrap: {
            protocolVersion: ELECTRON_HOST_PROTOCOL_VERSION,
            outputDocumentUrl: "app://nteract/output-frame.html",
          },
        },
        ports: [port],
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        origin: "app://trusted-parent",
        data: {
          type: "nteract:electron-host-connect",
          bootstrap: {
            protocolVersion: ELECTRON_HOST_PROTOCOL_VERSION,
            outputDocumentUrl: "app://nteract/output-frame.html",
          },
        },
        ports: [port],
      }),
    );

    await expect(connection).resolves.toEqual({
      port,
      bootstrap: {
        protocolVersion: ELECTRON_HOST_PROTOCOL_VERSION,
        outputDocumentUrl: "app://nteract/output-frame.html",
      },
    });
  });

  it("rejects wildcard parent origins", async () => {
    await expect(waitForElectronHostConnection({ parentOrigin: "*" })).rejects.toThrow(
      "must be exact",
    );
  });

  it("accepts iframe readiness only from the expected source and origin", () => {
    const onReady = vi.fn();
    const unlisten = onElectronNotebookFrameReady({
      iframeWindow: window,
      iframeOrigin: "app://notebook-frame",
      onReady,
    });

    window.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        origin: "app://wrong-frame",
        data: {
          type: "nteract:electron-host-ready",
          protocolVersion: ELECTRON_HOST_PROTOCOL_VERSION,
        },
      }),
    );
    expect(onReady).not.toHaveBeenCalled();

    window.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        origin: "app://notebook-frame",
        data: {
          type: "nteract:electron-host-ready",
          protocolVersion: ELECTRON_HOST_PROTOCOL_VERSION,
        },
      }),
    );
    expect(onReady).toHaveBeenCalledOnce();

    window.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        origin: "app://notebook-frame",
        data: {
          type: "nteract:electron-host-ready",
          protocolVersion: ELECTRON_HOST_PROTOCOL_VERSION,
        },
      }),
    );
    expect(onReady).toHaveBeenCalledOnce();
    unlisten();
  });
});

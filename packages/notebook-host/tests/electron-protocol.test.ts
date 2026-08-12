// @vitest-environment jsdom
import { describe, expect, it, vi } from "vite-plus/test";
import { ELECTRON_HOST_PROTOCOL_VERSION as NODE_ELECTRON_HOST_PROTOCOL_VERSION } from "@runtimed/node/electron";
import {
  ELECTRON_HOST_PROTOCOL_VERSION,
  onElectronNotebookFrameReady,
  waitForElectronHostConnection,
} from "../src/electron/protocol";

describe("Electron host connection bootstrap", () => {
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
    unlisten();
  });
});

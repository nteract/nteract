// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { TauriTransport } from "../src/tauri/transport";

const coreMock = vi.hoisted(() => {
  const capturedInvokes: Array<{ cmd: string; args: unknown }> = [];
  const channels: Array<{ onmessage: (payload: unknown) => void }> = [];

  class MockChannel<T = unknown> {
    onmessage: (payload: T) => void;

    constructor(onmessage?: (payload: T) => void) {
      this.onmessage = onmessage ?? (() => {});
      channels.push(this as unknown as { onmessage: (payload: unknown) => void });
    }
  }

  return { capturedInvokes, channels, MockChannel };
});

vi.mock("@tauri-apps/api/core", () => ({
  Channel: coreMock.MockChannel,
  invoke: vi.fn((cmd: string, args?: unknown) => {
    coreMock.capturedInvokes.push({ cmd, args });
    return Promise.resolve(undefined);
  }),
}));

function responseFrame(payload: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const frame = new Uint8Array(1 + body.length);
  frame[0] = 0x02;
  frame.set(body, 1);
  return frame;
}

beforeEach(() => {
  coreMock.capturedInvokes.length = 0;
  coreMock.channels.length = 0;
  vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "req-1") });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TauriTransport", () => {
  it("registers one channel per relay generation", async () => {
    const transport = new TauriTransport();

    await transport.subscribeNotebookFrames(7);
    await transport.subscribeNotebookFrames(7);
    await transport.subscribeNotebookFrames(8);

    expect(coreMock.capturedInvokes).toEqual([
      {
        cmd: "subscribe_notebook_frames",
        args: { generation: 7, channel: coreMock.channels[0] },
      },
      {
        cmd: "subscribe_notebook_frames",
        args: { generation: 8, channel: coreMock.channels[0] },
      },
    ]);
  });

  it("fans channel frames out to subscribers and stops after unlisten", () => {
    const transport = new TauriTransport();
    const first = vi.fn();
    const second = vi.fn();

    const unlistenFirst = transport.onFrame(first);
    transport.onFrame(second);

    coreMock.channels[0].onmessage(new Uint8Array([0x00, 1, 2, 3]));
    expect(first).toHaveBeenCalledWith([0x00, 1, 2, 3]);
    expect(second).toHaveBeenCalledWith([0x00, 1, 2, 3]);

    unlistenFirst();
    coreMock.channels[0].onmessage(new Uint8Array([0x03, 4, 5]));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenLastCalledWith([0x03, 4, 5]);
  });

  it("resolves notebook requests from response frames delivered over the channel", async () => {
    const transport = new TauriTransport();

    const result = transport.sendRequest({ type: "get_history", query: "import" });
    await Promise.resolve();

    const sent = coreMock.capturedInvokes.find((entry) => entry.cmd === "send_frame")
      ?.args as Uint8Array;
    expect(sent[0]).toBe(0x01);
    expect(JSON.parse(new TextDecoder().decode(sent.slice(1)))).toEqual({
      id: "req-1",
      action: "get_history",
      query: "import",
    });

    coreMock.channels[0].onmessage(
      responseFrame({
        id: "req-1",
        result: "ok",
        entries: [],
      }).buffer,
    );

    await expect(result).resolves.toEqual({ result: "ok", entries: [] });
  });

  it("rejects pending requests on disconnect", async () => {
    const transport = new TauriTransport();
    const result = transport.sendRequest({ type: "get_history", query: "import" });

    transport.disconnect();

    await expect(result).rejects.toThrow("Transport disconnected (request req-1)");
  });
});

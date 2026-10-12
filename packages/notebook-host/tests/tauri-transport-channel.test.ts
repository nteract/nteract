// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Channel, invoke } from "@tauri-apps/api/core";
import { TauriTransport } from "../src/tauri/transport";

// Use Tauri's actual JS Channel: a plain onmessage mock misses its ordered
// delivery and callback teardown when Rust drops the previous registration.
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(async () => undefined),
}));

type ChannelMessage = { index: number; message: Uint8Array } | { index: number; end: true };
const callbacks = new Map<number, (message: ChannelMessage) => void>();

beforeEach(() => {
  callbacks.clear();
  vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
  let nextId = 0;
  vi.stubGlobal("__TAURI_INTERNALS__", {
    transformCallback: (callback: (message: ChannelMessage) => void) => {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    unregisterCallback: (id: number) => callbacks.delete(id),
  });
});

afterEach(() => vi.unstubAllGlobals());

function registeredChannel(): Channel<unknown> {
  const args = vi.mocked(invoke).mock.lastCall?.[1] as { channel: Channel<unknown> };
  return args.channel;
}

describe("Tauri relay channel lifecycle", () => {
  it("delivers index-zero frames after replacing and closing the previous relay", async () => {
    const transport = new TauriTransport();
    const subscriber = vi.fn();
    transport.onFrame(subscriber);
    await transport.subscribeNotebookFrames(1);
    const first = registeredChannel();
    callbacks.get(first.id)?.({ index: 0, message: new Uint8Array([0x00, 1]) });

    await transport.subscribeNotebookFrames(2);
    const second = registeredChannel();
    callbacks.get(first.id)?.({ index: 1, end: true });
    callbacks.get(second.id)?.({ index: 0, message: new Uint8Array([0x00, 2]) });

    expect(subscriber.mock.calls).toEqual([[[0x00, 1]], [[0x00, 2]]]);
    expect(callbacks.has(second.id)).toBe(true);
  });

  it("uses a fresh channel when retrying a failed registration in the same generation", async () => {
    const transport = new TauriTransport();
    const subscriber = vi.fn();
    transport.onFrame(subscriber);
    vi.mocked(invoke).mockRejectedValueOnce(new Error("registration failed"));
    await expect(transport.subscribeNotebookFrames(1)).rejects.toThrow("registration failed");
    const failed = registeredChannel();
    callbacks.get(failed.id)?.({ index: 0, end: true });

    await transport.subscribeNotebookFrames(1);
    const retried = registeredChannel();
    callbacks.get(retried.id)?.({ index: 0, message: new Uint8Array([0x00, 2]) });

    expect(subscriber).toHaveBeenCalledExactlyOnceWith([0x00, 2]);
  });
});

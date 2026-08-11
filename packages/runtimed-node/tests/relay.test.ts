import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vite-plus/test";

const require = createRequire(import.meta.url);
const { RelaySession, normalizeRelayInfo, toBuffer } = require("../src/relay-session.cjs") as {
  RelaySession: new (nativeSession: Record<string, unknown>) => {
    notebookId: string;
    info: Record<string, unknown>;
    closed: boolean;
    send(frame: Buffer | Uint8Array | DataView | ArrayBuffer): Promise<void>;
    onFrame(listener: (frame: Buffer) => void): () => void;
    onClose(listener: () => void): () => void;
    close(): Promise<void>;
  };
  normalizeRelayInfo(info: Record<string, unknown>): Record<string, unknown>;
  toBuffer(frame: Buffer | Uint8Array | DataView | ArrayBuffer): Buffer;
};

function fakeNative() {
  let frameCallback: ((frame: Buffer) => void) | undefined;
  let closeCallback: (() => void) | undefined;
  const subscription = { dispose: vi.fn() };
  const native = {
    notebookId: "notebook-1",
    info: {
      notebookId: "notebook-1",
      commentsNotebookRefJson: '{"kind":"local_room","room_id":"notebook-1"}',
      protocol: "v4",
    },
    closed: false,
    send: vi.fn(async () => {}),
    close: vi.fn(() => {
      native.closed = true;
    }),
    subscribeFrames: vi.fn((onFrame: (frame: Buffer) => void, onClose: () => void) => {
      frameCallback = onFrame;
      closeCallback = onClose;
      return subscription;
    }),
  };
  return {
    native,
    subscription,
    emitFrame(frame: Buffer) {
      frameCallback?.(frame);
    },
    emitClose() {
      closeCallback?.();
    },
  };
}

describe("@runtimed/node relay wrapper", () => {
  it("forwards ordered binary frames and supports unsubscribe", () => {
    const fake = fakeNative();
    const relay = new RelaySession(fake.native);
    const received: Buffer[] = [];
    const unsubscribe = relay.onFrame((frame) => received.push(frame));

    fake.emitFrame(Buffer.from([0x00, 0x01]));
    fake.emitFrame(Buffer.from([0x05, 0x02]));
    unsubscribe();
    fake.emitFrame(Buffer.from([0x04, 0x03]));

    expect(received).toEqual([Buffer.from([0x00, 0x01]), Buffer.from([0x05, 0x02])]);
  });

  it("holds bootstrap frames until the renderer subscribes", () => {
    const fake = fakeNative();
    const relay = new RelaySession(fake.native);
    fake.emitFrame(Buffer.from([0x00, 0x01]));
    fake.emitFrame(Buffer.from([0x05, 0x02]));
    const received: Buffer[] = [];

    relay.onFrame((frame) => received.push(frame));

    expect(received).toEqual([Buffer.from([0x00, 0x01]), Buffer.from([0x05, 0x02])]);
  });

  it("normalizes typed-array slices without widening the frame", async () => {
    const fake = fakeNative();
    const relay = new RelaySession(fake.native);
    const backing = new Uint8Array([99, 0x01, 0x02, 88]);

    await relay.send(backing.subarray(1, 3));

    expect(fake.native.send).toHaveBeenCalledOnce();
    expect(fake.native.send.mock.calls[0]?.[0]).toEqual(Buffer.from([0x01, 0x02]));
  });

  it("normalizes DataView frames", async () => {
    const fake = fakeNative();
    const relay = new RelaySession(fake.native);
    const backing = Uint8Array.from([99, 0x01, 0x02, 88]);

    await relay.send(new DataView(backing.buffer, 1, 2));

    expect(fake.native.send.mock.calls[0]?.[0]).toEqual(Buffer.from([0x01, 0x02]));
  });

  it("notifies close listeners once and disposes the native subscription", () => {
    const fake = fakeNative();
    const relay = new RelaySession(fake.native);
    const onClose = vi.fn();
    relay.onClose(onClose);

    fake.emitClose();
    fake.emitClose();

    expect(onClose).toHaveBeenCalledOnce();
    expect(fake.subscription.dispose).toHaveBeenCalledOnce();
    expect(relay.closed).toBe(true);
  });

  it("projects optional JSON connection metadata", () => {
    expect(
      normalizeRelayInfo({
        notebookId: "notebook-1",
        commentsNotebookRefJson: '{"kind":"local_path","canonical_path":"/tmp/a.ipynb"}',
      }),
    ).toEqual({
      notebookId: "notebook-1",
      commentsNotebookRef: { kind: "local_path", canonical_path: "/tmp/a.ipynb" },
    });
  });

  it("rejects values that are not binary frames", () => {
    expect(() => toBuffer("not-a-frame" as never)).toThrow(
      /Buffer, ArrayBuffer view, or ArrayBuffer/,
    );
  });
});

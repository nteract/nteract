import { describe, expect, it, vi } from "vite-plus/test";

import {
  DirectTransport,
  FrameType,
  sendAutomergeSyncFrame,
  sendPresenceFrame,
  type NotebookTransport,
} from "../src";

function createTransportStub(): {
  transport: NotebookTransport;
  sendFrame: ReturnType<typeof vi.fn>;
} {
  const sendFrame = vi.fn().mockResolvedValue(undefined);
  const transport = {
    sendFrame,
    onFrame: () => () => {},
    sendRequest: vi.fn(),
    sendTypedRequest: vi.fn(),
    connected: true,
    disconnect: vi.fn(),
  } satisfies NotebookTransport;

  return { transport, sendFrame };
}

describe("FrameType constants", () => {
  it("matches the notebook wire frame discriminants", () => {
    expect(FrameType.AUTOMERGE_SYNC).toBe(0x00);
    expect(FrameType.REQUEST).toBe(0x01);
    expect(FrameType.RESPONSE).toBe(0x02);
    expect(FrameType.BROADCAST).toBe(0x03);
    expect(FrameType.PRESENCE).toBe(0x04);
    expect(FrameType.RUNTIME_STATE_SYNC).toBe(0x05);
    expect(FrameType.POOL_STATE_SYNC).toBe(0x06);
    expect(FrameType.SESSION_CONTROL).toBe(0x07);
    expect(FrameType.PUT_BLOB).toBe(0x08);
  });
});

describe("frame send helpers", () => {
  it("sends Automerge sync payloads with the package-owned frame type", async () => {
    const { transport, sendFrame } = createTransportStub();
    const payload = new Uint8Array([1, 2, 3]);

    await sendAutomergeSyncFrame(transport, payload);

    expect(sendFrame).toHaveBeenCalledWith(FrameType.AUTOMERGE_SYNC, payload);
  });

  it("sends presence payloads with the package-owned frame type", async () => {
    const { transport, sendFrame } = createTransportStub();
    const payload = new Uint8Array([4, 5, 6]);

    await sendPresenceFrame(transport, payload);

    expect(sendFrame).toHaveBeenCalledWith(FrameType.PRESENCE, payload);
  });
});

describe("DirectTransport sendTypedRequest", () => {
  const server = {
    flush_local_changes: () => null,
    receive_sync_message: () => true,
    reset_sync_state: () => {},
  };

  it("routes request frames through the normal request handler shape", async () => {
    const transport = new DirectTransport(server);
    const payload = new TextEncoder().encode(
      JSON.stringify({
        id: "request-1",
        required_heads: ["head-1"],
        action: "execute_cell",
        cell_id: "cell-1",
      }),
    );
    transport.requestHandler = vi.fn().mockResolvedValue({ result: "ok" });

    const response = await transport.sendTypedRequest(
      FrameType.REQUEST,
      payload,
      "request-1",
      30_000,
      "execute_cell",
    );

    expect(transport.sentFrames).toEqual([{ frameType: FrameType.REQUEST, payload }]);
    expect(transport.requestHandler).toHaveBeenCalledWith(
      { type: "execute_cell", cell_id: "cell-1" },
      { required_heads: ["head-1"] },
    );
    expect(response).toEqual({ result: "ok" });
  });

  it("routes non-request typed frames through typedRequestHandler", async () => {
    const transport = new DirectTransport(server);
    const payload = new Uint8Array([1, 2, 3]);
    transport.typedRequestHandler = vi.fn().mockResolvedValue({
      result: "blob_stored",
      hash: "hash123",
      size: 3,
      media_type: "application/octet-stream",
    });

    const response = await transport.sendTypedRequest(
      FrameType.PUT_BLOB,
      payload,
      "blob-request-1",
      30_000,
    );

    expect(transport.sentFrames).toEqual([{ frameType: FrameType.PUT_BLOB, payload }]);
    expect(transport.typedRequestHandler).toHaveBeenCalledWith(
      FrameType.PUT_BLOB,
      payload,
      "blob-request-1",
      30_000,
    );
    expect(response).toEqual({
      result: "blob_stored",
      hash: "hash123",
      size: 3,
      media_type: "application/octet-stream",
    });
  });
});

import { describe, expect, it, vi } from "vite-plus/test";

import {
  BlobUploadError,
  FrameType,
  PUT_BLOB_TIMEOUT_MS,
  putBlob,
  type NotebookTransport,
} from "../src";

function parsePutBlobFrame(frame: Uint8Array): {
  header: Record<string, unknown>;
  body: Uint8Array;
} {
  const headerLength = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(
    0,
    false,
  );
  const headerBytes = frame.slice(4, 4 + headerLength);
  const body = frame.slice(4 + headerLength);
  return {
    header: JSON.parse(new TextDecoder().decode(headerBytes)) as Record<string, unknown>,
    body,
  };
}

function createTransport(
  handler: NotebookTransport["sendTypedRequest"],
): NotebookTransport & { sendTypedRequest: ReturnType<typeof vi.fn> } {
  return {
    sendFrame: vi.fn().mockResolvedValue(undefined),
    onFrame: () => () => {},
    sendRequest: vi.fn(),
    sendTypedRequest: vi.fn(handler),
    connected: true,
    disconnect: vi.fn(),
  };
}

describe("putBlob", () => {
  it("builds a PutBlob frame with header, body, and sha256", async () => {
    const bytes = new TextEncoder().encode("abc");
    const transport = createTransport(async (frameType, frame, id, timeoutMs) => {
      expect(frameType).toBe(FrameType.PUT_BLOB);
      expect(timeoutMs).toBe(PUT_BLOB_TIMEOUT_MS);

      const { header, body } = parsePutBlobFrame(frame);
      expect(header).toEqual({
        op: "put",
        id,
        media_type: "text/plain",
        size: 3,
        sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      });
      expect(Array.from(body)).toEqual(Array.from(bytes));

      return {
        result: "blob_stored",
        hash: "hash123",
        size: 3,
        media_type: "text/plain",
      };
    });

    await expect(putBlob(transport, bytes, "text/plain")).resolves.toEqual({
      blob: "hash123",
      size: 3,
      media_type: "text/plain",
    });
  });

  it("includes durability only when explicitly ephemeral", async () => {
    const bytes = new TextEncoder().encode("abc");
    const transport = createTransport(async (_frameType, frame, id) => {
      const { header } = parsePutBlobFrame(frame);
      expect(header).toEqual({
        op: "put",
        id,
        media_type: "text/plain",
        size: 3,
        sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        durability: "ephemeral",
      });

      return {
        result: "blob_stored",
        hash: "hash123",
        size: 3,
        media_type: "text/plain",
      };
    });

    await putBlob(transport, bytes, "text/plain", "ephemeral");
  });

  it("propagates structured blob upload errors", async () => {
    const transport = createTransport(async () => ({
      result: "blob_upload_error",
      reason: { kind: "too_many_in_flight" },
    }));

    await expect(
      putBlob(transport, new Uint8Array([1, 2, 3]), "application/octet-stream"),
    ).rejects.toBeInstanceOf(BlobUploadError);

    try {
      await putBlob(transport, new Uint8Array([1, 2, 3]), "application/octet-stream");
      throw new Error("expected BlobUploadError");
    } catch (error) {
      expect(error).toBeInstanceOf(BlobUploadError);
      expect((error as BlobUploadError).reason).toEqual({ kind: "too_many_in_flight" });
    }
  });

  it("rejects unexpected response variants", async () => {
    const transport = createTransport(async () => ({ result: "ok" }));

    await expect(
      putBlob(transport, new Uint8Array([1]), "application/octet-stream"),
    ).rejects.toThrow("Unexpected response for PutBlob");
  });
});

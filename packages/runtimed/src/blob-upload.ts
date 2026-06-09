import { FrameType, type NotebookTransport } from "./transport";
import type { BlobDurability, BlobUploadErrorKind, NotebookResponse } from "./request-types";

export interface PutBlobResult {
  blob: string;
  size: number;
  media_type: string;
}

export class BlobUploadError extends Error {
  constructor(readonly reason: BlobUploadErrorKind) {
    super(`Blob upload failed: ${reason.kind}`);
    this.name = "BlobUploadError";
  }
}

export const PUT_BLOB_TIMEOUT_MS = 30_000;

export async function putBlob(
  transport: NotebookTransport,
  bytes: Uint8Array,
  mediaType: string,
  durability: BlobDurability = "durable",
): Promise<PutBlobResult> {
  const sha256 = await hexHash(bytes);
  const id = crypto.randomUUID();
  const header: {
    op: "put";
    id: string;
    media_type: string;
    size: number;
    sha256: string;
    durability?: BlobDurability;
  } = {
    op: "put",
    id,
    media_type: mediaType,
    size: bytes.byteLength,
    sha256,
  };
  if (durability !== "durable") {
    header.durability = durability;
  }
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const frame = new Uint8Array(4 + headerBytes.length + bytes.byteLength);
  new DataView(frame.buffer, frame.byteOffset, frame.byteLength).setUint32(
    0,
    headerBytes.length,
    false,
  );
  frame.set(headerBytes, 4);
  frame.set(bytes, 4 + headerBytes.length);

  const response = await transport.sendTypedRequest(
    FrameType.PUT_BLOB,
    frame,
    id,
    PUT_BLOB_TIMEOUT_MS,
    "put_blob",
  );

  return handlePutBlobResponse(response);
}

async function hexHash(bytes: Uint8Array): Promise<string> {
  const digestInput = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", digestInput);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function handlePutBlobResponse(response: NotebookResponse): PutBlobResult {
  switch (response.result) {
    case "blob_stored":
      return {
        blob: response.hash,
        size: response.size,
        media_type: response.media_type,
      };
    case "blob_upload_error":
      throw new BlobUploadError(response.reason);
    default:
      throw new Error(`Unexpected response for PutBlob: ${response.result}`);
  }
}

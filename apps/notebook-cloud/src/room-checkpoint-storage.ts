import type { R2Bucket } from "./cloudflare-types.ts";

const DOCUMENTS = ["notebook", "runtime_state", "comms", "comments"] as const;
type DocumentKind = (typeof DOCUMENTS)[number];
export type CheckpointBodies = Record<DocumentKind, ArrayBuffer>;
export type CheckpointObjects = Record<DocumentKind, { sha256: string; byte_length: number }>;

/** A committed object checkpoint must not silently fall back to older published content. */
export class RoomCheckpointLoadError extends Error {}

function objectKey(notebookId: string, sha256: string): string {
  return `n/${encodeURIComponent(notebookId)}/room-checkpoints/${sha256}.am`;
}

async function digest(bytes: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function readBody(
  bucket: R2Bucket,
  notebookId: string,
  kind: DocumentKind,
  reference: CheckpointObjects[DocumentKind],
): Promise<ArrayBuffer> {
  if (
    !reference ||
    typeof reference.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(reference.sha256) ||
    !Number.isSafeInteger(reference.byte_length) ||
    reference.byte_length < 0
  ) {
    throw new Error(`Invalid ${kind} checkpoint reference`);
  }
  // Derive the key from this room, never follow a storage key supplied by a manifest.
  const object = await bucket.get(objectKey(notebookId, reference.sha256));
  if (!object) throw new Error(`Missing ${kind} checkpoint object`);
  if (object.size !== reference.byte_length)
    throw new Error(`Invalid ${kind} checkpoint object size (expected ${reference.byte_length})`);
  const bytes = await object.arrayBuffer();
  if (bytes.byteLength !== reference.byte_length || (await digest(bytes)) !== reference.sha256)
    throw new Error(`Invalid ${kind} checkpoint object integrity`);
  return bytes;
}

/**
 * Upload changed bodies and reuse committed references before the manifest commit.
 * Omitted bodies must refer to unchanged documents in the caller's committed generation.
 */
export async function storeCheckpointObjects(
  bucket: R2Bucket | undefined,
  notebookId: string,
  bodies: Partial<CheckpointBodies>,
  committed?: CheckpointObjects,
): Promise<CheckpointObjects> {
  if (!bucket) throw new Error("Room checkpoint object storage unavailable");
  for (const kind of DOCUMENTS) {
    if (bodies[kind] === undefined && !committed?.[kind])
      throw new Error(`Missing ${kind} checkpoint body or committed reference`);
  }
  const entries = await Promise.all(
    DOCUMENTS.map(async (kind) => {
      const bytes = bodies[kind];
      if (bytes === undefined) return [kind, committed![kind]] as const;
      const reference = { sha256: await digest(bytes), byte_length: bytes.byteLength };
      // The selected generation already confirmed durability. Reuse unchanged bodies
      // without another object write; immutable objects are never deleted here.
      if (
        committed?.[kind]?.sha256 === reference.sha256 &&
        committed[kind].byte_length === reference.byte_length
      )
        return [kind, reference] as const;
      try {
        const stored = await bucket.put(objectKey(notebookId, reference.sha256), bytes, {
          onlyIf: { etagDoesNotMatch: "*" },
          httpMetadata: { contentType: "application/octet-stream" },
        });
        // A conditional loser must confirm the existing body before selecting it.
        if (!stored) await readBody(bucket, notebookId, kind, reference);
        else if (stored.size !== bytes.byteLength)
          throw new Error("Stored checkpoint object size differs from upload");
      } catch (cause) {
        throw new Error(`Checkpoint ${kind} object write failed (${bytes.byteLength} bytes)`, {
          cause,
        });
      }
      return [kind, reference] as const;
    }),
  );
  return Object.fromEntries(entries) as CheckpointObjects;
}

export async function loadCheckpointObjects(
  bucket: R2Bucket | undefined,
  notebookId: string,
  references: CheckpointObjects | undefined,
): Promise<CheckpointBodies> {
  try {
    if (!bucket) throw new Error("Room checkpoint object storage unavailable");
    if (!references) throw new Error("Room checkpoint object references missing");
    const entries = await Promise.all(
      DOCUMENTS.map(
        async (kind) => [kind, await readBody(bucket, notebookId, kind, references[kind])] as const,
      ),
    );
    return Object.fromEntries(entries) as CheckpointBodies;
  } catch (cause) {
    throw new RoomCheckpointLoadError(
      `Committed room checkpoint could not be loaded: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

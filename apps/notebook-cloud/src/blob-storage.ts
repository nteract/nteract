import type { Env } from "./cloudflare-types.ts";
import { blobKey, recordBlob } from "./storage.ts";

/** Callers verify the content hash and normalize the allowed media type. */
export async function storeNotebookBlob(
  env: Env,
  notebookId: string,
  blob: { hash: string; bytes: ArrayBuffer | Uint8Array; contentType: string },
): Promise<{ key: string; deduplicated: boolean }> {
  const bucket = env.NOTEBOOK_SNAPSHOTS;
  if (!bucket) throw new Error("Notebook blob storage unavailable");
  const key = blobKey(notebookId, blob.hash);
  let stored = await bucket.head(key);
  let deduplicated = stored !== null;
  if (!stored) {
    // The condition protects the race between head and put, including a writer
    // arriving through the other (HTTP or managed runtime) upload path.
    stored = await bucket.put(key, blob.bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: {
        contentType: blob.contentType,
        cacheControl: "public, max-age=31536000, immutable",
      },
      customMetadata: { notebook_id: notebookId, hash: blob.hash },
    });
    if (!stored) {
      deduplicated = true;
      stored = await bucket.head(key);
    }
  }
  if (!stored) throw new Error("Notebook blob disappeared during conditional upload");
  // Heal the catalog from stored metadata, never the losing writer's MIME type.
  await recordBlob(env, {
    notebookId,
    hash: blob.hash,
    size: stored.size,
    contentType: stored.httpMetadata?.contentType ?? null,
    r2Key: key,
  });
  return { key, deduplicated };
}

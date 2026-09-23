import type { Env } from "./cloudflare-types.ts";
import { blobKey, recordBlob } from "./storage.ts";
import {
  DEFAULT_BLOB_UPLOAD_CONTENT_TYPE,
  normalizedBlobUploadContentType,
} from "./blob-content-type.ts";

/** The trusted output preparer supplies the SHA-256 of these exact bytes. */
export async function storeManagedPythonBlob(
  env: Env,
  notebookId: string,
  blob: { hash: string; bytes: Uint8Array; mediaType: string },
): Promise<void> {
  if (!env.NOTEBOOK_SNAPSHOTS) throw new Error("Notebook blob storage unavailable");
  const key = blobKey(notebookId, blob.hash);
  // Unknown guest MIME types remain opaque bytes on the authenticated blob
  // origin; they cannot turn a stored object into an XML/XHTML document.
  const contentType =
    normalizedBlobUploadContentType(blob.mediaType) ?? DEFAULT_BLOB_UPLOAD_CONTENT_TYPE;
  const existing = await env.NOTEBOOK_SNAPSHOTS.head(key);
  if (!existing) {
    await env.NOTEBOOK_SNAPSHOTS.put(key, blob.bytes, {
      httpMetadata: { contentType, cacheControl: "public, max-age=31536000, immutable" },
      customMetadata: { notebook_id: notebookId, hash: blob.hash },
    });
  }
  await recordBlob(env, {
    notebookId,
    hash: blob.hash,
    size: existing?.size ?? blob.bytes.byteLength,
    contentType: existing ? (existing.httpMetadata?.contentType ?? null) : contentType,
    r2Key: key,
  });
}

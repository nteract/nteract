import type { Env } from "./cloudflare-types.ts";
import { storeNotebookBlob } from "./blob-storage.ts";
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
  // Unknown guest MIME types remain opaque bytes on the authenticated blob
  // origin; they cannot turn a stored object into an XML/XHTML document.
  const contentType =
    normalizedBlobUploadContentType(blob.mediaType) ?? DEFAULT_BLOB_UPLOAD_CONTENT_TYPE;
  await storeNotebookBlob(env, notebookId, { ...blob, contentType });
}

export const DEFAULT_BLOB_UPLOAD_CONTENT_TYPE = "application/octet-stream";
const ALLOWED_EXACT_BLOB_UPLOAD_CONTENT_TYPES = new Set([
  DEFAULT_BLOB_UPLOAD_CONTENT_TYPE,
  "application/ecmascript",
  "application/javascript",
  "application/json",
  "application/pdf",
  "application/vnd.apache.arrow.stream",
  "application/vnd.apache.parquet",
  "application/wasm",
]);
const ALLOWED_PREFIXED_BLOB_UPLOAD_CONTENT_TYPES = ["audio/", "image/", "text/", "video/"];

export function normalizedBlobUploadContentType(contentType: string | null): string | null {
  const mediaType =
    contentType == null
      ? DEFAULT_BLOB_UPLOAD_CONTENT_TYPE
      : (contentType.split(";")[0]?.trim().toLowerCase() ?? "");
  if (mediaType.length === 0) {
    return null;
  }
  if (ALLOWED_EXACT_BLOB_UPLOAD_CONTENT_TYPES.has(mediaType)) {
    return mediaType;
  }
  if (ALLOWED_PREFIXED_BLOB_UPLOAD_CONTENT_TYPES.some((prefix) => mediaType.startsWith(prefix))) {
    return mediaType;
  }
  if (mediaType.startsWith("application/") && mediaType.endsWith("+json")) {
    return mediaType;
  }
  return null;
}

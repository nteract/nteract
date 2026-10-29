/** Stable Page-local references; no storage credentials or expiring URLs enter a document. */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_MAX_DIMENSION = 8192;
export const IMAGE_MAX_PIXELS = 25_000_000;
export const IMAGE_MEDIA_TYPES = Object.freeze(["image/png", "image/jpeg", "image/webp"]);
export const validAssetId = (id) => typeof id === "string" && /^[a-f0-9]{64}$/.test(id);
export function imageAssetUrl(pageId, assetId) {
  return `/api/pages/${encodeURIComponent(pageId)}/assets/${encodeURIComponent(assetId)}`;
}

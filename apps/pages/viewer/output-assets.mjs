import { imageAssetUrl, validAssetId } from "../shared/image-assets.mjs";
import { OUTPUT_MAX_BYTES } from "../shared/esm-view.mjs";

// Only the parent uses this function. The frame never receives this URL,
// the session, or a proxy for arbitrary authenticated requests.
export async function fetchOutputAsset(pageId, version, { signal, request = fetch } = {}) {
  if (!validAssetId(version?.asset_id)) throw Error("Invalid output asset.");
  const response = await request(imageAssetUrl(pageId, version.asset_id), {
    credentials: "same-origin",
    redirect: "error",
    signal,
  });
  if (!response.ok) throw Error(`Couldn't read this view's input (${response.status}).`);
  if (
    (response.headers.get("x-pages-media-type") ?? response.headers.get("content-type"))
      ?.split(";")[0]
      .trim() !== version.media_type
  )
    throw Error("The input's media type changed.");
  const reader = response.body?.getReader();
  if (!reader) throw Error("The input has no bytes.");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > OUTPUT_MAX_BYTES) throw Error("This input exceeds 5 MiB.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
  signal?.throwIfAborted();
  if (hash !== version.asset_id) throw Error("The input's content hash doesn't match.");
  return { bytes, mediaType: version.media_type, assetId: version.asset_id };
}

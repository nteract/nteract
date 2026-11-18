import { imageAssetUrl, validAssetId } from "../shared/image-assets.mjs";

// Captures the authorized, immutable asset URL once. Neither it nor the
// caller's cookie crosses the frame boundary.
export async function openAssetByteSource(pageId, version, { signal, request = fetch } = {}) {
  if (!validAssetId(version.asset_id)) throw Error("Invalid file asset.");
  const url = imageAssetUrl(pageId, version.asset_id);
  const options = { credentials: "same-origin", redirect: "error", signal };
  const head = await request(url, { ...options, method: "HEAD" });
  const size = head.headers.get("content-length");
  const byteLength = Number(size);
  if (
    !head.ok ||
    !size ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    head.headers.get("x-pages-media-type") !== version.media_type
  )
    throw Error("Could not open this Page file (" + head.status + ").");
  return {
    byteLength,
    async read(offset, length, cancel) {
      const active = cancel && signal ? AbortSignal.any([signal, cancel]) : (cancel ?? signal);
      active?.throwIfAborted();
      if (
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) ||
        offset < 0 ||
        length < 0 ||
        offset > byteLength - length
      )
        throw Error("Read outside the file.");
      if (!length) return new Uint8Array();
      const end = offset + length - 1;
      const response = await request(url, {
        ...options,
        signal: active,
        headers: { Range: `bytes=${offset}-${end}` },
      });
      if (
        response.status !== 206 ||
        response.headers.get("content-range") !== `bytes ${offset}-${end}/${byteLength}` ||
        response.headers.get("content-length") !== String(length)
      ) {
        await response.body?.cancel();
        throw Error(
          "The asset server did not return the requested range (" + response.status + ").",
        );
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== length) throw Error("Incomplete range.");
      return bytes;
    },
  };
}

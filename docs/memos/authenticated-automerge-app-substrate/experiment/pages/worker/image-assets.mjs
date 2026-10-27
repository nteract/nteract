import { authenticate, HttpError, errorResponse } from "./auth.mjs";
import { validPageId } from "./registration.mjs";
import {
  IMAGE_MAX_BYTES,
  IMAGE_MAX_DIMENSION,
  IMAGE_MAX_PIXELS,
  IMAGE_MEDIA_TYPES,
  validAssetId,
  imageAssetUrl,
} from "../shared/image-assets.mjs";

export const imageAssetKey = (pageId, assetId) => `pages/${pageId}/assets/${assetId}`;
const invalid = () => {
  throw new HttpError(415, "Use a valid, static PNG, JPEG, or WebP image");
};
const ascii = (bytes, offset, length) =>
  String.fromCharCode(...bytes.subarray(offset, offset + length));
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(bytes, start, end) {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

function pngDimensions(bytes, view) {
  let offset = 8,
    width,
    height,
    data = false,
    endedData = false,
    palette = false,
    color;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset),
      end = offset + 12 + length;
    if (end > bytes.length) invalid();
    const type = ascii(bytes, offset + 4, 4);
    if (
      !/^[A-Za-z]{4}$/.test(type) ||
      crc32(bytes, offset + 4, end - 4) !== view.getUint32(end - 4)
    )
      invalid();
    if (offset === 8 && type !== "IHDR") invalid();
    if (type === "IHDR") {
      if (offset !== 8 || length !== 13) invalid();
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      const depth = bytes[offset + 16];
      color = bytes[offset + 17];
      const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (
        !depths[color]?.includes(depth) ||
        bytes[offset + 18] !== 0 ||
        bytes[offset + 19] !== 0 ||
        bytes[offset + 20] > 1
      )
        invalid();
    } else if (type === "IDAT") {
      if (endedData || (color === 3 && !palette)) invalid();
      data = true;
    } else {
      if (data) endedData = true;
      if (type === "IEND") {
        if (!data || length !== 0 || end !== bytes.length) invalid();
        return { width, height };
      }
      if (type === "PLTE") {
        if (palette || data || length === 0 || length > 768 || length % 3 !== 0) invalid();
        palette = true;
      } else if (type === "acTL" || type[0] === type[0].toUpperCase()) invalid();
    }
    offset = end;
  }
  invalid();
}

function jpegDimensions(bytes, view) {
  let offset = 2,
    width,
    height,
    scans = 0,
    entropy = false;
  while (offset < bytes.length) {
    if (entropy) {
      const start = offset;
      while (offset < bytes.length) {
        if (bytes[offset++] !== 255) continue;
        while (bytes[offset] === 255) offset++;
        const marker = bytes[offset];
        if (marker === 0 || (marker >= 0xd0 && marker <= 0xd7)) offset++;
        else {
          offset--;
          break;
        }
      }
      if (offset === start) invalid();
      entropy = false;
    }
    if (offset + 2 > bytes.length || bytes[offset++] !== 255) invalid();
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      if (!width || !scans || offset !== bytes.length) invalid();
      return { width, height };
    }
    if (
      marker === 0 ||
      marker === 0xd8 ||
      (marker >= 0xd0 && marker <= 0xd7) ||
      offset + 2 > bytes.length
    )
      invalid();
    const length = view.getUint16(offset),
      end = offset + length;
    if (length < 2 || end > bytes.length) invalid();
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (width !== undefined || length < 11 || bytes[offset + 2] !== 8) invalid();
      height = view.getUint16(offset + 3);
      width = view.getUint16(offset + 5);
      const components = bytes[offset + 7];
      if (![1, 3, 4].includes(components) || length !== 8 + 3 * components) invalid();
    } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) invalid();
    if (marker === 0xda) {
      if (width === undefined || length < 6 || length !== 6 + 2 * bytes[offset + 2]) invalid();
      scans++;
      entropy = true;
    }
    offset = end;
  }
  invalid();
}

function webpDimensions(bytes, view) {
  if (bytes.length < 20 || view.getUint32(4, true) + 8 !== bytes.length) invalid();
  let offset = 12,
    dimensions,
    canvas;
  const uint24 = (i) => bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16);
  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, 4),
      length = view.getUint32(offset + 4, true);
    const start = offset + 8,
      end = start + length;
    if (end + (length & 1) > bytes.length) invalid();
    if (type === "VP8X") {
      if (
        offset !== 12 ||
        length !== 10 ||
        bytes[start] & 0xc3 ||
        bytes[start + 1] ||
        bytes[start + 2] ||
        bytes[start + 3]
      )
        invalid();
      canvas = { width: uint24(start + 4) + 1, height: uint24(start + 7) + 1 };
    } else if (type === "VP8 ") {
      if (
        dimensions ||
        length < 10 ||
        bytes[start] & 1 ||
        ascii(bytes, start + 3, 3) !== "\x9d\x01\x2a"
      )
        invalid();
      dimensions = {
        width: view.getUint16(start + 6, true) & 0x3fff,
        height: view.getUint16(start + 8, true) & 0x3fff,
      };
    } else if (type === "VP8L") {
      if (dimensions || length < 5 || bytes[start] !== 0x2f || bytes[start + 4] >> 5) invalid();
      const bits = view.getUint32(start + 1, true);
      dimensions = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    } else if (["ANIM", "ANMF"].includes(type)) invalid();
    offset = end + (length & 1);
  }
  if (
    !dimensions ||
    offset !== bytes.length ||
    (canvas && (canvas.width !== dimensions.width || canvas.height !== dimensions.height))
  )
    invalid();
  return dimensions;
}

/** Validate raster containers and dimensions without decoding pixels in the Worker. */
export function inspectImage(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let mime_type, dimensions;
  if (ascii(bytes, 0, 8) === "\x89PNG\r\n\x1a\n") {
    mime_type = "image/png";
    dimensions = pngDimensions(bytes, view);
  } else if (bytes[0] === 255 && bytes[1] === 0xd8) {
    mime_type = "image/jpeg";
    dimensions = jpegDimensions(bytes, view);
  } else if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    mime_type = "image/webp";
    dimensions = webpDimensions(bytes, view);
  } else invalid();
  const { width, height } = dimensions;
  if (
    !width ||
    !height ||
    width > IMAGE_MAX_DIMENSION ||
    height > IMAGE_MAX_DIMENSION ||
    width * height > IMAGE_MAX_PIXELS
  )
    throw new HttpError(413, "Image dimensions are too large");
  return { mime_type, width, height };
}

async function readImageBody(request) {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > IMAGE_MAX_BYTES))
    throw new HttpError(413, "Images must be 5 MiB or smaller");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "Image bytes required");
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > IMAGE_MAX_BYTES) {
        await reader.cancel();
        throw new HttpError(413, "Images must be 5 MiB or smaller");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function privateResponse(response) {
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Cross-Origin-Resource-Policy", "same-origin");
  return response;
}

/** The authorize callback is a short Page-DO request; byte transfer stays outside its queue. */
export async function handleImageAssets(request, env, { pageId, assetId, authorize }) {
  try {
    if (!validPageId(pageId) || (assetId !== undefined && !validAssetId(assetId)))
      throw new HttpError(400, "Invalid image reference");
    const upload = assetId === undefined && request.method === "POST";
    if (!upload && !(assetId && ["GET", "HEAD"].includes(request.method)))
      throw new HttpError(405, assetId ? "Use GET or HEAD" : "Use POST");
    // In particular this does not widen the MCP-only OAuth token audience.
    await authenticate(request, env);
    const access = await authorize(upload);
    if (!access.ok) return privateResponse(access);
    const bucket = env.PAGES_ASSETS;
    if (!bucket) throw new HttpError(503, "Image storage is unavailable");
    if (upload) {
      const bytes = await readImageBody(request);
      const image = inspectImage(bytes);
      const claimed = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
      if (claimed && claimed !== "application/octet-stream" && claimed !== image.mime_type)
        throw new HttpError(415, "Image bytes do not match Content-Type");
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      const hash = Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
      const key = imageAssetKey(pageId, hash);
      let stored = await bucket.head(key),
        duplicate = stored !== null;
      if (!stored) {
        stored = await bucket.put(key, bytes, {
          onlyIf: { etagDoesNotMatch: "*" },
          httpMetadata: { contentType: image.mime_type, cacheControl: "private, no-store" },
          customMetadata: {
            page_id: pageId,
            hash,
            width: String(image.width),
            height: String(image.height),
          },
        });
        if (!stored) {
          duplicate = true;
          stored = await bucket.head(key);
        }
      }
      if (
        !stored ||
        stored.size !== bytes.byteLength ||
        stored.httpMetadata?.contentType !== image.mime_type
      )
        throw new Error("Image storage did not confirm the immutable object");
      const current = await authorize(true);
      if (!current.ok) return privateResponse(current);
      return privateResponse(
        Response.json(
          { asset_id: hash, url: imageAssetUrl(pageId, hash), ...image, size: bytes.byteLength },
          { status: duplicate ? 200 : 201 },
        ),
      );
    }
    const key = imageAssetKey(pageId, assetId);
    const object = await (request.method === "HEAD" ? bucket.head(key) : bucket.get(key));
    if (!object) throw new HttpError(404, "Image not found");
    if (!IMAGE_MEDIA_TYPES.includes(object.httpMetadata?.contentType))
      throw new Error("Invalid stored image type");
    return privateResponse(
      new Response(request.method === "HEAD" ? null : object.body, {
        headers: {
          "Content-Type": object.httpMetadata.contentType,
          "Content-Length": String(object.size),
          "Content-Disposition": "inline",
          ...(object.httpEtag && { ETag: object.httpEtag }),
        },
      }),
    );
  } catch (error) {
    return privateResponse(errorResponse(error, "image-assets"));
  }
}

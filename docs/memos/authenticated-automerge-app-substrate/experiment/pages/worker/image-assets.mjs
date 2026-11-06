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
import { DATASET_MAX_BYTES, PARQUET_MEDIA_TYPE } from "../shared/dataset-assets.mjs";
import {
  ImageValidationError,
  inspectImage as inspectImageContainer,
} from "../shared/inspect-image.mjs";

export const imageAssetKey = (pageId, assetId) => `pages/${pageId}/assets/${assetId}`;
const ascii = (bytes, offset, length) =>
  String.fromCharCode(...bytes.subarray(offset, offset + length));

/** Validate raster containers and dimensions without decoding pixels in the Worker. */
export function inspectImage(bytes) {
  try {
    return inspectImageContainer(bytes);
  } catch (error) {
    if (error instanceof ImageValidationError) throw new HttpError(error.status, error.message);
    throw error;
  }
}

const PARQUET_MAGIC = "PAR1";
const invalidParquet = () => {
  throw new HttpError(415, "Use a valid, unencrypted Parquet file");
};

/**
 * Check the Parquet container: `PAR1` at both ends and a footer length that
 * fits between them. Encrypted-footer files end in `PARE` and are refused.
 * The Worker never decodes the Thrift footer or any column data; readers
 * decode it in the browser.
 */
export function inspectParquet(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) invalidParquet();
  if (ascii(bytes, 0, 4) !== PARQUET_MAGIC || ascii(bytes, bytes.length - 4, 4) !== PARQUET_MAGIC)
    invalidParquet();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const footer = view.getUint32(bytes.length - 8, true);
  if (footer === 0 || footer > bytes.length - 12) invalidParquet();
  return { mime_type: PARQUET_MEDIA_TYPE };
}

/** The upload route's check: a raster image or a Parquet dataset, chosen by
 * the leading bytes. */
export function inspectAsset(bytes) {
  if (bytes instanceof Uint8Array && bytes.length >= 4 && ascii(bytes, 0, 4) === PARQUET_MAGIC)
    return inspectParquet(bytes);
  try {
    return inspectImage(bytes);
  } catch (error) {
    if (error?.status !== 415) throw error;
    throw new HttpError(415, "Use a valid, static PNG, JPEG, or WebP image, or a Parquet file");
  }
}

const IMAGE_TOO_LARGE = "Images must be 5 MiB or smaller";
const ASSET_MAX_BYTES = Math.max(IMAGE_MAX_BYTES, DATASET_MAX_BYTES);

export async function readImageBody(
  source,
  { signal, tooLarge = IMAGE_TOO_LARGE, maxBytes = IMAGE_MAX_BYTES } = {},
) {
  const length = source.headers.get("content-length");
  const invalidLength = length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes);
  const reader = source.body?.getReader();
  if (!reader)
    throw invalidLength ? new HttpError(413, tooLarge) : new HttpError(400, "Image bytes required");
  let size = 0;
  const chunks = [];
  let onAbort;
  const aborted = signal
    ? new Promise((_, reject) => {
        onAbort = () => reject(signal.reason ?? new HttpError(408, "Image transfer canceled"));
        signal.addEventListener("abort", onAbort, { once: true });
      })
    : undefined;
  try {
    signal?.throwIfAborted();
    if (invalidLength) throw new HttpError(413, tooLarge);
    for (;;) {
      const { done, value } = await (aborted
        ? Promise.race([reader.read(), aborted])
        : reader.read());
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        throw new HttpError(413, tooLarge);
      }
      chunks.push(value);
    }
  } catch (error) {
    // Cancellation must not hold the request open if an upstream stream stalls.
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
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

export function privateImageResponse(response) {
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Cross-Origin-Resource-Policy", "same-origin");
  return response;
}

function storedImageMetadata(object, pageId, assetId) {
  const metadata = object?.customMetadata;
  const width = Number(metadata?.width),
    height = Number(metadata?.height);
  if (
    !object ||
    !IMAGE_MEDIA_TYPES.includes(object.httpMetadata?.contentType) ||
    !Number.isInteger(object.size) ||
    object.size < 12 ||
    object.size > IMAGE_MAX_BYTES ||
    metadata?.page_id !== pageId ||
    metadata?.hash !== assetId ||
    !/^[1-9]\d*$/.test(metadata?.width ?? "") ||
    !/^[1-9]\d*$/.test(metadata?.height ?? "") ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width > IMAGE_MAX_DIMENSION ||
    height > IMAGE_MAX_DIMENSION ||
    width * height > IMAGE_MAX_PIXELS
  )
    throw new HttpError(500, "Invalid stored image metadata");
  return {
    asset_id: assetId,
    asset_url: imageAssetUrl(pageId, assetId),
    mime_type: object.httpMetadata.contentType,
    width,
    height,
    size: object.size,
  };
}

function storedDatasetMetadata(object, pageId, assetId) {
  const metadata = object?.customMetadata;
  if (
    !object ||
    object.httpMetadata?.contentType !== PARQUET_MEDIA_TYPE ||
    !Number.isInteger(object.size) ||
    object.size < 12 ||
    object.size > DATASET_MAX_BYTES ||
    metadata?.page_id !== pageId ||
    metadata?.hash !== assetId ||
    metadata?.width !== undefined ||
    metadata?.height !== undefined
  )
    throw new HttpError(500, "Invalid stored dataset metadata");
  return {
    asset_id: assetId,
    asset_url: imageAssetUrl(pageId, assetId),
    mime_type: PARQUET_MEDIA_TYPE,
    size: object.size,
  };
}

const isDataset = (object) => object?.httpMetadata?.contentType === PARQUET_MEDIA_TYPE;
const storedAssetMetadata = (object, pageId, assetId) =>
  isDataset(object)
    ? storedDatasetMetadata(object, pageId, assetId)
    : storedImageMetadata(object, pageId, assetId);

/**
 * Resolve only a validated immutable asset in this Page. The caller must enforce
 * current Page access; this helper never grants access or reads another Page.
 * Images are retained for undo/offline peers, so HEAD is enough to preflight
 * insertion without downloading their bytes through the document queue.
 */
export async function requireStoredImageAsset(bucket, { pageId, assetId }) {
  if (!validPageId(pageId) || !validAssetId(assetId))
    throw new HttpError(400, "Invalid image reference");
  if (!bucket) throw new HttpError(503, "Image storage is unavailable");
  const stored = await bucket.head(imageAssetKey(pageId, assetId));
  if (!stored) throw new HttpError(404, "Image not found in this Page", "image_not_found");
  if (isDataset(stored))
    throw new HttpError(
      415,
      "This asset is a Parquet dataset, not an image. Show it with insert_node.",
    );
  return storedImageMetadata(stored, pageId, assetId);
}

/** Resolve a validated dataset asset in this Page for insert_node, with HEAD
 * only. Like requireStoredImageAsset, the caller enforces Page access. */
export async function requireStoredDatasetAsset(bucket, { pageId, assetId, mediaType }) {
  if (!validPageId(pageId) || !validAssetId(assetId))
    throw new HttpError(400, "Invalid dataset reference");
  if (!bucket) throw new HttpError(503, "Image storage is unavailable");
  const stored = await bucket.head(imageAssetKey(pageId, assetId));
  if (!stored) throw new HttpError(404, "Dataset not found in this Page", "dataset_not_found");
  if (!isDataset(stored))
    throw new HttpError(415, "This asset is an image, not a dataset. Place it with insert_image.");
  const dataset = storedDatasetMetadata(stored, pageId, assetId);
  if (dataset.mime_type !== mediaType)
    throw new HttpError(415, `This dataset is ${dataset.mime_type}, not ${mediaType}`);
  return dataset;
}

const uploadMismatch = (what) =>
  new HttpError(
    400,
    `The file's ${what} doesn't match the upload URL's. Upload the file it was issued for, or request a new upload URL.`,
    "upload_mismatch",
  );

/** The content type, size and SHA-256 an upload capability bound, checked
 * before anything is stored. */
function checkExpected(expect, { mime_type, size, hash }) {
  if (expect === undefined) return;
  if (!expect || typeof expect !== "object" || Array.isArray(expect))
    throw new Error("Invalid upload expectation");
  if (expect.content_type !== undefined && expect.content_type !== mime_type)
    throw uploadMismatch("content type");
  if (expect.size !== undefined && expect.size !== size) throw uploadMismatch("size");
  if (hash !== undefined && expect.sha256 !== undefined && expect.sha256 !== hash)
    throw uploadMismatch("SHA-256");
}

/**
 * Store only validated original bytes; authorization belongs to the caller.
 * `accept: "image"` admits rasters only (import_page_image, comment images);
 * `accept: "any"` also admits Parquet datasets (the Page asset route).
 * `expect` is an upload capability's binding ({content_type, size, sha256},
 * each optional); bytes that don't match it are refused before storage.
 */
export async function persistPageAsset(
  bucket,
  { pageId, bytes, contentTypes = [], accept = "image", expect },
) {
  if (!validPageId(pageId)) throw new HttpError(400, "Invalid image reference");
  if (bytes.byteLength > (accept === "image" ? IMAGE_MAX_BYTES : ASSET_MAX_BYTES))
    throw new HttpError(413, accept === "image" ? IMAGE_TOO_LARGE : FILE_TOO_LARGE);
  const inspected = accept === "image" ? inspectImage(bytes) : inspectAsset(bytes);
  const dataset = inspected.mime_type === PARQUET_MEDIA_TYPE;
  if (bytes.byteLength > (dataset ? DATASET_MAX_BYTES : IMAGE_MAX_BYTES))
    throw new HttpError(413, dataset ? "Datasets must be 5 MiB or smaller" : IMAGE_TOO_LARGE);
  for (const contentType of contentTypes) {
    const claimed = contentType?.split(";")[0].trim().toLowerCase();
    if (claimed && claimed !== "application/octet-stream" && claimed !== inspected.mime_type)
      throw new HttpError(
        415,
        dataset ? "File bytes do not match Content-Type" : "Image bytes do not match Content-Type",
      );
  }
  checkExpected(expect, { mime_type: inspected.mime_type, size: bytes.byteLength });
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hash = Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
  checkExpected(expect, { mime_type: inspected.mime_type, size: bytes.byteLength, hash });
  const key = imageAssetKey(pageId, hash);
  let stored = await bucket.head(key),
    duplicate = stored !== null;
  if (!stored) {
    stored = await bucket.put(key, bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: inspected.mime_type, cacheControl: "private, no-store" },
      customMetadata: {
        page_id: pageId,
        hash,
        ...(!dataset && { width: String(inspected.width), height: String(inspected.height) }),
      },
    });
    if (!stored) {
      duplicate = true;
      stored = await bucket.head(key);
    }
  }
  const confirmed = storedAssetMetadata(stored, pageId, hash);
  if (
    confirmed.size !== bytes.byteLength ||
    confirmed.mime_type !== inspected.mime_type ||
    confirmed.width !== inspected.width ||
    confirmed.height !== inspected.height
  )
    throw new Error("Asset storage did not confirm the immutable object");
  return {
    asset: {
      asset_id: hash,
      url: imageAssetUrl(pageId, hash),
      ...inspected,
      size: bytes.byteLength,
    },
    duplicate,
  };
}

/** Images only; see persistPageAsset. */
export const persistImageAsset = (bucket, options) =>
  persistPageAsset(bucket, { ...options, accept: "image" });

const FILE_TOO_LARGE = "Files must be 5 MiB or smaller";
const SERVED_MEDIA_TYPES = Object.freeze([...IMAGE_MEDIA_TYPES, PARQUET_MEDIA_TYPE]);

/** An upload capability's binding from the Page host's authorization answer,
 * or undefined for an ordinary credential. */
async function grantedExpectation(access) {
  const body = await access.json();
  return body?.upload && typeof body.upload === "object" ? body.upload : undefined;
}

/** authenticate() for the asset route. An upload with no credential at all
 * is most often an agent whose upload header was lost (curl drops an -H
 * value without a colon), so its refusal names the upload tool first. Other
 * routes keep authenticate()'s own message. */
async function authenticateAssets(request, env, upload) {
  try {
    return await authenticate(request, env);
  } catch (error) {
    if (
      upload &&
      error?.code === "auth_required" &&
      !request.headers.has("authorization") &&
      !request.headers.has("cookie")
    )
      throw new HttpError(
        401,
        `Agents: call create_page_asset_upload for an upload URL and send the headers it returns. ${error.message}`,
        "auth_required",
      );
    throw error;
  }
}

/** The request body of an upload. A capability bound to a size refuses a
 * different Content-Length before reading anything and reads no more than
 * that size; persistPageAsset checks the exact size after. */
async function readUploadBody(request, expect) {
  const bound = expect?.size;
  if (bound === undefined)
    return readImageBody(request, { maxBytes: ASSET_MAX_BYTES, tooLarge: FILE_TOO_LARGE });
  const length = request.headers.get("content-length");
  if (length !== null && length !== String(bound)) throw uploadMismatch("size");
  try {
    return await readImageBody(request, {
      maxBytes: Math.min(bound, ASSET_MAX_BYTES),
      tooLarge: FILE_TOO_LARGE,
    });
  } catch (error) {
    if (error?.status === 413) throw uploadMismatch("size");
    throw error;
  }
}

/**
 * The authorize callback is a short Page-DO request; byte transfer stays
 * outside its queue. `identify` checks the caller's credential before any
 * Page is asked; it defaults to authenticate(). An upload capability
 * (asset-uploads.mjs) replaces it with the Origin check alone, and its
 * authorize callback carries the capability to the Page host instead.
 */
export async function handleImageAssets(request, env, { pageId, assetId, authorize, identify }) {
  try {
    if (!validPageId(pageId) || (assetId !== undefined && !validAssetId(assetId)))
      throw new HttpError(400, "Invalid image reference");
    const upload = assetId === undefined && request.method === "POST";
    if (!upload && !(assetId && ["GET", "HEAD"].includes(request.method)))
      throw new HttpError(405, assetId ? "Use GET or HEAD" : "Use POST");
    // In particular this does not widen the MCP-only OAuth token audience.
    await (identify ? identify() : authenticateAssets(request, env, upload));
    const access = await authorize(upload);
    if (!access.ok) return privateImageResponse(access);
    const expect = upload ? await grantedExpectation(access) : undefined;
    const bucket = env.PAGES_ASSETS;
    if (!bucket) throw new HttpError(503, "Image storage is unavailable");
    if (upload) {
      const bytes = await readUploadBody(request, expect);
      const { asset, duplicate } = await persistPageAsset(bucket, {
        pageId,
        bytes,
        contentTypes: [request.headers.get("content-type")],
        accept: "any",
        expect,
      });
      const current = await authorize(true);
      if (!current.ok) return privateImageResponse(current);
      return privateImageResponse(
        Response.json({ ...asset, asset_url: asset.url }, { status: duplicate ? 200 : 201 }),
      );
    }
    const key = imageAssetKey(pageId, assetId);
    const object = await (request.method === "HEAD" ? bucket.head(key) : bucket.get(key));
    if (!object) throw new HttpError(404, "Image not found");
    const contentType = object.httpMetadata?.contentType;
    if (!SERVED_MEDIA_TYPES.includes(contentType)) throw new Error("Invalid stored asset type");
    // A dataset is data for the viewer to fetch, never a document to open:
    // navigating to it downloads the file.
    const disposition =
      contentType === PARQUET_MEDIA_TYPE ? `attachment; filename="${assetId}.parquet"` : "inline";
    return privateImageResponse(
      new Response(request.method === "HEAD" ? null : object.body, {
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(object.size),
          "Content-Disposition": disposition,
          ...(object.httpEtag && { ETag: object.httpEtag }),
        },
      }),
    );
  } catch (error) {
    return privateImageResponse(errorResponse(error, "image-assets"));
  }
}

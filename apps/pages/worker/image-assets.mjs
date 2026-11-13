import { authenticate, HttpError, errorResponse } from "./auth.mjs";
import { validPageId } from "./registration.mjs";
import { setResponseHeaders } from "./response-headers.mjs";
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
/** Listing pages one deletion reads. R2 lists up to 1,000 keys a page. */
const ASSET_DELETE_PAGES = 16;

/** Delete a Page's uploaded images and datasets: every key under its asset
 * prefix that at most ASSET_DELETE_PAGES listing pages find. A bucket that
 * can't list deletes nothing. Bytes an upload stores after this runs stay
 * unreferenced; no deleted Page serves them. */
export async function deleteUploadedAssets(bucket, pageId) {
  if (typeof bucket?.list !== "function") return;
  let cursor;
  for (let page = 0; page < ASSET_DELETE_PAGES; page++) {
    const listed = await bucket.list({ prefix: imageAssetKey(pageId, ""), cursor });
    const keys = (listed.objects ?? []).map((object) => object.key);
    if (keys.length) await bucket.delete(keys);
    if (!listed.truncated) return;
    cursor = listed.cursor;
  }
}
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
 * the leading bytes. `expected` is the content type an upload capability
 * bound, if any: bytes that are neither kind are refused with what that
 * upload takes. */
export function inspectAsset(bytes, expected) {
  if (bytes instanceof Uint8Array && bytes.length >= 4 && ascii(bytes, 0, 4) === PARQUET_MAGIC)
    return inspectParquet(bytes);
  try {
    return inspectImage(bytes);
  } catch (error) {
    if (error?.status !== 415) throw error;
    if (expected === PARQUET_MEDIA_TYPE)
      throw new HttpError(
        415,
        "This upload URL takes a Parquet file, and this file isn't one. Send a valid, unencrypted Parquet file.",
      );
    if (IMAGE_MEDIA_TYPES.includes(expected)) throw error;
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

const ASSET_HEADERS = [
  ["X-Content-Type-Options", "nosniff"],
  ["Cross-Origin-Resource-Policy", "same-origin"],
];

/** Mark a response as private and uncacheable: refusals, errors and upload
 * results. Refusals passed through from the Page host arrive with immutable
 * headers, so the result may be a copy. */
export function privateImageResponse(response) {
  return setResponseHeaders(response, [["Cache-Control", "private, no-store"], ...ASSET_HEADERS]);
}

/** Mark asset bytes the caller was just allowed to read. An asset URL names
 * the SHA-256 of its bytes, so a browser may keep them without revalidating.
 * Each request that reaches the Worker is still access-checked; bytes already
 * in a reader's cache stay there after their access is revoked. Shared caches
 * never store them. */
export function servedAssetResponse(response) {
  return setResponseHeaders(response, [
    ["Cache-Control", "private, max-age=31536000, immutable"],
    ...ASSET_HEADERS,
  ]);
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

/** Resolve a validated dataset asset in this Page for insert_node and
 * set_source, with HEAD only. Like requireStoredImageAsset, the caller
 * enforces Page access. `mediaType`, when given, is the one the dataset must
 * be stored as; without it the stored record's `mime_type` is the answer. */
export async function requireStoredDatasetAsset(bucket, { pageId, assetId, mediaType }) {
  if (!validPageId(pageId) || !validAssetId(assetId))
    throw new HttpError(400, "Invalid dataset reference");
  if (!bucket) throw new HttpError(503, "Image storage is unavailable");
  const stored = await bucket.head(imageAssetKey(pageId, assetId));
  if (!stored) throw new HttpError(404, "Dataset not found in this Page", "dataset_not_found");
  if (!isDataset(stored))
    throw new HttpError(415, "This asset is an image, not a dataset. Place it with insert_image.");
  const dataset = storedDatasetMetadata(stored, pageId, assetId);
  if (mediaType !== undefined && dataset.mime_type !== mediaType)
    throw new HttpError(415, `This dataset is ${dataset.mime_type}, not ${mediaType}`);
  return dataset;
}

const uploadMismatch = (what) =>
  new HttpError(
    400,
    `The file's ${what} doesn't match the upload URL's. Upload the file it was issued for, or request a new upload URL.`,
    "upload_mismatch",
  );

/** The content type and size an upload capability bound, checked before
 * anything is stored. */
function checkExpected(expect, { mime_type, size }) {
  if (expect === undefined) return;
  if (!expect || typeof expect !== "object" || Array.isArray(expect))
    throw new Error("Invalid upload expectation");
  if (expect.content_type !== undefined && expect.content_type !== mime_type)
    throw uploadMismatch("content type");
  if (expect.size !== undefined && expect.size !== size) throw uploadMismatch("size");
}

/**
 * Store only validated original bytes, a raster or a Parquet dataset;
 * authorization belongs to the caller. `expect` is an upload capability's binding ({content_type, size}, each
 * optional); bytes that don't match it are refused before storage.
 */
export async function persistPageAsset(bucket, { pageId, bytes, contentTypes = [], expect }) {
  if (!validPageId(pageId)) throw new HttpError(400, "Invalid image reference");
  if (bytes.byteLength > ASSET_MAX_BYTES) throw new HttpError(413, FILE_TOO_LARGE);
  const inspected = inspectAsset(bytes, expect?.content_type);
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

/**
 * The edit_page operation that places a stored asset as the block its type
 * calls for: insert_image for a raster, an insert_node dataframe for a Parquet
 * dataset. insert_image also needs alt text, which only the caller can write,
 * so the operation leaves it out and edit_page refuses it until alt is added.
 */
export const assetInsertOperation = ({ asset_id, mime_type }) =>
  mime_type === PARQUET_MEDIA_TYPE
    ? { op: "insert_node", node: { type: "dataframe", attrs: { asset_id } } }
    : { op: "insert_image", asset_id };

/** The answer to a stored upload or copy: the asset, its URL under both names,
 * and the operation that places it. */
const assetReceipt = (asset) => ({
  ...asset,
  asset_url: asset.url,
  insert: assetInsertOperation(asset),
});

const FILE_TOO_LARGE = "Files must be 5 MiB or smaller";
/** Read an image or dataset body under the shared asset ceiling. */
export const readAssetBody = (source, { signal } = {}) =>
  readImageBody(source, { signal, maxBytes: ASSET_MAX_BYTES, tooLarge: FILE_TOO_LARGE });
const SERVED_MEDIA_TYPES = Object.freeze([...IMAGE_MEDIA_TYPES, PARQUET_MEDIA_TYPE]);

/** An upload capability's binding from the Page host's authorization answer,
 * or undefined for an ordinary credential. */
async function grantedExpectation(access) {
  const body = await access.json();
  return body?.upload && typeof body.upload === "object" ? body.upload : undefined;
}

/** authenticate() for the asset route. An upload with no credential at all
 * is most often an agent whose upload header was lost (curl drops an -H
 * value without a colon), so its refusal names the upload tool first. A
 * browser always sends Origin on a POST, so a person whose session cookie
 * lapsed keeps the sign-in message. Other routes keep authenticate()'s own
 * message. */
export async function authenticateAssets(request, env, upload) {
  try {
    return await authenticate(request, env);
  } catch (error) {
    if (
      upload &&
      error?.code === "auth_required" &&
      !request.headers.has("authorization") &&
      !request.headers.has("cookie") &&
      !request.headers.has("origin")
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

const COPY_BODY_MAX_BYTES = 1024;

/** The source Page a copy request names: `{"from_page_id": "<page id>"}`. */
async function readCopySource(request) {
  const type = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (type !== "application/json")
    throw new HttpError(415, "Send the source Page as JSON", "invalid_arguments");
  let args;
  try {
    const bytes = await readImageBody(request, {
      maxBytes: COPY_BODY_MAX_BYTES,
      tooLarge: "The copy request is too large",
    });
    args = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof HttpError && error.status === 413) throw error;
    throw new HttpError(400, "The copy request must be JSON", "invalid_arguments");
  }
  if (
    !args ||
    typeof args !== "object" ||
    Array.isArray(args) ||
    Object.keys(args).some((key) => key !== "from_page_id") ||
    !validPageId(args.from_page_id)
  )
    throw new HttpError(
      400,
      "A copy takes from_page_id, the Page the dataset is on",
      "invalid_arguments",
    );
  return args.from_page_id;
}

/**
 * Copy the dataset `assetId` from `sourceId` onto `pageId`, under the same
 * id: the id is the SHA-256 of the bytes, so the copy is the same asset. The
 * caller has edit access to `pageId` and read access to `sourceId`; nothing
 * here looks at `sourceId`'s storage before that. The bytes go through
 * persistPageAsset, so a copy meets every check and limit an upload does, and
 * a dataset already on `pageId` is the answer without a second write.
 */
async function copyDatasetAsset(bucket, { pageId, assetId, sourceId }) {
  const source = await bucket.head(imageAssetKey(sourceId, assetId));
  if (!source)
    throw new HttpError(404, "Dataset not found in the source Page", "dataset_not_found");
  if (!isDataset(source))
    throw new HttpError(415, "This asset is an image, not a dataset. Only datasets copy.");
  const stored = await bucket.head(imageAssetKey(pageId, assetId));
  if (stored) {
    if (!isDataset(stored)) throw new Error("A stored asset's type disagrees with its id");
    const { asset_url, ...dataset } = storedDatasetMetadata(stored, pageId, assetId);
    return { asset: { ...dataset, url: asset_url }, duplicate: true };
  }
  if (!Number.isSafeInteger(source.size) || source.size > DATASET_MAX_BYTES)
    throw new HttpError(413, "Datasets must be 5 MiB or smaller");
  const object = await bucket.get(imageAssetKey(sourceId, assetId));
  if (!object)
    throw new HttpError(404, "Dataset not found in the source Page", "dataset_not_found");
  const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
  const copied = await persistPageAsset(bucket, {
    pageId,
    bytes,
    contentTypes: [PARQUET_MEDIA_TYPE],
    expect: { content_type: PARQUET_MEDIA_TYPE },
  });
  if (copied.asset.asset_id !== assetId)
    throw new Error("A stored dataset's bytes disagree with its id");
  return copied;
}

/**
 * The authorize callback is a short Page-DO request; byte transfer stays
 * outside its queue. `identify` checks the caller's credential before any
 * Page is asked; it defaults to authenticate(). An upload capability
 * (asset-uploads.mjs) replaces it with the Origin check alone, and its
 * authorize callback carries the capability to the Page host instead.
 *
 * `POST` to an asset's own URL copies a dataset from another Page, named by
 * `from_page_id`. `authorizeSource(sourceId)` asks that Page whether the
 * caller can read it, as a read of its asset would. The destination's edit
 * check comes first and the source's second, and neither Page's storage is
 * touched until both pass: a caller who can't read the source learns only
 * what a read of the source's asset URL would tell them.
 */
export async function handleImageAssets(
  request,
  env,
  { pageId, assetId, authorize, authorizeSource, identify },
) {
  try {
    if (!validPageId(pageId)) throw new HttpError(400, "Invalid image reference");
    if (assetId !== undefined && !validAssetId(assetId))
      throw new HttpError(
        400,
        "An asset id is the 64 lowercase hex characters an upload returned as asset_id",
        "invalid_arguments",
      );
    const upload = assetId === undefined && request.method === "POST";
    const copy = assetId !== undefined && request.method === "POST" && !!authorizeSource;
    if (!upload && !copy && !(assetId && ["GET", "HEAD"].includes(request.method)))
      throw new HttpError(405, assetId ? "Use GET or HEAD" : "Use POST");
    // In particular this does not widen the MCP-only OAuth token audience.
    await (identify ? identify() : authenticateAssets(request, env, upload));
    if (copy) {
      const sourceId = await readCopySource(request);
      const target = await authorize(true);
      if (!target.ok) return privateImageResponse(target);
      const source = await authorizeSource(sourceId);
      if (!source.ok) return privateImageResponse(source);
      const bucket = env.PAGES_ASSETS;
      if (!bucket) throw new HttpError(503, "Image storage is unavailable");
      const { asset, duplicate } = await copyDatasetAsset(bucket, { pageId, assetId, sourceId });
      const current = await authorize(true);
      if (!current.ok) return privateImageResponse(current);
      return privateImageResponse(
        Response.json(assetReceipt(asset), { status: duplicate ? 200 : 201 }),
      );
    }
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
        expect,
      });
      const current = await authorize(true);
      if (!current.ok) return privateImageResponse(current);
      return privateImageResponse(
        Response.json(assetReceipt(asset), { status: duplicate ? 200 : 201 }),
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
    return servedAssetResponse(
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

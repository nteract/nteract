/**
 * edit_page's `asset_from`: an operation that names a dataset may say which
 * Page or Project the dataset is on. When the dataset isn't on the edited
 * Page yet, the Worker copies it there (copyDatasetAsset) and the edit then
 * applies as if it had been uploaded there.
 *
 * The gateway reads `asset_from` off each operation and forwards the batch
 * without it, so the Page host validates, fingerprints and journals the
 * operations as it always has. The hints travel beside `arguments` as
 * `asset_hints`, a list of asset ids. For a new intent the host checks each
 * asset on its own Page as it always does; an asset with a hint that isn't
 * there makes the host answer `copyRequiredResponse` instead of
 * `dataset_not_found`, before anything is journaled. A recorded receipt
 * replays before that check, so a retry with the same nonce never asks for
 * the source. The gateway then checks the source, copies outside the host's
 * queue, and forwards the batch again without hints, where every asset must
 * be on the Page, exactly as without `asset_from`.
 *
 * An asset already on the Page never consults the source: the caller holds
 * edit access to the Page, so the answer discloses nothing about the source.
 */
import { HttpError } from "./auth.mjs";
import { copyDatasetAsset } from "./image-assets.mjs";
import { validPageId } from "./registration.mjs";
import { validSpaceId } from "./spaces.mjs";
import { validAssetId } from "../shared/image-assets.mjs";

/** Codes only this module writes. dataset_not_found and invalid_arguments
 * are the service's own (CLIENT_ERROR_CODES). */
export const COPY_ERROR_CODES = Object.freeze([
  "source_not_readable",
  "not_a_dataset",
  "dataset_too_large",
  "too_many_copies",
]);

/** The most datasets one batch copies, and how many copy at once: a paste's
 * own limits (viewer/dataframe-copy.mjs). */
export const MAX_DATASET_COPIES = 8;
const COPY_CONCURRENCY = 2;

/** The header on a host answer that asks the gateway to copy. */
export const COPY_REQUIRED_HEADER = "x-pages-asset-copy";

/** Thrown by the Page host when assets with a hint are missing from it. */
export class DatasetCopyRequired extends Error {
  constructor(assetIds) {
    super("Dataset copy required");
    this.assetIds = assetIds;
  }
}

/** The host's answer to DatasetCopyRequired. Only the gateway sees it: it
 * is sent only to a request that carried `asset_hints`. */
export const copyRequiredResponse = (error) =>
  Response.json(
    { asset_ids: error.assetIds },
    { status: 409, headers: { [COPY_REQUIRED_HEADER]: "required" } },
  );

const invalid = (message) => new HttpError(400, message, "invalid_arguments");

/** The asset an operation names, and its kind. */
function namedAsset(op) {
  switch (op.op) {
    case "set_source":
      return { assetId: op.asset_id, kind: "dataset" };
    case "insert_node":
      return op.node?.type === "dataframe"
        ? { assetId: op.node?.attrs?.asset_id, kind: "dataset" }
        : undefined;
    case "set_node":
      return op.attrs && Object.hasOwn(op.attrs, "asset_id")
        ? { assetId: op.attrs.asset_id, kind: "dataset" }
        : undefined;
    case "insert_image":
    case "set_image":
      return { assetId: op.asset_id, kind: "image" };
    default:
      return undefined;
  }
}

/**
 * Split edit_page `args` into the batch the Page host takes, with no
 * `asset_from`, and its hints: `Map<asset_id, {source, kind}>`. A source is
 * `{ page_id }` or `{ project_id }`. A malformed `asset_from`, or one on an
 * operation that names no asset, is `invalid_arguments`. Nothing here looks
 * at storage or asks any host.
 */
export function takeAssetHints(args) {
  const hints = new Map();
  if (!Array.isArray(args?.operations)) return { args, hints };
  let changed = false;
  const operations = args.operations.map((op) => {
    if (!op || typeof op !== "object" || !Object.hasOwn(op, "asset_from")) return op;
    changed = true;
    const { asset_from: from, ...rest } = op;
    const source = validSpaceId(from)
      ? { project_id: from }
      : validPageId(from)
        ? { page_id: from }
        : undefined;
    if (!source)
      throw invalid("asset_from is the id of the Page or Project (prj_…) the asset is on");
    // Inline text is the caller's own bytes; it names no asset to copy.
    if (rest.op === "set_source" && Object.hasOwn(rest, "text"))
      throw invalid("asset_from goes with asset_id; a set_source with text names no other asset");
    const named = namedAsset(rest);
    if (!named)
      throw invalid(
        "asset_from goes on set_source, a dataframe insert_node, or set_node with attrs.asset_id",
      );
    // A missing or malformed asset_id is the host's own refusal, as today.
    if (validAssetId(named.assetId) && !hints.has(named.assetId))
      hints.set(named.assetId, { source, kind: named.kind });
    return rest;
  });
  return { args: changed ? { ...args, operations } : args, hints };
}

/**
 * Throw DatasetCopyRequired for the hinted assets `check` doesn't find on
 * this Page. `assets` are `{ assetId, ... }` in batch order; `check(asset)`
 * is the host's own preflight for one. An asset without a hint, and every
 * other refusal, throws as it always has.
 */
export async function checkHintedAssets(assets, hints, check) {
  const hinted = new Set(Array.isArray(hints) ? hints : []);
  const missing = [];
  for (const asset of assets) {
    try {
      await check(asset);
    } catch (error) {
      if (
        !hinted.has(asset.assetId) ||
        !["dataset_not_found", "image_not_found"].includes(error?.code)
      )
        throw error;
      if (!missing.includes(asset.assetId)) missing.push(asset.assetId);
    }
  }
  if (missing.length) throw new DatasetCopyRequired(missing);
}

/** A refusal with one of COPY_ERROR_CODES, written here so the code reaches
 * the caller; any other error is rethrown. */
export function copyRefusal(error) {
  if (!COPY_ERROR_CODES.includes(error?.code)) throw error;
  return Response.json({ error: error.message, code: error.code }, { status: error.status });
}

const sourceKey = (source) => source.project_id ?? source.page_id;

/**
 * Copy the hinted assets the host found missing (`assetIds`) onto
 * `destination` (`{ page_id, project_id? }`). Every refusal known from the
 * request comes first: an image, too many copies, a source that is the
 * destination itself. Then each distinct source's read check,
 * `authorizeSource(source)`, which resolves to the Page id whose asset store
 * holds the dataset or throws; then the copies, at most COPY_CONCURRENCY at a
 * time. No storage is read before every check has passed.
 */
export async function copyHintedDatasets({
  assetIds,
  hints,
  destination,
  bucket,
  authorizeSource,
}) {
  const wanted = assetIds.filter((id) => hints.has(id));
  if (wanted.some((id) => hints.get(id).kind === "image"))
    throw new HttpError(
      415,
      "Only Parquet datasets copy between Pages. Upload the image to this Page with create_page_asset_upload.",
      "not_a_dataset",
    );
  if (wanted.length > MAX_DATASET_COPIES)
    throw new HttpError(
      400,
      `One edit_page batch copies up to ${MAX_DATASET_COPIES} datasets; this one needs ${wanted.length}. Send the rest in another batch.`,
      "too_many_copies",
    );
  for (const id of wanted) {
    const { source } = hints.get(id);
    if (
      (source.page_id !== undefined && source.page_id === destination.page_id) ||
      (source.project_id !== undefined && source.project_id === destination.project_id)
    )
      throw new HttpError(404, "Dataset not found in this Page", "dataset_not_found");
  }
  if (!bucket) throw new HttpError(503, "Image storage is unavailable");
  const pages = new Map();
  for (const id of wanted) {
    const key = sourceKey(hints.get(id).source);
    if (!pages.has(key)) pages.set(key, await authorizeSource(hints.get(id).source));
  }
  const queue = [...wanted];
  const worker = async () => {
    while (queue.length) {
      const assetId = queue.shift();
      await copyDatasetAsset(bucket, {
        pageId: destination.page_id,
        assetId,
        sourceId: pages.get(sourceKey(hints.get(assetId).source)),
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(COPY_CONCURRENCY, queue.length) }, worker));
}

/** The refusal for a source the caller can't read, or that doesn't exist:
 * the same either way, and never about the dataset. */
export const sourceNotReadable = () =>
  new HttpError(
    403,
    "asset_from names a Page or Project you can't read, or one that doesn't exist",
    "source_not_readable",
  );

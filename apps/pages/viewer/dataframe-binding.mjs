// The reference stored on a dataframe, shared by the editor and renderer.
import { parseAssetPath } from "../shared/dataset-assets.mjs";
import { imageAssetUrl } from "../shared/image-assets.mjs";

/**
 * The asset a dataframe node pins, as a binding: `{ asset_id }` for a node
 * whose `src` is a Page asset path, otherwise null. `dataframe` is the node's
 * read attrs (shared/dataset-assets.mjs readDataframe).
 */
export function pinnedBinding(dataframe) {
  const path = parseAssetPath(dataframe?.src);
  return path ? { asset_id: path.assetId } : null;
}

/**
 * The path a table with an asset binding fetches. A node's own pin fetches
 * its stored `src` unchanged, so a `src` on another Page is still refused
 * before any request (sift-dataset.mjs fetchDataset). Only an asset binding
 * that didn't come from `src` names a path on `pageId`.
 */
export function assetPath(src, pageId, binding) {
  const assetId = binding?.asset_id;
  if (typeof assetId !== "string" || parseAssetPath(src)?.assetId === assetId) return src;
  return imageAssetUrl(pageId, assetId);
}

/** A binding as the drawing code compares it: one source or one asset. */
export function bindingKey(binding) {
  if (binding && typeof binding.source_id === "string")
    return `source:${binding.source_id}:${binding.revision ?? "follow"}`;
  if (binding && typeof binding.asset_id === "string") return `asset:${binding.asset_id}`;
  return "none";
}

/** The node's stored reference, with the original asset form still supported. */
export const storedBinding = (dataframe) => dataframe?.binding ?? pinnedBinding(dataframe);

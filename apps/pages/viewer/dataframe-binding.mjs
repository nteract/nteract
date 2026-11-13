// What a dataframe node draws from. A stored node names one dataset asset
// (its `src`), and nothing in the stored document names a source yet, so the
// editor draws every node from its pinned asset. The drawing code
// (wordgard-dataframes.mjs) takes the binding as a function, so a source
// binding can be supplied without a stored shape.
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
  if (binding && typeof binding.source_id === "string") return `source:${binding.source_id}`;
  if (binding && typeof binding.asset_id === "string") return `asset:${binding.asset_id}`;
  return "none";
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** The global a browser test sets before the app loads, on a loopback origin
 * only, to draw tables from a binding of its own. */
export const TEST_BINDING_GLOBAL = "__PAGES_TEST_DATAFRAME_BINDING__";

/**
 * The binding the editor draws with: pinnedBinding, unless this is a
 * loopback origin and a browser test set TEST_BINDING_GLOBAL to a function.
 * Then that function decides, and a node it returns nothing for draws its
 * pinned asset. This test seam goes when a node can name its source.
 */
export function editorBinding(scope = globalThis) {
  const custom = LOOPBACK.has(scope.location?.hostname) ? scope[TEST_BINDING_GLOBAL] : undefined;
  if (typeof custom !== "function") return pinnedBinding;
  return (dataframe) => {
    try {
      return custom(dataframe) ?? pinnedBinding(dataframe);
    } catch {
      return pinnedBinding(dataframe);
    }
  };
}

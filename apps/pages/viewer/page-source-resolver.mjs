import { imageAssetUrl, validAssetId } from "../shared/image-assets.mjs";
import { parseAssetPath } from "../shared/dataset-assets.mjs";
import { DATAFRAME_LIMITS, fetchDataset } from "./sift-dataset.mjs";

/** Pure lifecycle for a consumer's load. Effects follow guarded transitions. */
export function sourceLoadStep(state, event) {
  if (event === "dispose") return "disposed";
  if (["disposed", "failed", "ready"].includes(state)) return state;
  if (event === "failed") return "failed";
  if (state === "fetching" && event === "bytes") return "decoding";
  if (state === "decoding" && event === "decoded") return "ready";
  return state;
}

export function sourceResolverStep(state, event) {
  return event === "dispose" ? "disposed" : state;
}

/** One reader's resolver for one Page; destroy on Page/session/access changes.
 * readBinding snapshots an admitted binding's exact revision synchronously.
 * Cache immutable bytes only: Sift TableData owns a mutable WASM store, so each
 * consumer must receive its own decoded table and dispose it when finished.
 * Inject loadTableFile to preserve the decoder's lazy-loading boundary.
 */
export function createPageSourceResolver({
  pageId,
  readBinding,
  loadTableFile,
  request,
  maxEntries = 4,
}) {
  if (!parseAssetPath(imageAssetUrl(pageId, "0".repeat(64)))) throw Error("Invalid Page ID");
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 16)
    throw Error("Invalid source cache size");
  const cache = new Map();
  const controller = new AbortController();
  let state = "active";
  const stopped = () => new DOMException("Source load stopped", "AbortError");

  async function resolveSource(alias, { signal } = {}) {
    if (state === "disposed") throw stopped();
    signal?.throwIfAborted();
    const binding = { ...readBinding(alias) };
    if (!validAssetId(binding.asset_id)) throw Error(`Source ${alias} has no valid asset`);
    const key = binding.asset_id;
    let pending = cache.get(key);
    if (!pending) {
      pending = fetchDataset(imageAssetUrl(pageId, key), {
        pageId,
        signal: controller.signal,
        request,
      });
      cache.set(key, pending);
      pending.catch(() => {
        if (cache.get(key) === pending) cache.delete(key);
      });
      while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
    } else {
      cache.delete(key);
      cache.set(key, pending);
    }
    let loadState = "fetching";
    const cancel = () => {
      loadState = sourceLoadStep(loadState, "dispose");
    };
    signal?.addEventListener("abort", cancel, { once: true });
    controller.signal.addEventListener("abort", cancel, { once: true });
    try {
      // Cancel one consumer without cancelling the shared download.
      const bytes = await forConsumer(pending, signal);
      if (signal?.aborted || controller.signal.aborted) cancel();
      loadState = sourceLoadStep(loadState, "bytes");
      if (loadState !== "decoding") throw stopped();
      const table = await loadTableFile(bytes.slice(), DATAFRAME_LIMITS);
      loadState = sourceLoadStep(loadState, "decoded");
      if (loadState !== "ready") {
        table.dispose?.();
        throw stopped();
      }
      return {
        table,
        release: () => table.dispose?.(),
        asset_id: key,
        ...(binding.source_id === undefined ? {} : { source_id: binding.source_id }),
        ...(binding.source_revision === undefined
          ? {}
          : { source_revision: binding.source_revision }),
      };
    } catch (error) {
      loadState = sourceLoadStep(loadState, "failed");
      throw error;
    } finally {
      signal?.removeEventListener("abort", cancel);
      controller.signal.removeEventListener("abort", cancel);
    }
  }
  return {
    resolveSource,
    destroy() {
      state = sourceResolverStep(state, "dispose");
      controller.abort();
      cache.clear();
    },
  };
}

function forConsumer(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

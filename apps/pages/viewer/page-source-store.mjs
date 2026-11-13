// A Page's named sources, outside React: one store per Page session. Its
// input is the sources document alone (sources-replica.mjs), so a prose edit
// never reaches it.
//
// - `sources$`: the sources as a projection of the document, by id.
// - `versions(ids)`: `{ [id]: version | null }`, emitted on subscribe and
//   again only when one of those sources changes.
// - `resolver(loadTableFile)`: the Page's one resolver. It turns a binding,
//   `{ source_id }` or `{ asset_id }`, into the version it reads now, and
//   loads that version's table through Sift's loader with one byte cache.
//
// A version is `{ source_id?, asset_id, media_type, revision }`. `revision`
// is the source's revision, or null for a pinned asset.
import { distinctUntilChanged, map } from "rxjs";
import { readSource } from "../model/sources-doc.mjs";
import { imageAssetUrl, validAssetId } from "../shared/image-assets.mjs";
import { PARQUET_MEDIA_TYPE } from "../shared/dataset-assets.mjs";
import { DATAFRAME_LIMITS, fetchDataset } from "./sift-dataset.mjs";
import { Store } from "./store.mjs";

const NO_SOURCES = Object.freeze({});

/**
 * Every readable source in a sources document, by id: `{ source_id, name,
 * asset_id, media_type, revision }`. An entry the host would refuse to read
 * (model/sources-doc.mjs) reads here as missing, so one broken entry hides
 * only itself. `doc` undefined is a Page with no sources document.
 */
export function projectSources(doc) {
  const ids = doc?.sources && typeof doc.sources === "object" ? Object.keys(doc.sources) : [];
  if (!ids.length) return NO_SOURCES;
  const sources = {};
  for (const id of ids.sort()) {
    let source;
    try {
      source = readSource(doc, id);
    } catch {
      continue;
    }
    sources[id] = Object.freeze({
      source_id: id,
      name: source.name,
      asset_id: source.asset_id,
      media_type: source.media_type,
      revision: source.source_revision,
    });
  }
  return Object.freeze(sources);
}

/** Two projections hold the same sources: same ids, and each id's name,
 * asset, media type and revision alike. */
const sameVersion = (a, b) =>
  a === b ||
  (!!a &&
    !!b &&
    a.asset_id === b.asset_id &&
    a.revision === b.revision &&
    a.media_type === b.media_type &&
    a.name === b.name);
const sameSources = (a, b) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((id) => sameVersion(a[id], b[id]));
};

/** A binding that names nothing this store can read. */
export class SourceUnavailable extends Error {
  constructor(message, binding) {
    super(message);
    this.name = "SourceUnavailable";
    this.binding = binding;
  }
}

export class PageSourceStore {
  #sources = new Store(NO_SOURCES);
  #subscription;
  #resolver;
  #destroyed = false;
  /** The sources by id, deduplicated per source. */
  sources$ = this.#sources.state$.pipe(distinctUntilChanged(sameSources));

  /** `doc$` emits the sources document, or undefined while there is none. */
  constructor({ pageId, doc$, request, maxEntries = 4 }) {
    if (typeof pageId !== "string" || !pageId) throw Error("A source store needs its Page id");
    this.pageId = pageId;
    this.request = request;
    this.maxEntries = maxEntries;
    this.#subscription = doc$.subscribe((doc) => {
      const next = projectSources(doc);
      this.#sources.update((current) => (sameSources(current, next) ? current : next));
    });
  }

  /** The current sources by id. */
  snapshot() {
    return this.#sources.snapshot();
  }

  /** `{ [id]: version | null }` for `ids`, now and on each change to one of
   * them. Other sources changing, or the document changing without a source
   * changing, emits nothing. */
  versions(ids) {
    const list = [...new Set(ids)];
    return this.#sources.state$.pipe(
      map((sources) =>
        Object.fromEntries(list.map((id) => [id, Object.hasOwn(sources, id) ? sources[id] : null])),
      ),
      distinctUntilChanged((a, b) => list.every((id) => sameVersion(a[id], b[id]))),
    );
  }

  /** The version a binding reads now. Throws SourceUnavailable for a source
   * the Page doesn't hold and for an invalid binding. */
  resolve(binding) {
    if (binding && typeof binding.source_id === "string") {
      const sources = this.#sources.snapshot();
      if (!Object.hasOwn(sources, binding.source_id))
        throw new SourceUnavailable("This table's source isn't on this Page.", binding);
      const { source_id, asset_id, media_type, revision } = sources[binding.source_id];
      return { source_id, asset_id, media_type, revision };
    }
    if (binding && validAssetId(binding.asset_id))
      return {
        asset_id: binding.asset_id,
        media_type: binding.media_type ?? PARQUET_MEDIA_TYPE,
        revision: null,
      };
    throw new SourceUnavailable("This table names no dataset.", binding);
  }

  /**
   * The Page's one resolver, made on first use so the decoder stays in the
   * renderer's chunk. `loadTableFile` is Sift's. The resolver's
   * `load(version, { signal })` returns `{ table, ...version }` for a version
   * from resolve() or versions(); the caller owns `table` and frees it
   * (`table.dispose()`), as Sift does when the table unmounts or a newer
   * version replaces it. A table decoded for a load whose signal aborted
   * first is freed here.
   */
  resolver(loadTableFile) {
    if (this.#destroyed) throw Error("This Page's sources are closed");
    this.#resolver ??= createResolver({
      pageId: this.pageId,
      loadTableFile,
      request: this.request,
      maxEntries: this.maxEntries,
    });
    return this.#resolver;
  }

  /** Stop following the document, cancel downloads and drop the byte cache. */
  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#subscription.unsubscribe();
    this.#resolver?.destroy();
    this.#resolver = undefined;
  }
}

/**
 * Bytes by asset id, shared by every table on the Page: a dataset's bytes
 * never change for its id. At most `maxEntries` are kept, least recently
 * used first out. Each load decodes its own table, because a Sift table owns
 * a mutable WASM store.
 */
function createResolver({ pageId, loadTableFile, request, maxEntries }) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 16)
    throw Error("Invalid source cache size");
  const cache = new Map();
  const stop = new AbortController();
  const stopped = () => new DOMException("Source load stopped", "AbortError");

  function bytesOf(assetId) {
    let pending = cache.get(assetId);
    if (pending) {
      cache.delete(assetId);
      cache.set(assetId, pending);
      return pending;
    }
    pending = fetchDataset(imageAssetUrl(pageId, assetId), {
      pageId,
      signal: stop.signal,
      ...(request && { request }),
    });
    cache.set(assetId, pending);
    pending.catch(() => {
      if (cache.get(assetId) === pending) cache.delete(assetId);
    });
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
    return pending;
  }

  async function load(version, { signal } = {}) {
    if (stop.signal.aborted) throw stopped();
    signal?.throwIfAborted();
    if (!version || !validAssetId(version.asset_id))
      throw new SourceUnavailable("This table names no dataset.", version);
    if (version.media_type !== PARQUET_MEDIA_TYPE)
      throw new SourceUnavailable(`This build can't show ${version.media_type}.`, version);
    // One reader's abort leaves the shared download running for the others.
    const bytes = await forReader(bytesOf(version.asset_id), signal);
    if (signal?.aborted || stop.signal.aborted) throw stopped();
    const table = await loadTableFile(bytes.slice(), DATAFRAME_LIMITS);
    if (signal?.aborted || stop.signal.aborted) {
      table.dispose?.();
      throw stopped();
    }
    return { table, ...version };
  }

  return {
    load,
    /** Asset ids whose bytes are held, least recently used first. */
    cached: () => [...cache.keys()],
    destroy() {
      stop.abort();
      cache.clear();
    },
  };
}

function forReader(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

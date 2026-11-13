// A Page's named sources, outside React: one store per Page session. Its
// input is the sources document alone (host-doc-replica.mjs), so a prose edit
// never reaches it.
//
// - `sources$`: the sources as a projection of the document, by id.
// - `versions(ids)`: `{ [id]: version | null }`, emitted on subscribe and
//   again only when one of those sources changes.
// - `resolve(binding)`: the version a binding reads now. `{ source_id }`
//   follows the source, `{ source_id, revision }` is pinned to one of its
//   history states, and `{ asset_id }` is pinned to that asset.
// - `resolver(decode)`: a resolver that loads a version's bytes through the
//   Page's one byte cache and decodes them with `decode`: Sift's loader for a
//   table, an Arrow decoder for a chart.
//
// A version is `{ source_id?, asset_id, media_type, revision }`. `revision`
// is the source revision it reads, or null for a pinned asset.
//
// A store made with `demand` asks for the sources document while a reader
// waits on a source it doesn't hold, so a Page whose sources document isn't
// open yet keeps looking for it (host-doc-replica.mjs demand). Nothing asks
// while every source read is there.
import { Observable, combineLatest, distinctUntilChanged, map } from "rxjs";
import { readSource } from "../model/sources-doc.mjs";
import { imageAssetUrl, validAssetId } from "../shared/image-assets.mjs";
import { PARQUET_MEDIA_TYPE } from "../shared/dataset-assets.mjs";
import { DATAFRAME_LIMITS, fetchDataset } from "./sift-dataset.mjs";
import { Store } from "./store.mjs";

const NO_SOURCES = Object.freeze({});

/**
 * Every readable source in a sources document, by id: `{ source_id, name,
 * asset_id, media_type, revision, pins }`, where `pins` maps each revision
 * the source's history holds to `{ asset_id, media_type }`. An entry the
 * host would refuse to read
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
      pins: Object.freeze(
        Object.fromEntries(
          source.history.map((state) => [
            state.revision,
            Object.freeze({ asset_id: state.asset_id, media_type: state.media_type }),
          ]),
        ),
      ),
    });
  }
  return Object.freeze(sources);
}

/**
 * What the Page knows about its sources document, from the document's
 * lookup state (host-doc-open-machine.mjs) and the Page's connection link
 * (sync-status-machine.mjs `link`, the one its status shows as Offline):
 * - `known`: the document is open, or the host or this build settled that
 *   there is none to read.
 * - `unreachable`: this tab's stored copy doesn't hold it (`closed` and
 *   `checked`) and the Page is offline, or lookups kept failing (`failed`).
 *   Only a connection reads it now.
 * - `unknown`: not looked up yet, a lookup is running, or a stored miss
 *   while the connection is still being made.
 */
export function sourcesAnswer(state, link) {
  switch (state?.name) {
    case "closed":
      return state.checked && link === "offline" ? "unreachable" : "unknown";
    case "opening":
    case "retrying":
      return "unknown";
    case "failed":
      return "unreachable";
    default:
      return "known";
  }
}

/** `sourcesAnswer` for the sources replica's `state$` and the session's
 * sync-status `sync$` states, on change only: what view-draw.mjs reads as
 * `sourcesAnswer$`. */
export const sourcesAnswer$ = (state$, sync$) =>
  combineLatest([state$, sync$]).pipe(
    map(([state, sync]) => sourcesAnswer(state, sync?.link)),
    distinctUntilChanged(),
  );

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

/** A binding that names nothing this store can read. `reason` is
 * `missing` (the Page holds no such source), `revision` (the source's
 * history holds no such revision), `invalid` (the binding names nothing) or
 * `closed`. */
export class SourceUnavailable extends Error {
  constructor(message, binding, reason = "invalid") {
    super(message);
    this.name = "SourceUnavailable";
    this.binding = binding;
    this.reason = reason;
  }
}

export class PageSourceStore {
  #sources = new Store(NO_SOURCES);
  #subscription;
  #bytes;
  #resolvers = new Map();
  #demand;
  #destroyed = false;
  /** The sources by id, deduplicated per source. */
  sources$ = this.#sources.state$.pipe(distinctUntilChanged(sameSources));

  /** `doc$` emits the sources document, or undefined while there is none.
   * `demand()` starts asking for it and returns the function that stops:
   * the store asks while a reader waits on a source it doesn't hold. */
  constructor({ pageId, doc$, request, maxEntries = 4, demand }) {
    if (typeof pageId !== "string" || !pageId) throw Error("A source store needs its Page id");
    this.pageId = pageId;
    this.request = request;
    this.maxEntries = maxEntries;
    this.#demand = demand;
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
   * changing, emits nothing. While the last emission holds a null, the
   * subscriber asks for the sources document (`demand`); it stops when every
   * source is there or it unsubscribes. */
  versions(ids) {
    const list = [...new Set(ids)];
    const versions$ = this.#sources.state$.pipe(
      map((sources) =>
        Object.fromEntries(list.map((id) => [id, Object.hasOwn(sources, id) ? sources[id] : null])),
      ),
      distinctUntilChanged((a, b) => list.every((id) => sameVersion(a[id], b[id]))),
    );
    return new Observable((subscriber) => {
      let stop = null;
      const settle = (waiting) => {
        if (waiting && !stop && !this.#destroyed && this.#demand) stop = this.#demand();
        else if (!waiting && stop) {
          stop();
          stop = null;
        }
      };
      const subscription = versions$.subscribe({
        next: (versions) => {
          settle(list.some((id) => versions[id] === null));
          subscriber.next(versions);
        },
        error: (error) => subscriber.error(error),
        complete: () => subscriber.complete(),
      });
      return () => {
        subscription.unsubscribe();
        settle(false);
      };
    });
  }

  /** The version a binding reads now. Throws SourceUnavailable for a source
   * the Page doesn't hold, a pinned revision its history doesn't hold, and
   * an invalid binding. */
  resolve(binding) {
    if (this.#destroyed)
      throw new SourceUnavailable("This Page's sources are closed.", binding, "closed");
    if (binding && typeof binding.source_id === "string") {
      const sources = this.#sources.snapshot();
      if (!Object.hasOwn(sources, binding.source_id)) {
        // One ask; a reader that keeps waiting holds demand through
        // versions().
        this.#demand?.()?.();
        throw new SourceUnavailable("This table's source isn't on this Page.", binding, "missing");
      }
      const source = sources[binding.source_id];
      if (binding.revision !== undefined) {
        const pin = Object.hasOwn(source.pins, binding.revision)
          ? source.pins[binding.revision]
          : undefined;
        if (!pin)
          throw new SourceUnavailable(
            "This source's history doesn't hold that revision.",
            binding,
            "revision",
          );
        return {
          source_id: source.source_id,
          asset_id: pin.asset_id,
          media_type: pin.media_type,
          revision: binding.revision,
        };
      }
      const { source_id, asset_id, media_type, revision } = source;
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
   * The resolver for `decode`, made on first use so the decoder stays in its
   * renderer's chunk: Sift's loadTableFile for a table, a chart's Arrow
   * decoder for a chart. Every resolver reads the Page's one byte cache. Its
   * `load(version, { signal })` returns `{ table, ...version }` for a version
   * from resolve() or versions(), where `table` is what `decode(bytes,
   * limits)` resolved with. The caller owns `table` and frees it
   * (`table.dispose?.()`), as Sift does when the table unmounts or a newer
   * version replaces it. A table decoded for a load whose signal aborted
   * first is freed here.
   */
  resolver(decode) {
    if (this.#destroyed) throw Error("This Page's sources are closed");
    this.#bytes ??= createByteCache({
      pageId: this.pageId,
      request: this.request,
      maxEntries: this.maxEntries,
    });
    let resolver = this.#resolvers.get(decode);
    if (!resolver) {
      resolver = createResolver(this.#bytes, decode);
      this.#resolvers.set(decode, resolver);
    }
    return resolver;
  }

  /** Stop following the document, cancel downloads and drop the byte cache.
   * The store then reads as a Page with no sources: snapshot() is empty,
   * resolve() throws SourceUnavailable, and each versions() subscriber gets
   * null for every id it follows. Subscriptions stay open and emit nothing
   * more; the caller ends its own. */
  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#subscription.unsubscribe();
    this.#bytes?.destroy();
    this.#bytes = undefined;
    this.#resolvers.clear();
    this.#sources.update(() => NO_SOURCES);
  }
}

/**
 * Bytes by asset id, shared by every table and chart on the Page: a
 * dataset's bytes never change for its id. At most `maxEntries` are kept,
 * least recently used first out.
 */
function createByteCache({ pageId, request, maxEntries }) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 16)
    throw Error("Invalid source cache size");
  const cache = new Map();
  const stop = new AbortController();
  return {
    signal: stop.signal,
    bytesOf(assetId) {
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
    },
    cached: () => [...cache.keys()],
    destroy() {
      stop.abort();
      cache.clear();
    },
  };
}

/** A resolver over `bytes` (createByteCache) that decodes with `decode`.
 * Each load decodes its own table, because a Sift table owns a mutable WASM
 * store. */
function createResolver(bytes, decode) {
  const stopped = () => new DOMException("Source load stopped", "AbortError");

  async function load(version, { signal } = {}) {
    if (bytes.signal.aborted) throw stopped();
    signal?.throwIfAborted();
    if (!version || !validAssetId(version.asset_id))
      throw new SourceUnavailable("This table names no dataset.", version);
    if (version.media_type !== PARQUET_MEDIA_TYPE)
      throw new SourceUnavailable(`This build can't show ${version.media_type}.`, version);
    // One reader's abort leaves the shared download running for the others.
    const held = await forReader(bytes.bytesOf(version.asset_id), signal);
    if (signal?.aborted || bytes.signal.aborted) throw stopped();
    const table = await decode(held.slice(), DATAFRAME_LIMITS);
    if (signal?.aborted || bytes.signal.aborted) {
      table?.dispose?.();
      throw stopped();
    }
    return { table, ...version };
  }

  return {
    load,
    /** Asset ids whose bytes are held, least recently used first. */
    cached: bytes.cached,
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

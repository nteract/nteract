// The open Page's named sources, outside React: one store per Page session,
// shared by every block editor on the Page. `versions(ids)` pushes what each
// source holds now to the charts and tables that follow it; `resolver()` is
// the one byte cache they share. Each consumer decodes and frees its own
// table (page-source-resolver.mjs).
import { Observable, distinctUntilChanged } from "rxjs";
import { resolvePageBinding } from "../model/page-sources.mjs";
import { parseAssetPath } from "../shared/dataset-assets.mjs";
import { createPageSourceResolver } from "./page-source-resolver.mjs";

/** `{ source_id, asset_id, source_revision }` for a source on `doc`, or null
 * when the Page has no such source (or no document yet). */
export function sourceVersion(doc, sourceId) {
  try {
    return resolvePageBinding(doc, { source_id: sourceId });
  } catch {
    return null;
  }
}

const sameVersion = (a, b) =>
  a?.asset_id === b?.asset_id && a?.source_revision === b?.source_revision;

/**
 * A store over a Page document. `read()` returns the current document and
 * `subscribe(onChange)` reports each change, returning its unsubscribe.
 * Returns:
 * - `versions(ids)`: an Observable of `{ [id]: version | null }`, emitted on
 *   subscribe and again only when one of those sources changes.
 * - `resolver(loadTableFile)`: the Page's resolver, made on first use so the
 *   decoder stays in the renderer's chunk. `resolveSource(binding)` takes
 *   `{ source_id }` or `{ asset_id }` and reads it from the document then.
 * - `destroy()`: stops downloads and empties the byte cache.
 */
export function pageSourceStore({ pageId, read, subscribe }) {
  let resolver = null;
  let destroyed = false;
  const current = (ids) => Object.fromEntries(ids.map((id) => [id, sourceVersion(read(), id)]));
  return {
    versions(ids) {
      return new Observable((subscriber) => {
        subscriber.next(current(ids));
        return subscribe(() => subscriber.next(current(ids)));
      }).pipe(distinctUntilChanged((a, b) => ids.every((id) => sameVersion(a[id], b[id]))));
    },
    resolver(loadTableFile) {
      if (destroyed) throw Error("This Page's sources are closed");
      resolver ??= createPageSourceResolver({
        pageId,
        readBinding: (binding) => resolvePageBinding(read(), binding),
        loadTableFile,
      });
      return resolver;
    },
    destroy() {
      destroyed = true;
      resolver?.destroy();
      resolver = null;
    },
  };
}

/** Record on `element` the version each source a view drew came from, as
 * `data-source-versions`: `{ [name]: { asset_id, source_revision } }`. A table
 * and a chart over one source show the same entry once both have drawn it. */
export function markSourceVersions(element, resolved) {
  const versions = {};
  for (const [name, { asset_id, source_revision = null }] of Object.entries(resolved))
    versions[name] = { asset_id, source_revision };
  element.dataset.sourceVersions = JSON.stringify(versions);
}

/** Where a chart's data name `name` reads from, as a resolver binding. A
 * `following` chart reads each name as a source ID. Otherwise every name
 * reads the node's `src`; a chart written over `source` shows only that
 * source there. */
export function chartBinding(name, { src, source, following }) {
  if (following) return { source_id: name };
  if (source && name !== source)
    throw Error(`Open the Page to see ${name}: this view shows only ${source}.`);
  const asset_id = parseAssetPath(src)?.assetId;
  if (!asset_id) throw Error("This chart's dataset isn't a Page asset.");
  return { asset_id };
}

const stores = new WeakMap();

/** The store for a Page session (session.mjs PageSession): one per session,
 * destroyed when the session closes. Null for a replica that reports no
 * changes, whose dataframes draw their `src`. */
export function pageSourcesFor(session, pageId) {
  if (typeof session?.subscribe !== "function") return null;
  let store = stores.get(session);
  if (store) return store;
  store = pageSourceStore({
    pageId,
    read: () => session.doc,
    subscribe: (onChange) => session.subscribe(onChange),
  });
  stores.set(session, store);
  const stop = session.subscribe(() => {
    if (session.alive !== false) return;
    stop();
    store.destroy();
  });
  return store;
}

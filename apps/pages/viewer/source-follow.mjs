// A table that follows a source: each version the Page's source store
// reports replaces the table, and the container records which version drew.
// The renderer (sift-table.jsx) supplies `render`; this module owns the
// subscription and the loads.

import { map, distinctUntilChanged } from "rxjs";
import { SourceUnavailable, sameVersion } from "./page-source-store.mjs";

/** The `data-*` attributes a followed table carries for the version it drew:
 * `sourceId`, `assetId` and `sourceRevision`. */
export function markDrawnVersion(element, version) {
  if (!element?.dataset) return;
  if (!version) {
    delete element.dataset.assetId;
    delete element.dataset.sourceRevision;
    return;
  }
  element.dataset.assetId = version.asset_id;
  element.dataset.sourceRevision = version.revision ?? "";
}

/** The key a version draws under: a new key replaces the table. */
export const versionKey = (version) =>
  version ? `${version.asset_id}:${version.revision ?? ""}` : "missing";

/**
 * Follow `binding.source_id` in `sources` (page-source-store.mjs). For each
 * version, including the one current on subscribe, calls `render(key, load,
 * version)`: `load()` resolves with that version's decoded table, which the
 * renderer then owns, and `version` null means the Page holds no such
 * source. `onDrawn(version)` runs when a version's table loaded.
 *
 * A version's load is aborted when a newer version replaces it or the
 * follow is destroyed; a table decoded after that is freed by the resolver.
 * Returns `{ destroy }`.
 */
export function followSource({ binding, sources, loadTableFile, render, onDrawn }) {
  const id = binding.source_id;
  const resolver = sources.resolver(loadTableFile);
  let current = null;
  const subscription = sources
    .versions([id])
    .pipe(
      map(() => {
        try {
          return sources.resolve(binding);
        } catch (error) {
          if (!(error instanceof SourceUnavailable)) throw error;
          return null;
        }
      }),
      distinctUntilChanged(sameVersion),
    )
    .subscribe((version) => {
      current?.abort();
      const controller = new AbortController();
      current = controller;
      const load = async () => {
        const loaded = await resolver.load(version, { signal: controller.signal });
        if (controller.signal.aborted) {
          loaded.table.dispose?.();
          throw new DOMException("Source load stopped", "AbortError");
        }
        onDrawn?.(version);
        return loaded.table;
      };
      render(versionKey(version), version ? load : null, version);
    });
  return {
    destroy() {
      subscription.unsubscribe();
      current?.abort();
      current = null;
    },
  };
}

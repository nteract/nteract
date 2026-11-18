// Read-only, Page-local inspection. Existing host-document replicas own all
// loading/retry state; this projection holds view demand only while inspected.
import {
  Observable,
  combineLatest,
  distinctUntilChanged,
  map,
  of,
  shareReplay,
  switchMap,
} from "rxjs";
import { nativeRead, readChildren, readKind } from "../model/native-read.mjs";
import * as A from "@automerge/automerge/slim";
import { orderedBlockIds } from "../model/order.mjs";
import { readSource } from "../model/sources-doc.mjs";
import { ANYWIDGET_MEDIA_TYPE } from "../shared/anywidget-view.mjs";
import { parseAssetPath } from "../shared/dataset-assets.mjs";
import { viewDependencies } from "../shared/view-dependencies.mjs";
import { sourcesAnswer } from "./page-source-store.mjs";
import { WIDGET_IMPORTS, localWidgetCatalog, widgetCatalogPin } from "./widget-imports.mjs";
import { Store } from "./store.mjs";

export function sourceMediaLabel(type) {
  return (
    {
      "application/vnd.apache.parquet": "Parquet",
      "text/javascript": "JavaScript",
      "text/css": "CSS",
      "audio/wav": "WAV audio",
      "application/octet-stream": "Binary",
      "application/vnd.vegalite.v6+json": "Vega-Lite chart",
      [ANYWIDGET_MEDIA_TYPE]: "Anywidget",
    }[type] ??
    type ??
    "Unknown type"
  );
}

export function sourceMatchesQuery(source, query) {
  const titles = source.kind === "attachment" ? source.uses.map((use) => use.title).join(" ") : "";
  return `${source.name} ${source.source_id} ${sourceMediaLabel(source.media_type)} ${titles}`
    .toLocaleLowerCase()
    .includes(query.toLocaleLowerCase());
}

/** Include every placement, including nested and offscreen nodes. Never use
 * the mounted DOM as the dependency inventory. Direct attachments remain
 * distinct from named sources, even when they currently share the same bytes. */
export function sourcePlacements(doc, cache = new WeakMap()) {
  const placements = [];
  let unreadableBlocks = 0;
  if (!doc) return { placements, unreadableBlocks };
  for (const blockId of orderedBlockIds(doc)) {
    try {
      const block = doc.blocks[blockId];
      const cached = cache.get(block);
      if (cached) {
        placements.push(...cached.placements);
        unreadableBlocks += cached.unreadable ? 1 : 0;
        continue;
      }
      const found = [];
      const ordinals = { dataframe: 0, view: 0 };
      let unreadable = false;
      const read = nativeRead(block, doc.page_id);
      const visit = (node) => {
        const kind = readKind(node);
        if (kind === "unknown") unreadable = true;
        if (kind === "dataframe" || kind === "view") {
          const attrs = node.param;
          const at = read.source.get(node);
          const ordinal = ordinals[kind]++;
          found.push({
            key:
              at == null ? `${blockId}:${kind}:${ordinal}` : A.getCursor(block, ["richText"], at),
            blockId,
            ordinal,
            kind,
            title: attrs.title,
            ...(kind === "view"
              ? { viewId: attrs.view_id }
              : { binding: attrs.binding, src: attrs.src, media_type: attrs.media_type }),
          });
        }
        for (const child of readChildren(node)) visit(child);
      };
      for (const node of read.nodes) visit(node);
      cache.set(block, { placements: found, unreadable });
      placements.push(...found);
      if (unreadable) unreadableBlocks++;
    } catch {
      unreadableBlocks++;
    }
  }
  return { placements, unreadableBlocks };
}

export function projectSourcesPanel(
  doc,
  placements,
  views,
  answer = "known",
  catalogEnabled = false,
) {
  const sources = new Map();
  let unreadableSources = 0;
  for (const id of Object.keys(doc?.sources ?? {})) {
    if (doc.sources[id]?.deleted) continue;
    try {
      sources.set(id, { ...readSource(doc, id), uses: [], availability: "available" });
    } catch {
      unreadableSources++;
      sources.set(id, { source_id: id, name: id, uses: [], availability: "unreadable" });
    }
  }
  const unresolvedViews = [];
  const add = (binding, use) => {
    if (!binding?.source_id) return;
    const id = binding.source_id;
    if (!sources.has(id))
      sources.set(id, { source_id: id, name: id, uses: [], availability: "missing" });
    sources.get(id).uses.push({ ...use, revision: binding.revision ?? null });
  };
  for (const placement of placements.placements) {
    if (placement.kind === "dataframe") {
      const asset = !placement.binding && parseAssetPath(placement.src);
      if (asset) {
        // This is a UI identity, never a source id sent to the host. Include the
        // original path so a foreign Page's attachment cannot alias a local one.
        const id = `asset:${placement.src}`;
        if (!sources.has(id))
          sources.set(id, {
            source_id: id,
            kind: "attachment",
            asset_id: asset.assetId,
            src: placement.src,
            name: placement.title || "Attached table",
            media_type: placement.media_type,
            availability: "available",
            uses: [],
          });
        sources.get(id).uses.push({
          ...placement,
          title: placement.title || "Table",
          type: "Table",
        });
        continue;
      }
      add(placement.binding, { ...placement, title: placement.title || "Table", type: "Table" });
      continue;
    }
    const state = views[placement.viewId];
    if (state?.status !== "ready") {
      unresolvedViews.push({ ...placement, status: state?.status ?? "pending" });
      continue;
    }
    const view = state.view;
    let dependencies;
    try {
      dependencies = viewDependencies(view);
    } catch {
      unresolvedViews.push({ ...placement, status: "unreadable" });
      continue;
    }
    if (
      catalogEnabled &&
      view.media_type === ANYWIDGET_MEDIA_TYPE &&
      widgetCatalogPin(sources.get(WIDGET_IMPORTS))
    ) {
      dependencies = [
        ...dependencies,
        { source: { source_id: WIDGET_IMPORTS }, role: "catalog", location: "Page imports" },
      ];
    }
    for (const { source, role, location } of dependencies) {
      add(source, {
        ...placement,
        key: `${placement.key}:${location}`,
        input: location.replace(/^(spec|data)\./, ""),
        role,
        location,
        title: view.title || placement.viewId,
        type: sourceMediaLabel(view.media_type),
      });
    }
  }
  return {
    sources: [...sources.values()].sort(
      (a, b) => a.name.localeCompare(b.name) || a.source_id.localeCompare(b.source_id),
    ),
    answer,
    unresolvedViews,
    unreadableSources,
    unreadableBlocks: placements.unreadableBlocks,
  };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const EMPTY = {
  sources: [],
  answer: "unknown",
  unresolvedViews: [],
  unreadableSources: 0,
  unreadableBlocks: 0,
};

export function sourcesPanelStore(session) {
  const store = new Store(EMPTY);
  return {
    store,
    start() {
      const cache = new WeakMap();
      const stopDemand = session.sources.demand();
      const placements$ = new Observable((subscriber) => {
        const publish = () => subscriber.next(session.hidden ? undefined : session.doc);
        const stop = session.subscribe(publish);
        publish();
        return stop;
      }).pipe(
        distinctUntilChanged(),
        map((doc) => sourcePlacements(doc, cache)),
        distinctUntilChanged(same),
        shareReplay({ bufferSize: 1, refCount: true }),
      );
      const views$ = placements$.pipe(
        map(({ placements }) =>
          [...new Set(placements.filter((p) => p.kind === "view").map((p) => p.viewId))].sort(),
        ),
        distinctUntilChanged(same),
        switchMap((ids) =>
          ids.length
            ? combineLatest(
                ids.map(
                  (id) =>
                    new Observable((subscriber) => {
                      const held = session.views.hold(id);
                      const subscription = held.view$.subscribe((state) =>
                        subscriber.next([
                          id,
                          state.status === "ready"
                            ? {
                                status: "ready",
                                view: {
                                  title: state.view.title,
                                  media_type: state.view.media_type,
                                  spec: state.view.spec,
                                  data: state.view.data,
                                  revision: state.view.revision,
                                },
                              }
                            : state,
                        ]),
                      );
                      return () => {
                        subscription.unsubscribe();
                        held.release();
                      };
                    }),
                ),
              ).pipe(map(Object.fromEntries))
            : of({}),
        ),
      );
      const subscription = combineLatest([
        session.sources.doc$,
        placements$,
        views$,
        session.sources.state$.state$,
        session.sync$.state$,
      ])
        .pipe(
          map(([doc, placements, views, state, sync]) =>
            projectSourcesPanel(
              doc,
              placements,
              views,
              state.name === "unreadable" || state.name === "unserved"
                ? state.name
                : sourcesAnswer(state, sync?.link),
              localWidgetCatalog(),
            ),
          ),
          distinctUntilChanged(same),
        )
        .subscribe((value) => store.update(() => value));
      return () => {
        subscription.unsubscribe();
        stopDemand();
        store.update(() => EMPTY);
      };
    },
  };
}

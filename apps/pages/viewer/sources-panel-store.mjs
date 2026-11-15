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
import { orderedBlockIds } from "../model/order.mjs";
import { readSource } from "../model/sources-doc.mjs";
import { sourcesAnswer } from "./page-source-store.mjs";
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
      "application/vnd.nteract.esm.v1+json": "Custom view",
      "application/vnd.nteract.anywidget.v1+json": "Anywidget",
    }[type] ??
    type ??
    "Unknown type"
  );
}

/** Include every placement, including nested and offscreen nodes. Never use
 * the mounted DOM as the dependency inventory. Direct-asset tables aren't
 * source consumers, even when their asset happens to match a named source. */
export function sourcePlacements(doc) {
  const placements = [];
  let unreadableBlocks = 0;
  if (!doc) return { placements, unreadableBlocks };
  for (const blockId of orderedBlockIds(doc)) {
    try {
      let ordinal = 0;
      const visit = (node) => {
        const kind = readKind(node);
        if (kind === "dataframe" || kind === "view") {
          const attrs = node.param;
          placements.push({
            key: `${blockId}:${ordinal++}`,
            blockId,
            kind,
            title: attrs.title,
            ...(kind === "view" ? { viewId: attrs.view_id } : { binding: attrs.binding }),
          });
        }
        for (const child of readChildren(node)) visit(child);
      };
      for (const node of nativeRead(doc.blocks[blockId], doc.page_id).nodes) visit(node);
    } catch {
      unreadableBlocks++;
    }
  }
  return { placements, unreadableBlocks };
}

export function projectSourcesPanel(doc, placements, views, answer = "known") {
  const sources = new Map();
  let unreadableSources = 0;
  for (const id of Object.keys(doc?.sources ?? {})) {
    if (doc.sources[id]?.deleted) continue;
    try {
      sources.set(id, { ...readSource(doc, id), uses: [], missing: false });
    } catch {
      unreadableSources++;
    }
  }
  const unresolvedViews = [];
  const add = (binding, use) => {
    if (!binding?.source_id) return;
    const id = binding.source_id;
    if (!sources.has(id)) sources.set(id, { source_id: id, name: id, uses: [], missing: true });
    sources.get(id).uses.push({ ...use, revision: binding.revision ?? null });
  };
  for (const placement of placements.placements) {
    if (placement.kind === "dataframe") {
      add(placement.binding, { ...placement, title: placement.title || "Table", type: "Table" });
      continue;
    }
    const state = views[placement.viewId];
    if (state?.status !== "ready") {
      unresolvedViews.push({ ...placement, status: state?.status ?? "pending" });
      continue;
    }
    const view = state.view;
    for (const [input, binding] of Object.entries(view.data)) {
      add(binding, {
        ...placement,
        key: `${placement.key}:${input}`,
        input,
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
      const stopDemand = session.sources.demand();
      const placements$ = new Observable((subscriber) => {
        const publish = () => subscriber.next(session.hidden ? undefined : session.doc);
        const stop = session.subscribe(publish);
        publish();
        return stop;
      }).pipe(
        distinctUntilChanged(),
        map(sourcePlacements),
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
                        subscriber.next([id, state]),
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
            projectSourcesPanel(doc, placements, views, sourcesAnswer(state, sync?.link)),
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

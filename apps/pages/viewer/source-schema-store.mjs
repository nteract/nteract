// The host's Parquet footer summary, fenced by the immutable asset being shown.
// A source change cancels the old read; no dataset bytes are downloaded here.
import { Observable, distinctUntilChanged, map, of, scan, switchMap } from "rxjs";
import { sameVersion } from "./page-source-store.mjs";
import { tool } from "./request.mjs";
import { Store } from "./store.mjs";

export const initialSchema = { name: "loading", version: null };
export function schemaTransition(state, event) {
  if (event.type === "missing") return { name: "unavailable", version: null };
  if (event.type === "load") return { name: "loading", version: event.version };
  if (state.name !== "loading" || state.version?.asset_id !== event.assetId) return state;
  if (event.type === "failed") return { ...state, name: "failed", message: event.message };
  if (event.type === "loaded") {
    if (event.source?.asset_id !== state.version.asset_id)
      return {
        ...state,
        name: "unavailable",
        message: "This source changed. Its schema will appear when the latest revision arrives.",
      };
    return event.source.summary
      ? { ...state, name: "ready", summary: event.source.summary }
      : { ...state, name: "unavailable" };
  }
  return state;
}

export function sourceSchemaStore(session, sourceId, read = tool) {
  const store = new Store(initialSchema);
  return {
    store,
    start() {
      const subscription = session.pageSources
        .versions([sourceId])
        .pipe(
          map((versions) => versions[sourceId]),
          distinctUntilChanged(sameVersion),
          switchMap((version) =>
            !version
              ? of({ type: "missing" })
              : new Observable((subscriber) => {
                  const controller = new AbortController();
                  subscriber.next({ type: "load", version });
                  read(
                    "read_page",
                    { page_id: session.pageId, source_id: sourceId },
                    { signal: controller.signal },
                  ).then(
                    (result) => {
                      subscriber.next({
                        type: "loaded",
                        assetId: version.asset_id,
                        source: result.source,
                      });
                      subscriber.complete();
                    },
                    (error) => {
                      subscriber.next({
                        type: "failed",
                        assetId: version.asset_id,
                        message: error.message || "Couldn't load the schema.",
                      });
                      subscriber.complete();
                    },
                  );
                  return () => controller.abort();
                }),
          ),
          scan(schemaTransition, initialSchema),
        )
        .subscribe((value) => store.update(() => value));
      return () => subscription.unsubscribe();
    },
  };
}

// Read-only previews of authenticated source bytes. Never import JavaScript or
// attach source CSS to the Page; both are rendered as text.
import { Observable, distinctUntilChanged, map, of, scan, switchMap } from "rxjs";
import { sameVersion } from "./page-source-store.mjs";
import { fetchOutputAsset } from "./output-assets.mjs";
import { Store } from "./store.mjs";

export const TEXT_PREVIEW_LIMIT = 16000;
export const SOURCE_PREVIEW_TYPES = [
  "application/json",
  "text/javascript",
  "text/css",
  "audio/wav",
  "application/octet-stream",
];
export const initialPreview = { name: "loading", version: null };
export function previewTransition(state, event) {
  if (event.type === "missing") return { name: "unavailable", version: null };
  if (event.type === "load") return { name: "loading", version: event.version };
  if (state.name !== "loading" || !state.version || state.version.asset_id !== event.assetId)
    return state;
  if (event.type === "failed") return { ...state, name: "failed", message: event.message };
  if (event.type === "loaded") return { ...state, name: "ready", preview: event.preview };
  return state;
}

export function previewOf({ bytes, mediaType }) {
  if (mediaType === "application/json") {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = JSON.parse(text);
    const describe = (item) => {
      if (Array.isArray(item)) return item.length === 1 ? "1 item" : `${item.length} items`;
      if (item === null) return "null";
      if (typeof item === "object") {
        const count = Object.keys(item).length;
        return count === 1 ? "1 field" : `${count} fields`;
      }
      return typeof item;
    };
    const keys =
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? Object.keys(value)
        : [];
    return {
      kind: "json",
      summary: describe(value),
      fields: keys.slice(0, 8).map((key) => [key, describe(value[key])]),
      more: Math.max(0, keys.length - 8),
      text: text.slice(0, TEXT_PREVIEW_LIMIT),
      truncated: text.length > TEXT_PREVIEW_LIMIT,
      size: bytes.byteLength,
    };
  }
  if (mediaType === "text/javascript" || mediaType === "text/css") {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return {
      kind: "text",
      text: text.slice(0, TEXT_PREVIEW_LIMIT),
      truncated: text.length > TEXT_PREVIEW_LIMIT,
      size: bytes.byteLength,
    };
  }
  if (mediaType === "audio/wav") return { kind: "audio", bytes, size: bytes.byteLength };
  return {
    kind: "binary",
    size: bytes.byteLength,
    hex: [...bytes.subarray(0, 64)].map((b) => b.toString(16).padStart(2, "0")).join(" "),
    truncated: bytes.byteLength > 64,
  };
}

export function sourcePreviewStore(session, sourceId, read = fetchOutputAsset) {
  const store = new Store(initialPreview);
  return {
    store,
    start() {
      const subscription = session.pageSources
        .versions([sourceId])
        .pipe(
          map((versions) => versions[sourceId]),
          distinctUntilChanged(sameVersion),
          switchMap((version) =>
            !version || !SOURCE_PREVIEW_TYPES.includes(version.media_type)
              ? of({ type: "missing" })
              : new Observable((subscriber) => {
                  const controller = new AbortController();
                  subscriber.next({ type: "load", version });
                  Promise.resolve()
                    .then(() => read(session.pageId, version, { signal: controller.signal }))
                    .then((asset) => {
                      if (controller.signal.aborted) return;
                      subscriber.next({
                        type: "loaded",
                        assetId: version.asset_id,
                        preview: previewOf(asset),
                      });
                      subscriber.complete();
                    })
                    .catch((error) => {
                      subscriber.next({
                        type: "failed",
                        assetId: version.asset_id,
                        message: error.message || "Couldn't load this source.",
                      });
                      subscriber.complete();
                    });
                  return () => controller.abort();
                }),
          ),
          scan(previewTransition, initialPreview),
        )
        .subscribe((value) => store.update(() => value));
      return () => {
        subscription.unsubscribe();
        store.update(() => initialPreview);
      };
    },
  };
}

// Read-only previews of authenticated source bytes. Never import JavaScript or
// attach source CSS to the Page; both are rendered as text.
import { Observable, distinctUntilChanged, map, of, scan, switchMap } from "rxjs";
import { csvHeaderProblem } from "./csv-header.mjs";
import { sameVersion } from "./page-source-store.mjs";
import { fetchOutputAsset } from "./output-assets.mjs";
import { Store } from "./store.mjs";

export const TEXT_PREVIEW_LIMIT = 16000;
// A CSV preview shows the header and at most this many rows and columns.
export const CSV_PREVIEW_ROWS = 20;
export const CSV_PREVIEW_COLUMNS = 12;
// A cell longer than this shows its start.
const CSV_PREVIEW_CELL = 200;
export const SOURCE_PREVIEW_TYPES = [
  "application/json",
  "text/csv",
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
  if (mediaType === "text/csv") return csvPreview(bytes);
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

/** The header and first rows of a comma-separated UTF-8 file, as text: the
 * values a reader sees in the file, not the types a view reads. The whole
 * file is walked once, so a quote left open or a row with another number of
 * fields than the header is a plain error rather than a partial table. A
 * header csv-header.mjs refuses is an error here too, as it is for views. */
function csvPreview(bytes) {
  const unreadable = (why) => Error(`This CSV can't be previewed: ${why}`);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw unreadable("it isn't UTF-8 text.");
  }
  if (text.startsWith("﻿")) text = text.slice(1);
  const records = [];
  let count = 0;
  let width = -1;
  let fields = [];
  let field = "";
  let quoted = false;
  let started = false;
  let line = 1;
  const endRecord = () => {
    fields.push(field);
    field = "";
    if (width === -1) {
      width = fields.length;
      const problem = csvHeaderProblem(fields);
      if (problem) throw unreadable(problem);
    } else if (fields.length !== width)
      throw unreadable(`row ${count} has ${fields.length} fields; the header has ${width}.`);
    if (records.length <= CSV_PREVIEW_ROWS)
      records.push(
        fields.slice(0, CSV_PREVIEW_COLUMNS).map((value) => value.slice(0, CSV_PREVIEW_CELL)),
      );
    count++;
    fields = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else {
        if (c === "\n") line++;
        field += c;
      }
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      fields.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      line++;
      // A blank line is no record, as the parser that views use reads it.
      if (started) endRecord();
      started = false;
      continue;
    } else field += c;
    started = true;
  }
  if (quoted) throw unreadable(`a quoted field opened before line ${line} never closes.`);
  if (started) endRecord();
  if (!count) throw unreadable("it has no header row.");
  const [header, ...rows] = records;
  return {
    kind: "csv",
    header,
    rows,
    moreRows: Math.max(0, count - 1 - rows.length),
    moreColumns: Math.max(0, width - CSV_PREVIEW_COLUMNS),
    size: bytes.byteLength,
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

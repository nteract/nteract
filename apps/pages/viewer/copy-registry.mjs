// What this browser copied out of a Page, so a paste can tell its own
// clipboard from anyone else's.
//
// Clipboard HTML is untrusted: any web page can put a Page's dataframe
// reference into what a person copies. A paste only moves a table's data
// when this browser put that table on the clipboard itself. On copy, the
// editor writes a copy record here (a random id, the Page and its title,
// the assets the copy holds) and marks the clipboard HTML with one hidden
// element holding the id. On paste, the id is the only field read from the
// clipboard: the Page, title and asset ids that count are the record's.
//
// The id leaves the browser with the clipboard, so a record shows that this
// browser copied a table, not that the person means to move its data into
// the Page they paste into. The paste asks first (dataframe-copy-machine.mjs).
//
// The record is versioned and keyed by kind (`assets` today) so later kinds
// of reference can join it. The registry keeps the newest COPY_LIMIT copies,
// each for COPY_TTL_MS. Without localStorage (a private window, storage
// blocked, or a throwing accessor) nothing is recorded or found, so nothing
// is copied.
import { validAssetId } from "../shared/image-assets.mjs";
import { DATAFRAME_ATTR, plainAttrs } from "../model/wordgard-doc.mjs";
import {
  assetPageId as validPageId,
  parseAssetPath,
  readDataframe,
} from "../shared/dataset-assets.mjs";

export const COPY_ATTR = "data-pages-copy";
export const COPY_FORMAT = 1;
export const COPY_LIMIT = 20;
// An hour covers copying in one tab and pasting in another; a shorter life
// leaves less time for a copy id that left the browser to come back.
export const COPY_TTL_MS = 60 * 60 * 1000;
/** The longest source Page title a record keeps. */
export const COPY_TITLE_MAX = 200;
const KEY = "pages.clipboard-copies.v1";
const COPY_ID = /^[0-9a-f]{32}$/;

const defaultStorage = () => globalThis.localStorage;

function readAll(storage, now) {
  try {
    const list = JSON.parse(storage()?.getItem(KEY) ?? "[]");
    if (!Array.isArray(list)) return [];
    return list.filter(
      (entry) =>
        entry &&
        COPY_ID.test(entry.id) &&
        validPageId(entry.page) &&
        Array.isArray(entry.assets) &&
        entry.assets.every(validAssetId) &&
        (entry.title === undefined || typeof entry.title === "string") &&
        Number.isSafeInteger(entry.at) &&
        entry.at <= now &&
        now - entry.at < COPY_TTL_MS,
    );
  } catch {
    return [];
  }
}

function randomId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

const recordTitle = (title) =>
  typeof title === "string"
    ? title.replace(/\s+/g, " ").trim().slice(0, COPY_TITLE_MAX) || undefined
    : undefined;

/** Record a copy of `assets` from `pageId`, titled `title` there. Returns
 * its id, or null when nothing could be recorded. */
export function recordCopy(
  { pageId, assets, title },
  { storage = defaultStorage, now = Date.now(), id = randomId() } = {},
) {
  if (!validPageId(pageId) || !assets.length || !assets.every(validAssetId)) return null;
  try {
    const store = storage();
    if (!store) return null;
    const entries = readAll(storage, now);
    const named = recordTitle(title);
    entries.push({
      id,
      page: pageId,
      assets: [...new Set(assets)],
      ...(named && { title: named }),
      at: now,
    });
    store.setItem(KEY, JSON.stringify(entries.slice(-COPY_LIMIT)));
    return id;
  } catch {
    return null;
  }
}

/** The live copy record for `id`: `{ id, page, assets, title }`, or null.
 * `title` is the source Page's title when it was copied, or null. */
export function lookupCopy(id, { storage = defaultStorage, now = Date.now() } = {}) {
  if (typeof id !== "string" || !COPY_ID.test(id)) return null;
  const entry = readAll(storage, now).find((item) => item.id === id);
  return entry
    ? {
        id: entry.id,
        page: entry.page,
        assets: entry.assets,
        title: recordTitle(entry.title) ?? null,
      }
    : null;
}

/** The marker element for copy `id`. Empty and hidden, so other apps paste
 * nothing from it. */
export const copyMarker = (id) =>
  `<span hidden ${COPY_ATTR}='${JSON.stringify({ v: COPY_FORMAT, id })}'></span>`;

/** The copy id a clipboard's HTML names, or null. Only `v` and `id` are
 * read, and the id only counts once lookupCopy finds it. */
export function clipboardCopyId(html, parser = new DOMParser()) {
  if (typeof html !== "string" || !html.includes(COPY_ATTR)) return null;
  const doc = parser.parseFromString(html, "text/html");
  for (const element of doc.querySelectorAll(`[${COPY_ATTR}]`)) {
    try {
      const value = JSON.parse(element.getAttribute(COPY_ATTR));
      if (value?.v === COPY_FORMAT && typeof value.id === "string" && COPY_ID.test(value.id))
        return value.id;
    } catch {}
  }
  return null;
}

/**
 * Outgoing clipboard HTML from `pageId`'s editor: when it holds dataframes
 * on this Page, record the copy, with the Page's `title` for the paste to
 * name, and append its marker. Anything else is returned unchanged.
 */
export function markCopiedHTML(html, pageId, { parser = new DOMParser(), title, ...options } = {}) {
  if (!html.includes(DATAFRAME_ATTR)) return html;
  const doc = parser.parseFromString(html, "text/html");
  const assets = [];
  let sourceBindings = false;
  for (const figure of doc.body.querySelectorAll(`figure[${DATAFRAME_ATTR}]`)) {
    let value = null;
    try {
      value = readDataframe(plainAttrs(JSON.parse(figure.getAttribute(DATAFRAME_ATTR))));
    } catch {}
    if (value?.binding) {
      figure.setAttribute("data-pages-source-page", pageId);
      sourceBindings = true;
    }
    const path = value && parseAssetPath(value.src);
    if (path?.pageId === pageId) assets.push(path.assetId);
  }
  if (sourceBindings) html = doc.body.innerHTML;
  if (!assets.length) return html;
  const id = recordCopy({ pageId, assets, title }, options);
  return id ? html + copyMarker(id) : html;
}

/** Remove copy markers from pasted HTML before it is read as content. */
export function stripCopyMarkers(doc) {
  let changed = false;
  for (const element of doc.querySelectorAll(`[${COPY_ATTR}]`)) {
    element.remove();
    changed = true;
  }
  return changed;
}

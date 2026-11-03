import * as A from "@automerge/automerge/slim";
import { history } from "wordgard/history";
import { GardSelection } from "wordgard/state";
import { PagesImage } from "./wordgard-model.mjs";
import { applyPageOperation } from "../model/page.mjs";
import { blockMarkdown } from "../model/richtext.mjs";
import {
  IMAGE_MAX_BYTES,
  IMAGE_MEDIA_TYPES,
  imageAssetUrl,
  validAssetId,
} from "../shared/image-assets.mjs";
import {
  DATASET_MAX_BYTES,
  PARQUET_MEDIA_TYPE,
  SIFT_LANGUAGE,
  isParquetFile,
  siftSource,
} from "../shared/dataset-assets.mjs";

export const IMAGE_ACCEPT = IMAGE_MEDIA_TYPES.join(",");
const pathFor = (id) => ["blocks", id, "richText"];
const unavailable = () =>
  Error("The insertion point changed. Choose where to add the image again.");

export function imageFiles(transfer) {
  const files = Array.from(transfer?.files ?? []);
  if (!files.length)
    for (const item of Array.from(transfer?.items ?? [])) {
      const file = item.kind === "file" && item.getAsFile();
      if (file) files.push(file);
    }
  return files.filter(
    (file) =>
      file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|svg|heic|avif)$/i.test(file.name),
  );
}

/** Files a Page body accepts from paste or drop: images, and Parquet
 * datasets, which land as a `sift` table. Comments take images only. */
export function uploadFiles(transfer) {
  const files = Array.from(transfer?.files ?? []);
  if (!files.length)
    for (const item of Array.from(transfer?.items ?? [])) {
      const file = item.kind === "file" && item.getAsFile();
      if (file) files.push(file);
    }
  const images = new Set(imageFiles({ files }));
  return files.filter((file) => images.has(file) || isParquetFile(file));
}

/** validateImageFile, or for a Parquet file, the dataset size limit. */
export function validateUploadFile(file) {
  if (!isParquetFile(file)) return validateImageFile(file);
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > DATASET_MAX_BYTES)
    throw Error("Choose a Parquet file smaller than 5 MiB.");
}

/** The checks the asset endpoint applies, run before uploading: a PNG, JPEG
 * or WebP under IMAGE_MAX_BYTES. Throws a message for people. */
export function validateImageFile(file) {
  if (
    !file ||
    (!IMAGE_MEDIA_TYPES.includes(file.type) &&
      !(
        ["", "application/octet-stream"].includes(file.type) &&
        /\.(png|jpe?g|webp)$/i.test(file.name)
      ))
  )
    throw Error("Choose a PNG, JPEG, or WebP image.");
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > IMAGE_MAX_BYTES)
    throw Error("Choose an image smaller than 5 MiB.");
}

/** A native position that sticks to the character before it: text typed at the
 * position lands after the anchor, so whatever is placed there later stays
 * where it was chosen. `null` stands for the start of the text.
 *
 * Offsets are UTF-16 units. The anchor is the first unit of the character
 * before, so an astral character (a surrogate pair) is never split. */
function anchorBefore(doc, path, offset) {
  if (offset <= 0) return null;
  const text = textAt(doc, path);
  const low = text.charCodeAt(offset - 1);
  const pair =
    offset >= 2 && low >= 0xdc00 && low <= 0xdfff && text.codePointAt(offset - 2) > 0xffff;
  return A.getCursor(doc, path, offset - (pair ? 2 : 1), "after");
}
/** The current offset just after an `anchorBefore` anchor's character, or
 * null once that character is gone. */
function resolveAnchor(doc, path, anchor) {
  if (anchor === null) return 0;
  try {
    const before = A.getCursorPosition(doc, path, anchor);
    if (A.getCursor(doc, path, before, "after") !== anchor) return null;
    const point = textAt(doc, path).codePointAt(before);
    return point === undefined ? null : before + (point > 0xffff ? 2 : 1);
  } catch {
    return null;
  }
}
const textAt = (doc, path) => doc.blocks[path[1]].richText;

/** Alt text for an uploaded file: its name without the extension. */
export const imageAlt = (file) =>
  String(file?.name ?? "Image")
    .replace(/\.[^.]+$/, "")
    .slice(0, 1024);

// Capture a native cursor before opening a picker or starting a network request.
// Screen coordinates and editor offsets are not stable while peers keep editing.
//
// The insertion point and the person's selection are both anchored to the
// character before them. Typing at the paste point then goes after the pending
// image, and the uploader can tell whether the selection moved while it waited.
export function captureImageInsertion(
  replica,
  id,
  editor,
  map,
  position = editor.state.selection.to,
) {
  const doc = replica.doc,
    pageId = replica.pageId ?? doc?.page_id,
    offset = map?.wgToAm[position],
    object = doc?.blocks?.[id] && A.getObjectId(doc.blocks[id], "richText");
  if (
    !pageId ||
    doc.page_id !== pageId ||
    replica.alive === false ||
    replica.canWrite === false ||
    editor.state.readOnly ||
    !object ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > doc.blocks[id].richText.length
  )
    throw unavailable();
  const path = pathFor(id),
    { anchor, head } = editor.state.selection,
    native = (pos) => {
      const at = map.wgToAm[pos];
      return Number.isSafeInteger(at) ? anchorBefore(doc, path, at) : undefined;
    };
  return {
    pageId,
    id,
    object,
    anchor: anchorBefore(doc, path, offset),
    selection: { anchor: native(anchor), head: native(head) },
  };
}

function resolvePosition(doc, target, anchor, map) {
  const offset = resolveAnchor(doc, pathFor(target.id), anchor);
  if (offset === null) return null;
  const position = map?.amToWg[offset];
  return Number.isSafeInteger(position) ? position : null;
}

export function resolveImageInsertion(replica, target, map) {
  const doc = replica.doc,
    block = doc?.blocks?.[target.id];
  if (
    replica.alive === false ||
    replica.canWrite === false ||
    (replica.pageId ?? doc?.page_id) !== target.pageId ||
    doc?.page_id !== target.pageId ||
    !block ||
    A.getObjectId(block, "richText") !== target.object
  )
    throw unavailable();
  const position = resolvePosition(doc, target, target.anchor, map);
  if (position === null) throw unavailable();
  return position;
}

/** Where the caret goes once a pending image is inserted at `position`.
 *
 * If the person's selection is where it was when they pasted, dropped or
 * picked the image, the caret moves to just after the image, so the next
 * keystroke follows it. If they typed or moved the caret while it uploaded,
 * the selection is theirs: return null and let the editor map it through the
 * insertion. */
export function caretAfterImage(replica, target, map, selection, position) {
  const captured = target.selection;
  if (captured?.anchor === undefined || captured?.head === undefined) return null;
  const doc = replica.doc,
    anchor = resolvePosition(doc, target, captured.anchor, map),
    head = resolvePosition(doc, target, captured.head, map);
  if (anchor === null || anchor !== selection.anchor || head !== selection.head) return null;
  return (_cx, changes) => GardSelection.cursor(changes.mapPos(position, 1));
}

export async function uploadPageImage(pageId, file, signal, request = fetch) {
  const dataset = isParquetFile(file);
  const response = await request(`/api/pages/${encodeURIComponent(pageId)}/assets`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": dataset ? PARQUET_MEDIA_TYPE : file.type || "application/octet-stream",
    },
    body: file,
    signal,
  });
  const result = await response.json();
  if (!response.ok)
    throw Error(
      result.error?.message ?? result.error ?? `Image upload failed (${response.status}).`,
    );
  const assetId = result.asset_id;
  if (
    !validAssetId(assetId) ||
    result.url !== imageAssetUrl(pageId, assetId) ||
    (dataset
      ? result.mime_type !== PARQUET_MEDIA_TYPE
      : !IMAGE_MEDIA_TYPES.includes(result.mime_type))
  )
    throw Error("The server returned an invalid image reference.");
  return result;
}

/** The image leaf an uploaded image inserts at the captured cursor.
 * `count(replica, id)` reports how many copies the block holds, so the
 * uploader can confirm its one insertion landed. */
function imageInsertion(file, asset) {
  const alt = imageAlt(file);
  return {
    node: PagesImage.of({ src: asset.url, alt, title: null }),
    count: (replica, id) =>
      A.spans(replica.doc, pathFor(id)).filter(
        (span) =>
          span.type === "block" &&
          String(span.value.type) === "image" &&
          String(span.value.attrs.src) === asset.url,
      ).length,
  };
}

/**
 * A dataset lands as its own Page block after the block it was dropped on,
 * holding one `sift` fence, the same shape an agent's insert_markdown makes.
 * A new block opens in a fresh editor. Inserting the fence inline instead
 * makes Wordgard 0.6.2 map the rendered table's shape at the insertion
 * boundary to a position past the end of the document, which throws in this
 * editor and in every peer's. Returns the new block's ID.
 */
function insertDatasetBlock(replica, afterBlockId, markdown) {
  let id = null;
  replica.change((doc) => {
    const before = new Set(Object.keys(doc.blocks ?? {}));
    applyPageOperation(doc, {
      operation: "edit_page",
      arguments: {
        operations: [{ op: "insert_markdown", after_block_id: afterBlockId, markdown }],
      },
    });
    id = Object.keys(doc.blocks).find((key) => !before.has(key)) ?? null;
  });
  if (!id || blockMarkdown(replica.doc.blocks[id]) !== markdown)
    throw Error("The dataset uploaded but wasn't inserted. Drop it again.");
  return id;
}

// The pending File and retry state stay local. Only the completed, stable asset
// reference enters the document: an image through the same undoable
// transaction as typing, a dataset as a new block (insertDatasetBlock).
export function createImageUploader({
  replica,
  getEditor,
  getMap,
  isCurrent,
  onState,
  upload = uploadPageImage,
}) {
  let alive = true,
    job = null,
    abort = null;
  const current = () =>
    alive && isCurrent() && replica.alive !== false && replica.canWrite !== false;
  // A data: URL of the chosen file shows it at the insertion point while it
  // uploads (the page CSP allows data: images, not blob:). Dropped when the
  // job ends; the page then shows the stored asset.
  const release = (attempt) => {
    if (attempt) attempt.preview = null;
  };
  const uploading = (file) => (isParquetFile(file) ? "Uploading dataset…" : "Uploading image…");
  const readPreview = (attempt) => {
    if (typeof FileReader !== "function" || isParquetFile(attempt.file)) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (job !== attempt || !abort || typeof reader.result !== "string") return;
      attempt.preview = reader.result;
      onState({
        pending: true,
        message: uploading(attempt.file),
        retryable: false,
        target: attempt.target,
        preview: attempt.preview,
        name: String(attempt.file?.name ?? ""),
      });
    };
    reader.readAsDataURL(attempt.file);
  };
  const cancel = () => {
    abort?.abort();
    abort = null;
    release(job);
    job = null;
    if (alive) onState(null);
  };
  async function run(attempt) {
    if (!current() || job !== attempt) return;
    const controller = new AbortController();
    abort = controller;
    onState({
      pending: true,
      message: uploading(attempt.file),
      retryable: false,
      target: attempt.target,
      preview: attempt.preview ?? null,
      name: String(attempt.file?.name ?? ""),
    });
    try {
      validateUploadFile(attempt.file);
      resolveImageInsertion(replica, attempt.target, getMap());
      const asset = await upload(attempt.target.pageId, attempt.file, controller.signal);
      if (controller.signal.aborted || !current() || job !== attempt) return;
      attempt.asset = asset;
      const editor = getEditor();
      if (!editor || editor.state.readOnly) throw unavailable();
      const position = resolveImageInsertion(replica, attempt.target, getMap());
      if (isParquetFile(attempt.file)) {
        const source = siftSource({ src: asset.url, title: imageAlt(attempt.file) });
        insertDatasetBlock(
          replica,
          attempt.target.id,
          "```" + SIFT_LANGUAGE + "\n" + source + "\n```",
        );
      } else {
        const insertion = imageInsertion(attempt.file, asset);
        const count = () => insertion.count(replica, attempt.target.id);
        const before = count();
        editor.dispatch({
          changes: { from: position, insert: [insertion.node], fit: true },
          selection:
            caretAfterImage(replica, attempt.target, getMap(), editor.state.selection, position) ??
            undefined,
          userEvent: "input.image",
          annotations: history.isolate.of(true),
        });
        // The editor reports rejected canonical writes through its exception sink.
        // Do not silently clear upload status if that transaction was rolled back.
        if (count() !== before + 1)
          throw Error("The image uploaded but wasn't inserted. Choose its position again.");
      }
      job = null;
      abort = null;
      onState(null);
      release(attempt);
    } catch (error) {
      if (controller.signal.aborted || !alive || job !== attempt) return;
      // Once dispatch may have run, require a new placement rather than risking
      // a duplicate insertion after an ambiguous editor failure.
      let retryable = current() && !attempt.asset;
      try {
        validateUploadFile(attempt.file);
        resolveImageInsertion(replica, attempt.target, getMap());
      } catch {
        retryable = false;
      }
      abort = null;
      onState({
        pending: false,
        message: String(error?.message ?? "Image upload failed.").slice(0, 240),
        retryable,
      });
    }
  }
  return {
    start(files, target) {
      if (!current()) return;
      if (abort) return;
      if (files.length !== 1) {
        job = null;
        onState({ pending: false, message: "Add one file at a time.", retryable: false });
        return;
      }
      release(job);
      job = { file: files[0], target, preview: null };
      const running = run(job);
      try {
        validateUploadFile(files[0]);
        readPreview(job);
      } catch {}
      return running;
    },
    retry() {
      if (job && !job.asset && !abort) return run(job);
    },
    cancel,
    destroy() {
      alive = false;
      cancel();
    },
  };
}

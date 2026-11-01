import * as A from "@automerge/automerge/slim";
import { history } from "wordgard/history";
import { PagesImage } from "./wordgard-model.mjs";
import {
  IMAGE_MAX_BYTES,
  IMAGE_MEDIA_TYPES,
  imageAssetUrl,
  validAssetId,
} from "../shared/image-assets.mjs";

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

/** Alt text for an uploaded file: its name without the extension. */
export const imageAlt = (file) =>
  String(file?.name ?? "Image")
    .replace(/\.[^.]+$/, "")
    .slice(0, 1024);

// Capture a native cursor before opening a picker or starting a network request.
// Screen coordinates and editor offsets are not stable while peers keep editing.
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
  return { pageId, id, object, cursor: A.getCursor(doc, pathFor(id), offset, "after") };
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
  const offset = A.getCursorPosition(doc, pathFor(target.id), target.cursor),
    position = map?.amToWg[offset];
  if (
    A.getCursor(doc, pathFor(target.id), offset, "after") !== target.cursor ||
    !Number.isSafeInteger(position)
  )
    throw unavailable();
  return position;
}

export async function uploadPageImage(pageId, file, signal, request = fetch) {
  const response = await request(`/api/pages/${encodeURIComponent(pageId)}/assets`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": file.type || "application/octet-stream" },
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
    !IMAGE_MEDIA_TYPES.includes(result.mime_type)
  )
    throw Error("The server returned an invalid image reference.");
  return result;
}

// The pending File and retry state stay local. Only the completed, stable asset
// reference enters the document, through the same undoable transaction as typing.
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
  const readPreview = (attempt) => {
    if (typeof FileReader !== "function") return;
    const reader = new FileReader();
    reader.onload = () => {
      if (job !== attempt || !abort || typeof reader.result !== "string") return;
      attempt.preview = reader.result;
      onState({
        pending: true,
        message: "Uploading image…",
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
      message: "Uploading image…",
      retryable: false,
      target: attempt.target,
      preview: attempt.preview ?? null,
      name: String(attempt.file?.name ?? ""),
    });
    try {
      validateImageFile(attempt.file);
      resolveImageInsertion(replica, attempt.target, getMap());
      const asset = await upload(attempt.target.pageId, attempt.file, controller.signal);
      if (controller.signal.aborted || !current() || job !== attempt) return;
      attempt.asset = asset;
      const editor = getEditor();
      if (!editor || editor.state.readOnly) throw unavailable();
      const position = resolveImageInsertion(replica, attempt.target, getMap());
      const alt = imageAlt(attempt.file);
      const count = () =>
        A.spans(replica.doc, pathFor(attempt.target.id)).filter(
          (span) =>
            span.type === "block" &&
            String(span.value.type) === "image" &&
            String(span.value.attrs.src) === asset.url,
        ).length;
      const before = count();
      editor.dispatch({
        changes: {
          from: position,
          insert: [PagesImage.of({ src: asset.url, alt, title: null })],
          fit: true,
        },
        userEvent: "input.image",
        annotations: history.isolate.of(true),
      });
      // The editor reports rejected canonical writes through its exception sink.
      // Do not silently clear upload status if that transaction was rolled back.
      if (count() !== before + 1)
        throw Error("The image uploaded but wasn't inserted. Choose its position again.");
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
        validateImageFile(attempt.file);
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
        onState({ pending: false, message: "Add one image at a time.", retryable: false });
        return;
      }
      release(job);
      job = { file: files[0], target, preview: null };
      const running = run(job);
      try {
        validateImageFile(files[0]);
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

// Interprets comment-image-machine.mjs for a comment composer.
//
// The File and its AbortController stay here, keyed by token; the machine
// sees only tokens. The composer owns the editor: it places the preview when
// an upload starts and inserts the asset when asked.
//
// An uploading image is an unsent draft to the reload gate, even when the
// draft text is still empty: a reload would lose it. Each uploader holds its
// own draft source and reports `uploading` through it after every step, from
// paste or drop until insertion, failure or cancel.
import { commentImageMachine } from "./comment-image-machine.mjs";
import { imageAlt, imageFiles, uploadPageImage, validateImageFile } from "./image-upload.mjs";
import { reloadGate } from "./build-freshness.mjs";

export { imageFiles };

/** Shown when this replica can't upload. Uploads need edit access, so a
 * commenter comments in text. */
export const NEEDS_EDIT_ACCESS = "You need edit access to add images.";
export const ONE_AT_A_TIME = "Add one image at a time.";

/**
 * - upload(file, signal): resolves to the asset (`{ url, ... }`). Defaults to
 *   the Page's asset endpoint for `pageId`.
 * - insert(asset, alt): put the asset where the preview is. Throws when the
 *   insertion point is gone.
 * - onState(state): the machine state after each step.
 * - drafts: the reload gate's draft sources (`watchDrafts()`).
 */
export function createCommentImageUploader({
  pageId,
  upload = (file, signal) => uploadPageImage(pageId, file, signal),
  insert,
  onState = () => {},
  drafts = reloadGate,
}) {
  const draft = drafts.watchDrafts();
  let state = commentImageMachine.initial,
    next = 0,
    alive = true;
  const jobs = new Map();
  function step(event) {
    if (!alive) return { state, effects: [], rejected: "closed" };
    const result = commentImageMachine.step(state, event);
    if (result.rejected) return result;
    state = result.state;
    draft.set(state.name === "uploading");
    for (const effect of result.effects) run(effect);
    onState(state);
    return result;
  }
  function run({ type, token }) {
    const job = jobs.get(token);
    if (type === "upload") {
      job.controller = new AbortController();
      Promise.resolve()
        .then(() => upload(job.file, job.controller.signal))
        .then(
          (asset) => {
            job.asset = asset;
            step({ type: "uploaded", token });
          },
          (error) =>
            step({
              type: "failed",
              token,
              message: String(error?.message || "Image upload failed.").slice(0, 240),
            }),
        )
        .finally(() => {
          if (!job.asset) jobs.delete(token);
        });
    } else if (type === "abort") {
      job?.controller?.abort();
      jobs.delete(token);
    } else if (type === "insert") {
      jobs.delete(token);
      try {
        insert(job.asset, imageAlt(job.file));
      } catch (error) {
        step({ type: "problem", message: String(error?.message || "The image wasn't added.") });
      }
    }
  }
  return {
    get state() {
      return state;
    },
    /** Paste or drop: `files` from imageFiles. Returns whether the image
     * files were handled; false lets the editor paste whatever else it got. */
    accept(files, { canUpload = true } = {}) {
      if (!files.length) return false;
      if (state.name === "uploading") return true;
      if (!canUpload) return !step({ type: "problem", message: NEEDS_EDIT_ACCESS }).rejected;
      if (files.length !== 1) return !step({ type: "problem", message: ONE_AT_A_TIME }).rejected;
      try {
        validateImageFile(files[0]);
      } catch (error) {
        step({ type: "problem", message: error.message });
        return true;
      }
      const token = ++next;
      jobs.set(token, { file: files[0] });
      step({ type: "start", token });
      return true;
    },
    cancel() {
      return step({ type: "cancel" });
    },
    destroy() {
      if (state.name === "uploading") step({ type: "cancel" });
      alive = false;
      draft.stop();
    },
  };
}

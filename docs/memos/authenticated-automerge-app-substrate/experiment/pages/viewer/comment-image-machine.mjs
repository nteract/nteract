/**
 * An image pasted or dropped into a comment composer, as a state machine.
 *
 * A comment draft is local until Send, so the image takes the Page's upload
 * path (uploadPageImage: the same asset endpoint and checks as Page images)
 * and only the finished asset reference enters the draft. One image uploads
 * at a time.
 *
 * States:
 * - idle: nothing uploading and nothing to report.
 * - uploading: `token`'s file is on its way to the asset endpoint. The draft
 *   shows its preview at the insertion point, and Send waits.
 * - failed: the last image didn't make it into the draft. `message` says why
 *   until the next image, a draft edit, or Cancel.
 *
 * Events:
 * - start: an image passed the local checks and starts uploading as `token`.
 * - uploaded / failed: `token`'s upload settled. Any other token belongs to
 *   an upload that was cancelled, so its result is ignored.
 * - problem: the image can't be added: a local check refused it, or the
 *   insertion point was gone when the upload finished.
 * - cancel: Cancel on the preview, a draft edit while a failure shows, or
 *   the composer closing.
 *
 * Effects: `upload` sends `token`'s file; `abort` stops it; `insert` puts its
 * asset into the draft where the preview was.
 */
import { defineMachine, reject } from "../shared/machine.mjs";

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const only = (value, keys) => {
  for (const key of Object.keys(value)) check(keys.includes(key), `unexpected field ${key}`);
};
const token = (value) =>
  check(Number.isSafeInteger(value.token) && value.token > 0, "token must be a positive integer");
const message = (value) =>
  check(typeof value.message === "string" && value.message !== "", "message is required");
const shape =
  (head, keys, ...checks) =>
  (value) => {
    only(value, [head, ...keys]);
    for (const fn of checks) fn(value);
  };

export const commentImageSpec = Object.freeze({
  name: "comment-image",
  states: ["idle", "uploading", "failed"],
  events: ["start", "uploaded", "failed", "problem", "cancel"],
  cases: {
    "uploading/uploaded": ["current", "stale"],
    "uploading/failed": ["current", "stale"],
  },
  validate: {
    states: {
      idle: shape("name", []),
      uploading: shape("name", ["token"], token),
      failed: shape("name", ["message"], message),
    },
    events: {
      start: shape("type", ["token"], token),
      uploaded: shape("type", ["token"], token),
      failed: shape("type", ["token", "message"], token, message),
      problem: shape("type", ["message"], message),
      cancel: shape("type", []),
    },
    effects: {
      upload: shape("type", ["token"], token),
      abort: shape("type", ["token"], token),
      insert: shape("type", ["token"], token),
    },
  },
});

export const REJECT = Object.freeze({
  busy: "An image is already uploading",
  stale: "The upload was cancelled",
  idle: "Nothing to cancel",
});

const ok = (state, effects = []) => ({ state, effects });

function transition(state, event) {
  switch (event.type) {
    case "start":
      if (state.name === "uploading") return reject(state, REJECT.busy);
      return ok({ name: "uploading", token: event.token }, [
        { type: "upload", token: event.token },
      ]);
    case "uploaded":
      if (state.name !== "uploading" || state.token !== event.token)
        return reject(state, REJECT.stale);
      return ok({ name: "idle" }, [{ type: "insert", token: event.token }]);
    case "failed":
      if (state.name !== "uploading" || state.token !== event.token)
        return reject(state, REJECT.stale);
      return ok({ name: "failed", message: event.message });
    case "problem":
      // A second image while one uploads waits its turn, like the Page.
      if (state.name === "uploading") return reject(state, REJECT.busy);
      return ok({ name: "failed", message: event.message });
    case "cancel":
      if (state.name === "idle") return reject(state, REJECT.idle);
      return ok(
        { name: "idle" },
        state.name === "uploading" ? [{ type: "abort", token: state.token }] : [],
      );
  }
  throw new Error(`unknown event ${event.type}`);
}

export const commentImageMachine = defineMachine({
  ...commentImageSpec,
  initial: { name: "idle" },
  transition,
});

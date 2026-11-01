import * as A from "@automerge/automerge/slim";
import { captureSelectionTarget, resolvedCommentTarget, selectionContext } from "./comments.mjs";

const fail = (status, message, code, details) => {
  throw Object.assign(Error(message), {
    status,
    ...(code && { code }),
    ...(details && { details }),
  });
};
const headsShape = (heads) =>
  Array.isArray(heads) &&
  heads.length > 0 &&
  heads.length <= 128 &&
  heads.every((head) => typeof head === "string" && /^[a-f0-9]{64}$/.test(head));
const sameHeads = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

/** Revision guard for a new comment intent against one captured snapshot.
 *
 * Replies, status changes, edits and deletions touch only the comment thread,
 * never block text, so they ignore base_heads; applyComment still requires the
 * thread and message to exist. A block comment needs only its block to exist.
 * A passage comment is located at base_heads, the revision the caller read,
 * and its cursors must still resolve in the current snapshot.
 *
 * The caller must build its edit from this same snapshot without awaiting.
 * Receipt replay never calls this: an exact retry returns its recorded result.
 */
export function guardCommentIntent(current, operation, args) {
  const action = operation === "reply_page_comment" ? "reply" : (args.action ?? "add");
  if (action !== "add") {
    if (args.base_heads !== undefined && !headsShape(args.base_heads))
      fail(
        400,
        "base_heads must contain 1 to 128 revision hashes from a Page read",
        "invalid_edit_selector",
      );
    return args;
  }
  if (!headsShape(args.base_heads))
    fail(400, "base_heads from read_page are required", "invalid_edit_selector");
  if (!args.selected_text) return args;
  const currentHeads = A.getHeads(current);
  if (!A.hasHeads(current, args.base_heads))
    fail(409, "The base revision is unavailable; read the Page again", "resync_required", {
      current_heads: currentHeads,
    });
  const exact = sameHeads(args.base_heads, currentHeads);
  // Pin an owned backend to the historical snapshot, then re-view it. See
  // guardPassageEdits: path helpers on a plain view can read latest state.
  const owned = exact ? null : A.clone(A.view(current, args.base_heads));
  try {
    const base = owned ? A.view(owned, A.getHeads(owned)) : current;
    let target;
    try {
      target = captureSelectionTarget(
        base,
        args.block_id,
        String(args.selected_text),
        args.occurrence ?? 1,
      );
    } catch (error) {
      fail(400, error.message, "invalid_comment_selector");
    }
    if (selectionContext(current, target)?.status !== "attached")
      fail(
        409,
        "The selected passage changed; read changes before commenting again",
        "edit_conflict",
        {
          current_heads: currentHeads,
          conflicts: [{ block_id: args.block_id, reason: "target_detached" }],
        },
      );
    return { ...args, [resolvedCommentTarget]: target };
  } finally {
    if (owned) A.free(owned);
  }
}

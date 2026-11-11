import * as A from "@automerge/automerge/slim";
import {
  captureSelectionTarget,
  resolvedCommentTarget,
  selectionContext,
  threadBatch,
} from "./comments.mjs";
import { addressIndex, resolveAddressFor } from "./addresses.mjs";

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

/** Whether a comment write is a comment on selected text: the one comment
 * write that names a Page revision, to find its text. */
export const passageComment = (operation, args) =>
  operation !== "reply_page_comment" && (args?.action ?? "add") === "add" && !!args?.selected_text;

/** Where a new comment's node_id points in `doc`: its block's key, and the
 * node's text range when it names a node. A comment on a block names the
 * block's id; a node's id scopes selected_text to that node. */
function commentTarget(doc, args, kinds) {
  try {
    const target = resolveAddressFor(addressIndex(doc), doc, args.node_id, {
      op: "manage_page_comment",
      field: "node_id",
      kinds,
    });
    return {
      key: target.key,
      within: target.kind === "node" ? { start: target.start, end: target.end } : undefined,
    };
  } catch (error) {
    fail(400, error.message, error.code ?? "invalid_comment_selector");
  }
}

/** Revision guard for a new comment intent against one captured snapshot of
 * the Page document, and the agent edge for its address: the intent it
 * returns names the block by its key, as the comments document stores it.
 * Comments live in their own document, so only a passage comment depends on
 * the Page text the caller read.
 *
 * Replies, status changes, edits and deletions touch only the comments
 * document and name no revision; applyComment still requires the thread and
 * message to exist. A block comment needs only its block to exist, and names
 * none either. A passage comment (`add` with `selected_text`) is located at
 * `baseHeads`, the heads of the revision the caller read (the host resolves
 * its handle), and its cursors must still resolve in the current snapshot.
 *
 * The caller must build its edit from this same snapshot without awaiting.
 * Receipt replay never calls this: an exact retry returns its recorded result.
 */
export function guardCommentIntent(current, operation, args, baseHeads) {
  const action = operation === "reply_page_comment" ? "reply" : (args.action ?? "add");
  // A malformed thread_ids batch fails before prepare or any thread lookup.
  threadBatch(args, action);
  if (action !== "add") return args;
  const { node_id: _address, ...intent } = args;
  if (!passageComment(operation, args))
    return { ...intent, block_id: commentTarget(current, args, ["block"]).key };
  if (!headsShape(baseHeads))
    fail(400, "revision from read_page is required for a passage comment", "invalid_revision");
  const currentHeads = A.getHeads(current);
  if (!A.hasHeads(current, baseHeads))
    fail(409, "The base revision is unavailable; read the Page again", "resync_required", {
      current_heads: currentHeads,
    });
  const exact = sameHeads(baseHeads, currentHeads);
  // Pin an owned backend to the historical snapshot, then re-view it. See
  // guardPassageEdits: path helpers on a plain view can read latest state.
  const owned = exact ? null : A.clone(A.view(current, baseHeads));
  try {
    const base = owned ? A.view(owned, A.getHeads(owned)) : current;
    const { key, within } = commentTarget(base, args, ["block", "node"]);
    let target;
    try {
      target = captureSelectionTarget(
        base,
        key,
        String(args.selected_text),
        args.occurrence ?? 1,
        within,
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
          conflicts: [{ node_id: args.node_id, reason: "target_detached" }],
        },
      );
    return { ...intent, block_id: key, [resolvedCommentTarget]: target };
  } finally {
    if (owned) A.free(owned);
  }
}

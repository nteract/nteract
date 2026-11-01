import * as A from "@automerge/automerge/slim";

/** A Page's comments live in their own Automerge document, owned by the Page
 * Durable Object and synced beside the Page document on the same socket. Its
 * shape:
 *
 * ```
 * {
 *   threads: {
 *     [threadId]: {
 *       target: CommentAnchor,     // Automerge cursors into the Page document
 *       author: { principal, displayName, driver },
 *       createdAt: ISO string,
 *       status: { value: "open" | "resolved", at: ISO string },
 *       messages: {
 *         [messageId]: {
 *           body: text,            // literal source; frozen once richText exists
 *           format?: "automerge-rich-text-v1",
 *           richText?: rich text,  // native spans, the Page's mark registry
 *           author: { principal, displayName, driver },
 *           createdAt: ISO string,
 *           deletedAt: null | ISO string,   // soft delete
 *         },
 *       },
 *     },
 *   },
 *   schema?: { features: [...] },  // the stamp rich comment content needs
 * }
 * ```
 *
 * A thread is the shape a thread had inside the Page document, unchanged, so
 * the migration copies it whole and every reader projects it the same way.
 * `CommentAnchor` is `{ kind: "block", blockId }` or `{ kind: "selection",
 * anchor: Endpoint, head: Endpoint }` with `Endpoint = { blockId,
 * textObjectId, relativePositionBase64 }`. Anchors resolve against the Page
 * document; the comments document never names a host or an origin.
 *
 * `author.principal` is the authenticated account. `displayName` and `driver`
 * are labels the writer supplies; they never authorize anything.
 * comment-authority.mjs holds the per-author rules every incoming change from
 * a peer must pass.
 *
 * Room for later: a per-thread `reactions` map keyed by random IDs, each
 * `{ emoji, principal, target }`, owned by its principal. Nothing writes it in
 * this version, and the authority check refuses it until a build adds it.
 */
export const THREAD_FIELDS = Object.freeze(["target", "author", "createdAt", "status", "messages"]);
export const MESSAGE_FIELDS = Object.freeze([
  "body",
  "format",
  "richText",
  "author",
  "createdAt",
  "deletedAt",
]);
/** Fields an author may change on their own message after creating it. */
export const MESSAGE_EDITABLE = Object.freeze(["body", "format", "richText", "deletedAt"]);
export const THREAD_STATUSES = Object.freeze(["open", "resolved"]);
/** The schema feature a Page carries once its comments moved out. A build
 * without it would write comments into the Page document, so it opens the
 * Page read-only and the host refuses its writes. */
export const COMMENTS_FEATURE = "comments-doc";

/** Hex of 16 bytes: the genesis actor for a comments document. */
function genesisActor(uuid) {
  const hex = String(uuid).replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw Error("Invalid comments document id");
  return hex;
}

/** The comments document's first change. It is a pure function of the
 * document's id, so writing it twice stores the same change: a host that
 * crashed between creating the document and recording it in the Page record
 * creates the identical genesis again. Nothing else ever writes with this
 * actor. */
export function commentsGenesis(uuid) {
  return A.change(
    A.init({ actor: genesisActor(uuid) }),
    { time: 0, message: "comments document" },
    (doc) => {
      doc.threads = {};
    },
  );
}

/** The thread map of a comments document, or an empty object. */
export function commentThreads(commentsDoc) {
  const threads = commentsDoc?.threads;
  return threads && typeof threads === "object" && !Array.isArray(threads) ? threads : {};
}

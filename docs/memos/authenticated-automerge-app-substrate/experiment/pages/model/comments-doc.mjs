import * as A from "@automerge/automerge/slim";
import { adapter } from "./richtext.mjs";
import { COMMENT_MAX_LENGTH, markdownCommentSpans } from "./comment-content.mjs";

/** A Page's comments live in their own Automerge document, owned by the Page
 * Durable Object and synced beside the Page document. Its shape:
 *
 * ```
 * {
 *   origin: string,                 // canonical host that created the doc; provenance only
 *   threads: {
 *     [threadId]: {
 *       anchor: CommentAnchor,      // Automerge cursors into the Page doc
 *       status: "open" | "resolved",
 *       created_by: principal,
 *       messages: {
 *         [messageId]: {
 *           author: principal,
 *           body: rich text,        // native spans, the comment-content.mjs schema
 *           created_at: ISO string,
 *           edited_at?: ISO string,
 *           deleted?: boolean,      // soft delete; messages are never removed
 *         },
 *       },
 *       reactions: {
 *         [reactionId]: { emoji: string, principal, target: "thread" | messageId },
 *       },
 *     },
 *   },
 * }
 * ```
 *
 * `CommentAnchor` is today's Page-doc target, unchanged:
 * `{ kind: "block", blockId }` or
 * `{ kind: "selection", anchor: Endpoint, head: Endpoint }` with
 * `Endpoint = { blockId, textObjectId, relativePositionBase64 }`.
 *
 * Principals are authenticated account IDs, never session labels or display
 * names. Profiles supply display names at read time.
 *
 * `messages` and `reactions` are created empty with their thread. Two writers
 * creating either map concurrently would conflict, and the losing map would
 * hide its entries.
 *
 * Reaction IDs are random. A deterministic `(target, emoji, principal)` key
 * would make two sessions of one account conflict on the same entry; readers
 * dedupe by that triple instead.
 *
 * Scalar fields are written as immutable strings so a change replaces them
 * whole. Readers and the authority check also accept collaborative text.
 */
export const THREAD_FIELDS = Object.freeze([
  "anchor",
  "status",
  "created_by",
  "messages",
  "reactions",
]);
export const MESSAGE_FIELDS = Object.freeze([
  "author",
  "body",
  "created_at",
  "edited_at",
  "deleted",
]);
export const REACTION_FIELDS = Object.freeze(["emoji", "principal", "target"]);
export const THREAD_STATUSES = Object.freeze(["open", "resolved"]);
export const THREAD_REACTION_TARGET = "thread";

const str = (value) => new A.ImmutableString(String(value));
const now = () => new Date().toISOString();

/** The server writes the genesis change. Nothing may touch `origin` after it. */
export function initCommentsDoc(origin, options) {
  return A.change(A.init(options), (doc) => {
    doc.origin = str(origin);
    doc.threads = {};
  });
}

function setBody(doc, path, body) {
  const source = String(body ?? "");
  if (!source.trim() || source.length > COMMENT_MAX_LENGTH)
    throw Error(`Comment must contain 1–${COMMENT_MAX_LENGTH} characters`);
  A.updateSpans(doc, [...path, "body"], markdownCommentSpans(source), adapter.updateSpansConfig());
}

/** Writers run inside `A.change` on a comments doc. They are the honest
 * client's side of the per-author rules in comment-authority.mjs. */
export function createThread(doc, { threadId, messageId, anchor, principal, body, at = now() }) {
  doc.threads[threadId] = {
    anchor,
    status: str("open"),
    created_by: str(principal),
    messages: {},
    reactions: {},
  };
  addMessage(doc, { threadId, messageId, principal, body, at });
}

export function addMessage(doc, { threadId, messageId, principal, body, at = now() }) {
  doc.threads[threadId].messages[messageId] = {
    author: str(principal),
    body: "",
    created_at: str(at),
  };
  setBody(doc, ["threads", threadId, "messages", messageId], body);
}

export function editMessage(doc, { threadId, messageId, body, at = now() }) {
  setBody(doc, ["threads", threadId, "messages", messageId], body);
  doc.threads[threadId].messages[messageId].edited_at = str(at);
}

export function deleteMessage(doc, { threadId, messageId }) {
  doc.threads[threadId].messages[messageId].deleted = true;
}

export function setThreadStatus(doc, { threadId, status }) {
  if (!THREAD_STATUSES.includes(status)) throw Error("Unsupported thread status");
  doc.threads[threadId].status = str(status);
}

export function setThreadAnchor(doc, { threadId, anchor }) {
  doc.threads[threadId].anchor = anchor;
}

export function addReaction(
  doc,
  { threadId, reactionId, principal, emoji, target = THREAD_REACTION_TARGET },
) {
  doc.threads[threadId].reactions[reactionId] = {
    emoji: str(emoji),
    principal: str(principal),
    target: str(target),
  };
}

export function removeReaction(doc, { threadId, reactionId }) {
  delete doc.threads[threadId].reactions[reactionId];
}

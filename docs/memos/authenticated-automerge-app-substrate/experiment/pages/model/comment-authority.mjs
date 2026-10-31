import * as A from "@automerge/automerge/slim";
import { validateRichSpans } from "./richtext.mjs";
import { COMMENT_MAX_BYTES, COMMENT_MAX_LENGTH } from "./comment-content.mjs";
import {
  MESSAGE_FIELDS,
  REACTION_FIELDS,
  THREAD_FIELDS,
  THREAD_REACTION_TARGET,
  THREAD_STATUSES,
} from "./comments-doc.mjs";

/** Per-author admission for a comments document (shape in comments-doc.mjs).
 *
 * `admitCommentChanges(admitted, changes, principal)` decides whether one
 * incoming batch of Automerge changes is acceptable from one authenticated
 * principal. The caller has already granted that principal the `comment`
 * capability and attributes every new change in the batch to it. The record
 * signer is the attribution source: Automerge actor IDs are not authenticated.
 *
 * `admitted` is the admission document: every change accepted before this
 * batch, and nothing else. The caller runs each check inside its serialized
 * storage transaction, after every earlier batch has been decided, never in a
 * preparation step that can run ahead of the queue. On acceptance it persists
 * the batch, then adopts `next` as the admission document and frees the old
 * one. If persistence fails, it frees `next`. A write that failed before
 * reaching storage leaves `admitted` current. An ambiguous failure may have
 * landed, so the caller rebuilds the admission document from storage before
 * deciding another batch, as the storage bridge already re-reads its record
 * index. Two batches checked against one stale document could both create the
 * same absent ID.
 *
 * The batch is applied to a clone (Automerge's fork) of `admitted`. Every
 * operation in every new change is checked against the path it writes,
 * resolved with `objInfo` on the clone. An object that is no longer visible (a
 * conflict loser or a removed reaction) resolves at that change's own heads,
 * so a latent write is checked where its author put it. Then each entity the
 * batch created or touched is validated in the merged state.
 *
 * Cost per batch. Constant in document size: one cached `objInfo` lookup and at
 * most one pre-batch read per operation, plus one bounded validation per
 * touched entity. An edited message re-validates only its own body, which
 * comment limits cap at 64 KiB; a new thread validates only itself; nothing
 * walks the threads map. Linear in document size: `A.clone` copies the
 * document's backing memory, and `applyChanges` runs on that copy. Adopting
 * `next` as the admission document keeps that to one clone per batch.
 *
 * One rejected change rejects the batch. `admitted` is never modified.
 */

export const REJECTION = Object.freeze({
  INVALID_PRINCIPAL: "invalid_principal",
  MALFORMED_CHANGE: "malformed_change",
  MISSING_DEPENDENCIES: "missing_dependencies",
  ACTOR_CLAIMED: "actor_claimed",
  UNRESOLVED_OBJECT: "unresolved_object",
  ORIGIN_IMMUTABLE: "origin_immutable",
  UNKNOWN_PATH: "unknown_path",
  IMMUTABLE_FIELD: "immutable_field",
  THREAD_DELETE: "thread_delete",
  THREAD_REPLACE: "thread_replace",
  MESSAGE_DELETE: "message_delete",
  MESSAGE_REPLACE: "message_replace",
  INVALID_CREATE: "invalid_create",
  CONFLICTING_CREATE: "conflicting_create",
  CREATED_BY_MISMATCH: "created_by_mismatch",
  AUTHOR_MISMATCH: "author_mismatch",
  REACTION_PRINCIPAL_MISMATCH: "reaction_principal_mismatch",
  NOT_THREAD_CREATOR: "not_thread_creator",
  NOT_MESSAGE_AUTHOR: "not_message_author",
  NOT_REACTION_OWNER: "not_reaction_owner",
  INVALID_VALUE: "invalid_value",
  INVALID_ID: "invalid_id",
  INVALID_TARGET: "invalid_target",
});

const MAX_ID_LENGTH = 128;
const MAX_FIELD_LENGTH = 512;
const MAX_EMOJI_LENGTH = 32;

class Rejection extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
const reject = (code, message, details) => {
  throw new Rejection(code, message, details);
};

/** Strings may be immutable or collaborative text; both read as strings. */
function scalar(value) {
  if (typeof value === "string") return value;
  if (A.isImmutableString(value)) return String(value);
  return undefined;
}
const isMap = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  !A.isImmutableString(value) &&
  !(value instanceof Date) &&
  !(value instanceof Uint8Array);
const own = (object, key) => isMap(object) && Object.hasOwn(object, key);
/** Thread, message and reaction IDs: the writers' UUIDs, or any short
 * base64url-style key. No separators or control characters, so an ID never
 * reads as two. Every ID is checked before it is used as a lookup key. */
const ID_PATTERN = new RegExp(`^[A-Za-z0-9_-]{1,${MAX_ID_LENGTH}}$`);
const safeId = (id) => typeof id === "string" && ID_PATTERN.test(id);
const boundedString = (value, max = MAX_FIELD_LENGTH) => {
  const text = scalar(value);
  return text !== undefined && text.length > 0 && text.length <= max;
};
const timestamp = (value) => boundedString(value, 64) && !Number.isNaN(Date.parse(scalar(value)));

/** Every value currently stored at `key`, including conflict losers. */
function conflictValues(object, key) {
  const conflicts = A.getConflicts(object, key);
  if (conflicts) return Object.values(conflicts);
  return own(object, key) ? [object[key]] : [];
}

function validateAnchor(anchor) {
  const endpoint = (value) =>
    isMap(value) &&
    Object.keys(value).every((k) =>
      ["blockId", "textObjectId", "relativePositionBase64"].includes(k),
    ) &&
    boundedString(value.blockId) &&
    boundedString(value.textObjectId) &&
    boundedString(value.relativePositionBase64);
  if (!isMap(anchor)) return false;
  const kind = scalar(anchor.kind);
  if (kind === "block")
    return (
      Object.keys(anchor).every((k) => ["kind", "blockId"].includes(k)) &&
      boundedString(anchor.blockId)
    );
  if (kind === "selection")
    return (
      Object.keys(anchor).every((k) => ["kind", "anchor", "head"].includes(k)) &&
      endpoint(anchor.anchor) &&
      endpoint(anchor.head)
    );
  return false;
}

function validateBody(message, where) {
  let spans;
  try {
    spans = A.spans(message, ["body"]);
  } catch {
    reject(REJECTION.INVALID_VALUE, "Message body must be rich text", where);
  }
  const text = spans
    .filter((span) => span.type === "text")
    .map((span) => span.value)
    .join("");
  if (!text.trim() || text.length > COMMENT_MAX_LENGTH)
    reject(
      REJECTION.INVALID_VALUE,
      `Comment must contain 1–${COMMENT_MAX_LENGTH} characters`,
      where,
    );
  try {
    validateRichSpans(spans, COMMENT_MAX_BYTES);
  } catch (error) {
    reject(REJECTION.INVALID_VALUE, error.message, where);
  }
}

/** Mutable message fields; author-only once the message exists. */
function validateMessageEdits(message, where) {
  if (!isMap(message)) reject(REJECTION.INVALID_VALUE, "Message must be a map", where);
  validateBody(message, where);
  if (own(message, "edited_at") && !timestamp(message.edited_at))
    reject(REJECTION.INVALID_VALUE, "edited_at must be a timestamp", where);
  if (own(message, "deleted") && typeof message.deleted !== "boolean")
    reject(REJECTION.INVALID_VALUE, "deleted must be a boolean", where);
}

function validateNewMessage(message, principal, where) {
  if (!isMap(message)) reject(REJECTION.INVALID_VALUE, "Message must be a map", where);
  for (const key of Object.keys(message))
    if (!MESSAGE_FIELDS.includes(key))
      reject(REJECTION.UNKNOWN_PATH, "Unknown message field", { ...where, field: key });
  if (scalar(message.author) !== principal)
    reject(REJECTION.AUTHOR_MISMATCH, "A new message's author must be the acting principal", where);
  if (!timestamp(message.created_at))
    reject(REJECTION.INVALID_VALUE, "created_at must be a timestamp", where);
  validateMessageEdits(message, where);
}

function validateNewReaction(reaction, thread, principal, where) {
  if (!isMap(reaction)) reject(REJECTION.INVALID_VALUE, "Reaction must be a map", where);
  for (const key of Object.keys(reaction))
    if (!REACTION_FIELDS.includes(key))
      reject(REJECTION.UNKNOWN_PATH, "Unknown reaction field", { ...where, field: key });
  if (scalar(reaction.principal) !== principal)
    reject(
      REJECTION.REACTION_PRINCIPAL_MISMATCH,
      "A new reaction's principal must be the acting principal",
      where,
    );
  const emoji = scalar(reaction.emoji);
  if (!emoji?.trim() || emoji.length > MAX_EMOJI_LENGTH)
    reject(REJECTION.INVALID_VALUE, "Reaction emoji must be 1–32 characters", where);
  // The target is read as a string and checked as an ID before it keys a
  // lookup: a missing target must not become the key "undefined".
  const target = scalar(reaction.target);
  if (target === THREAD_REACTION_TARGET) return;
  if (target === undefined)
    reject(REJECTION.INVALID_TARGET, "Reaction target must be a string", where);
  if (!safeId(target)) reject(REJECTION.INVALID_TARGET, "Reaction target is not a valid ID", where);
  if (!own(thread.messages, target))
    reject(
      REJECTION.INVALID_TARGET,
      "Reaction target must be the thread or one of its messages",
      where,
    );
}

/** Entity IDs grouped by thread. Nested maps keep every (thread, ID) pair
 * distinct, whatever characters the IDs contain. */
export class EntitySet {
  #threads = new Map();
  add(threadId, id) {
    let ids = this.#threads.get(threadId);
    if (!ids) this.#threads.set(threadId, (ids = new Set()));
    ids.add(id);
  }
  has(threadId, id) {
    return this.#threads.get(threadId)?.has(id) ?? false;
  }
  *[Symbol.iterator]() {
    for (const [threadId, ids] of this.#threads) for (const id of ids) yield [threadId, id];
  }
}

/** The thread, message and reaction IDs a write path names, checked before
 * any of them keys a lookup. `thread` is reserved as a message ID because it
 * is the reaction target for the thread itself. */
function requireSafeIds(full, where) {
  if (!safeId(full[1])) reject(REJECTION.INVALID_ID, "Invalid thread ID", where);
  if (full.length < 4) return;
  if (full[2] === "messages" && (!safeId(full[3]) || full[3] === THREAD_REACTION_TARGET))
    reject(REJECTION.INVALID_ID, "Invalid message ID", where);
  if (full[2] === "reactions" && !safeId(full[3]))
    reject(REJECTION.INVALID_ID, "Invalid reaction ID", where);
}

function singleCreate(container, key, where) {
  if (conflictValues(container, key).length !== 1)
    reject(REJECTION.CONFLICTING_CREATE, "A created entry must have exactly one value", where);
}

function validateNewThread(threads, threadId, principal) {
  const where = { thread: threadId };
  singleCreate(threads, threadId, where);
  const thread = threads[threadId];
  if (!isMap(thread)) reject(REJECTION.INVALID_VALUE, "Thread must be a map", where);
  for (const key of Object.keys(thread))
    if (!THREAD_FIELDS.includes(key))
      reject(REJECTION.UNKNOWN_PATH, "Unknown thread field", { ...where, field: key });
  if (scalar(thread.created_by) !== principal)
    reject(
      REJECTION.CREATED_BY_MISMATCH,
      "A new thread's created_by must be the acting principal",
      where,
    );
  if (!THREAD_STATUSES.includes(scalar(thread.status)))
    reject(REJECTION.INVALID_VALUE, "Thread status must be open or resolved", where);
  if (!validateAnchor(thread.anchor))
    reject(REJECTION.INVALID_VALUE, "Invalid thread anchor", where);
  if (!isMap(thread.messages) || !isMap(thread.reactions))
    reject(REJECTION.INVALID_VALUE, "A new thread needs messages and reactions maps", where);
  const messageIds = Object.keys(thread.messages);
  if (!messageIds.length)
    reject(REJECTION.INVALID_VALUE, "A new thread needs its first message", where);
  for (const id of messageIds) {
    singleCreate(thread.messages, id, { ...where, message: id });
    validateNewMessage(thread.messages[id], principal, { ...where, message: id });
  }
  for (const id of Object.keys(thread.reactions)) {
    singleCreate(thread.reactions, id, { ...where, reaction: id });
    validateNewReaction(thread.reactions[id], thread, principal, { ...where, reaction: id });
  }
}

/** Decide one operation against the admission document. `full` is the
 * path the op writes: the object's path, plus the key for a map operation.
 * Returns nothing; records touched entities in `plan`. */
function checkOperation(op, full, ctx) {
  const { principal, plan } = ctx;
  const where = { path: full };
  if (full[0] === "origin") reject(REJECTION.ORIGIN_IMMUTABLE, "origin is immutable", where);
  if (full[0] !== "threads") reject(REJECTION.UNKNOWN_PATH, "Unknown path", where);
  if (full.length === 1) reject(REJECTION.IMMUTABLE_FIELD, "threads cannot be replaced", where);
  requireSafeIds(full, where);
  const threadId = full[1];
  const before = ctx.thread(threadId);
  const isCreate = op.action === "makeMap" && op.pred.length === 0;
  if (full.length === 2) {
    if (before)
      reject(
        op.action === "del" ? REJECTION.THREAD_DELETE : REJECTION.THREAD_REPLACE,
        "An existing thread cannot be deleted or replaced",
        where,
      );
    if (!isCreate) reject(REJECTION.INVALID_CREATE, "A thread is created as a new map", where);
    plan.newThreads.add(threadId);
    return;
  }
  // Everything under a thread the batch is creating is checked as a whole
  // in validateNewThread once the batch is merged.
  if (!before) {
    plan.newThreads.add(threadId);
    return;
  }
  const field = full[2];
  switch (field) {
    case "status":
      plan.status.add(threadId);
      return;
    case "anchor":
      if (scalar(before.created_by) !== principal)
        reject(
          REJECTION.NOT_THREAD_CREATOR,
          "Only the thread's creator can move its anchor",
          where,
        );
      plan.anchors.add(threadId);
      return;
    case "created_by":
      return reject(REJECTION.IMMUTABLE_FIELD, "created_by is immutable", where);
    case "messages":
      return checkMessageOperation(op, full, ctx, threadId, before, isCreate, where);
    case "reactions":
      return checkReactionOperation(op, full, ctx, threadId, before, isCreate, where);
    default:
      reject(REJECTION.UNKNOWN_PATH, "Unknown thread field", where);
  }
}

function checkMessageOperation(op, full, ctx, threadId, thread, isCreate, where) {
  if (full.length === 3) reject(REJECTION.IMMUTABLE_FIELD, "messages cannot be replaced", where);
  const messageId = full[3];
  const before = ctx.read(thread.messages, messageId);
  if (full.length === 4) {
    if (before)
      reject(
        op.action === "del" ? REJECTION.MESSAGE_DELETE : REJECTION.MESSAGE_REPLACE,
        "An existing message cannot be removed or replaced; set deleted instead",
        where,
      );
    if (!isCreate) reject(REJECTION.INVALID_CREATE, "A message is created as a new map", where);
    ctx.plan.newMessages.add(threadId, messageId);
    return;
  }
  if (!before) {
    ctx.plan.newMessages.add(threadId, messageId);
    return;
  }
  const field = full[4];
  if (field === "author" || field === "created_at")
    reject(REJECTION.IMMUTABLE_FIELD, `${field} is immutable`, where);
  if (!["body", "edited_at", "deleted"].includes(field))
    reject(REJECTION.UNKNOWN_PATH, "Unknown message field", where);
  if (scalar(before.author) !== ctx.principal)
    reject(REJECTION.NOT_MESSAGE_AUTHOR, "Only a message's author can edit or delete it", where);
  ctx.plan.editedMessages.add(threadId, messageId);
}

function checkReactionOperation(op, full, ctx, threadId, thread, isCreate, where) {
  if (full.length === 3) reject(REJECTION.IMMUTABLE_FIELD, "reactions cannot be replaced", where);
  const reactionId = full[3];
  const before = ctx.read(thread.reactions, reactionId);
  if (before) {
    const owner = scalar(before.principal) === ctx.principal;
    if (!owner)
      reject(REJECTION.NOT_REACTION_OWNER, "Only a reaction's principal can remove it", where);
    if (full.length !== 4 || op.action !== "del")
      reject(REJECTION.IMMUTABLE_FIELD, "A reaction can be added or removed, not changed", where);
    ctx.plan.removedReactions.add(threadId, reactionId);
    return;
  }
  if (full.length === 4 && op.action === "del") {
    // Two sessions removing the same reaction: the second delete is a no-op.
    ctx.plan.removedReactions.add(threadId, reactionId);
    return;
  }
  if (full.length === 4 && !isCreate)
    reject(REJECTION.INVALID_CREATE, "A reaction is created as a new map", where);
  ctx.plan.newReactions.add(threadId, reactionId);
}

function finalize(after, plan, principal) {
  const threads = after.threads;
  for (const threadId of plan.newThreads) validateNewThread(threads, threadId, principal);
  for (const [threadId, messageId] of plan.newMessages) {
    if (plan.newThreads.has(threadId)) continue;
    const where = { thread: threadId, message: messageId };
    singleCreate(threads[threadId].messages, messageId, where);
    validateNewMessage(threads[threadId].messages[messageId], principal, where);
  }
  for (const [threadId, messageId] of plan.editedMessages)
    validateMessageEdits(threads[threadId].messages[messageId], {
      thread: threadId,
      message: messageId,
    });
  for (const threadId of plan.status) {
    // Any commenter may write status, so every stored value must be valid:
    // a losing value could surface later under someone else's change.
    const values = conflictValues(threads[threadId], "status");
    if (!values.length || values.some((value) => !THREAD_STATUSES.includes(scalar(value))))
      reject(REJECTION.INVALID_VALUE, "Thread status must be open or resolved", {
        thread: threadId,
      });
  }
  for (const threadId of plan.anchors)
    if (!validateAnchor(threads[threadId].anchor))
      reject(REJECTION.INVALID_VALUE, "Invalid thread anchor", { thread: threadId });
  for (const [threadId, reactionId] of plan.newReactions) {
    if (plan.newThreads.has(threadId)) continue;
    const where = { thread: threadId, reaction: reactionId };
    const thread = threads[threadId];
    singleCreate(thread.reactions, reactionId, where);
    validateNewReaction(thread.reactions[reactionId], thread, principal, where);
  }
  for (const [threadId, reactionId] of plan.removedReactions)
    if (
      !plan.newReactions.has(threadId, reactionId) &&
      own(threads[threadId].reactions, reactionId)
    )
      reject(REJECTION.INVALID_VALUE, "A removed reaction is still present", {
        thread: threadId,
        reaction: reactionId,
      });
}

/** Decide one batch against the admission document.
 *
 * @param {A.Doc<unknown>} admitted every change accepted so far; never modified
 * @param {Uint8Array[]} changes encoded Automerge changes from one signer
 * @param {string} principal the signer's authenticated principal
 * @param {{ actorPrincipal?: (actor: string) => string | undefined }} [options]
 *   `actorPrincipal` returns the principal that first wrote with an Automerge
 *   actor ID, so one account cannot write under another's actor.
 * @returns {{ ok: true, next: A.Doc<unknown>, actors: string[], stats: object }
 *   | { ok: false, reason: { code: string, message: string, change?: string, details?: object }, stats: object }}
 *   `next` is `admitted` plus the batch, owned by the caller. It becomes the
 *   admission document once the batch is persisted. `actors` lists the
 *   Automerge actors this batch wrote with.
 */
export function admitCommentChanges(admitted, changes, principal, options = {}) {
  const stats = { changes: 0, ops: 0, pathLookups: 0, entityReads: 0 };
  if (typeof principal !== "string" || !principal.length)
    return {
      ok: false,
      reason: { code: REJECTION.INVALID_PRINCIPAL, message: "A principal is required" },
      stats,
    };
  let candidate;
  let current;
  try {
    const decoded = [];
    for (const bytes of changes) {
      try {
        decoded.push(A.decodeChange(bytes));
      } catch {
        reject(REJECTION.MALFORMED_CHANGE, "Change could not be decoded");
      }
    }
    // Changes the admission document already holds were accepted before. Applying
    // them again is a no-op, so only new changes are attributed here.
    const fresh = decoded.filter((change) => !A.hasHeads(admitted, [change.hash]));
    const actors = new Set();
    for (const change of fresh) {
      current = change.hash;
      const owner = options.actorPrincipal?.(change.actor);
      if (owner !== undefined && owner !== principal)
        reject(REJECTION.ACTOR_CLAIMED, "This Automerge actor belongs to another principal");
      actors.add(change.actor);
    }
    current = undefined;
    candidate = A.clone(admitted);
    try {
      candidate = A.applyChanges(candidate, changes)[0];
    } catch (error) {
      reject(REJECTION.MALFORMED_CHANGE, error?.message ?? "Changes could not be applied");
    }
    // A change with missing dependencies would wait in the queue and apply
    // later, unchecked, when another peer supplies them.
    const hashes = fresh.map((change) => change.hash);
    if (!A.hasHeads(candidate, hashes))
      reject(REJECTION.MISSING_DEPENDENCIES, "The batch depends on changes this document lacks");

    const backend = A.getBackend(candidate);
    const paths = new Map();
    const resolve = (obj, hash) => {
      if (obj === "_root") return [];
      const cached = paths.get(obj);
      if (cached) return cached;
      stats.pathLookups++;
      let path = backend.objInfo(obj).path;
      if (path) paths.set(obj, path);
      else {
        stats.pathLookups++;
        path = backend.objInfo(obj, [hash]).path;
      }
      return path;
    };
    const reads = new Map();
    const read = (container, key) => {
      if (!own(container, key)) return undefined;
      stats.entityReads++;
      return container[key];
    };
    const ctx = {
      principal,
      read,
      thread: (threadId) => {
        if (!reads.has(threadId)) reads.set(threadId, read(admitted.threads, threadId));
        return reads.get(threadId);
      },
      plan: {
        newThreads: new Set(),
        newMessages: new EntitySet(),
        editedMessages: new EntitySet(),
        newReactions: new EntitySet(),
        removedReactions: new EntitySet(),
        status: new Set(),
        anchors: new Set(),
      },
    };
    for (const change of fresh) {
      current = change.hash;
      stats.changes++;
      for (const op of change.ops) {
        stats.ops++;
        const path = resolve(op.obj, change.hash);
        if (!path) reject(REJECTION.UNRESOLVED_OBJECT, "Operation targets an unknown object");
        checkOperation(op, op.key === undefined ? path : [...path, op.key], ctx);
      }
    }
    current = undefined;
    finalize(candidate, ctx.plan, principal);
    return { ok: true, next: candidate, actors: [...actors], stats };
  } catch (error) {
    if (candidate) A.free(candidate);
    if (!(error instanceof Rejection)) throw error;
    return {
      ok: false,
      reason: {
        code: error.code,
        message: error.message,
        ...(current && { change: current }),
        ...(Object.keys(error.details).length && { details: error.details }),
      },
      stats,
    };
  }
}

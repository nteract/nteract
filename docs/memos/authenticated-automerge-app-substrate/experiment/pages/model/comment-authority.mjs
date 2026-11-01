import * as A from "@automerge/automerge/slim";
import { RICH_FORMAT, validateRichSpans } from "./richtext.mjs";
import { COMMENT_MAX_BYTES, COMMENT_MAX_LENGTH } from "./comment-content.mjs";
import {
  MESSAGE_EDITABLE,
  MESSAGE_FIELDS,
  THREAD_FIELDS,
  THREAD_STATUSES,
} from "./comments-doc.mjs";
import { COMMENTING_ROLES, commentDecision } from "./comment-rules.mjs";
import { BUILD_FEATURES, documentFeatures } from "./schema-features.mjs";

/** Per-author admission for a comments document (shape in comments-doc.mjs).
 *
 * `admitCommentChanges(admitted, changes, principal, { role })` decides
 * whether one incoming batch of Automerge changes is acceptable from one
 * authenticated principal holding one Page role. The caller has already
 * granted that principal the `comment` capability and attributes every new
 * change in the batch to it. The record signer is the attribution source:
 * Automerge actor IDs are not authenticated. What each role may do is
 * comment-rules.mjs's table; this module maps every operation onto it.
 *
 * `admitted` is the admission document: every change accepted before this
 * batch, and nothing else. The caller runs each check inside its serialized
 * storage write, after every earlier batch has been decided, never in a
 * preparation step that can run ahead of the queue. On acceptance it persists
 * the batch, then adopts `next` as the admission document and frees the old
 * one. If persistence fails, it frees `next` and rebuilds the admission
 * document from what storage holds before deciding another batch: an
 * ambiguous failure may have landed, and two batches checked against one
 * stale document could both create the same absent ID.
 *
 * The batch is applied to a clone (Automerge's fork) of `admitted`. Every
 * operation in every new change is checked against the path it writes,
 * resolved with `objInfo` on the clone. An object that is no longer visible
 * (a deleted thread) resolves at that change's own heads, so a latent write is
 * checked where its author put it. Then each entity the batch created or
 * touched is validated in the merged state. A write that lands only in an
 * object nobody can see, such as a reply racing its thread's deletion, has no
 * visible effect and is admitted.
 *
 * Cost per batch: constant in document size per operation (one cached
 * `objInfo` lookup and at most one pre-batch read), plus one bounded
 * validation per touched entity. `A.clone` and `applyChanges` are linear in
 * document size; adopting `next` keeps that to one clone per batch.
 *
 * One rejected change rejects the batch. `admitted` is never modified.
 */

export const REJECTION = Object.freeze({
  INVALID_PRINCIPAL: "invalid_principal",
  MALFORMED_CHANGE: "malformed_change",
  MISSING_DEPENDENCIES: "missing_dependencies",
  ACTOR_CLAIMED: "actor_claimed",
  UNRESOLVED_OBJECT: "unresolved_object",
  UNKNOWN_PATH: "unknown_path",
  IMMUTABLE_FIELD: "immutable_field",
  THREAD_REPLACE: "thread_replace",
  NOT_ALLOWED: "not_allowed",
  MESSAGE_DELETE: "message_delete",
  MESSAGE_REPLACE: "message_replace",
  INVALID_CREATE: "invalid_create",
  CONFLICTING_CREATE: "conflicting_create",
  AUTHOR_MISMATCH: "author_mismatch",
  NOT_THREAD_AUTHOR: "not_thread_author",
  NOT_MESSAGE_AUTHOR: "not_message_author",
  INVALID_VALUE: "invalid_value",
  INVALID_ID: "invalid_id",
  UNSUPPORTED_FEATURE: "unsupported_feature",
});

const MAX_ID_LENGTH = 128;
const MAX_FIELD_LENGTH = 512;

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
/** Thread and message IDs: the writers' UUIDs, or any short base64url-style
 * key. No separators or control characters, so an ID never reads as two.
 * Every ID is checked before it is used as a lookup key. */
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

function validateAuthor(author, principal, where) {
  if (
    !isMap(author) ||
    Object.keys(author).some((k) => !["principal", "displayName", "driver"].includes(k))
  )
    reject(REJECTION.INVALID_VALUE, "author must be { principal, displayName, driver }", where);
  if (scalar(author.principal) !== principal)
    reject(REJECTION.AUTHOR_MISMATCH, "A new entry's author must be the acting principal", where);
  for (const key of ["displayName", "driver"])
    if (own(author, key) && scalar(author[key]) === undefined)
      reject(REJECTION.INVALID_VALUE, `author.${key} must be a string`, where);
  if (!boundedString(author.displayName ?? "-", 256) || !boundedString(author.driver ?? "-", 128))
    reject(REJECTION.INVALID_VALUE, "author labels are too long", where);
}

function validateStatus(status) {
  return (
    isMap(status) &&
    Object.keys(status).every((k) => ["value", "at"].includes(k)) &&
    THREAD_STATUSES.includes(scalar(status.value)) &&
    timestamp(status.at)
  );
}

/** A message's current content: the literal body, and native spans once the
 * message is rich. */
function validateBody(message, where) {
  const format = own(message, "format") ? scalar(message.format) : undefined;
  if (own(message, "format") && format !== RICH_FORMAT)
    reject(REJECTION.INVALID_VALUE, "Unsupported message format", where);
  const body = scalar(message.body);
  if (body === undefined) reject(REJECTION.INVALID_VALUE, "Message body must be text", where);
  if (format !== RICH_FORMAT) {
    if (own(message, "richText"))
      reject(REJECTION.INVALID_VALUE, "richText needs the rich format", where);
    if (!body.trim() || body.length > COMMENT_MAX_LENGTH)
      reject(
        REJECTION.INVALID_VALUE,
        `Comment must contain 1–${COMMENT_MAX_LENGTH} characters`,
        where,
      );
    return;
  }
  let spans;
  try {
    spans = A.spans(message, ["richText"]);
  } catch {
    reject(REJECTION.INVALID_VALUE, "richText must be rich text", where);
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
  const deleted = message.deletedAt;
  if (deleted !== null && deleted !== undefined && !timestamp(deleted))
    reject(REJECTION.INVALID_VALUE, "deletedAt must be null or a timestamp", where);
}

function validateNewMessage(message, principal, where) {
  if (!isMap(message)) reject(REJECTION.INVALID_VALUE, "Message must be a map", where);
  for (const key of Object.keys(message))
    if (!MESSAGE_FIELDS.includes(key))
      reject(REJECTION.UNKNOWN_PATH, "Unknown message field", { ...where, field: key });
  validateAuthor(message.author, principal, where);
  if (!timestamp(message.createdAt))
    reject(REJECTION.INVALID_VALUE, "createdAt must be a timestamp", where);
  validateMessageEdits(message, where);
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

function requireSafeIds(full, where) {
  if (!safeId(full[1])) reject(REJECTION.INVALID_ID, "Invalid thread ID", where);
  if (full.length >= 4 && full[2] === "messages" && !safeId(full[3]))
    reject(REJECTION.INVALID_ID, "Invalid message ID", where);
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
  validateAuthor(thread.author, principal, where);
  if (!timestamp(thread.createdAt))
    reject(REJECTION.INVALID_VALUE, "createdAt must be a timestamp", where);
  if (!validateStatus(thread.status))
    reject(REJECTION.INVALID_VALUE, "Thread status must be open or resolved", where);
  if (!validateAnchor(thread.target))
    reject(REJECTION.INVALID_VALUE, "Invalid thread anchor", where);
  if (!isMap(thread.messages))
    reject(REJECTION.INVALID_VALUE, "A new thread needs a messages map", where);
  const messageIds = Object.keys(thread.messages);
  if (!messageIds.length)
    reject(REJECTION.INVALID_VALUE, "A new thread needs its first message", where);
  for (const id of messageIds) {
    if (!safeId(id)) reject(REJECTION.INVALID_ID, "Invalid message ID", { ...where, message: id });
    singleCreate(thread.messages, id, { ...where, message: id });
    validateNewMessage(thread.messages[id], principal, { ...where, message: id });
  }
}

function allowed(ctx, action, thread, message, code, where) {
  const decision = commentDecision({
    action,
    role: ctx.role,
    principal: ctx.principal,
    thread,
    message,
  });
  if (!decision.allowed) reject(code ?? REJECTION.NOT_ALLOWED, decision.message, where);
}

/** Decide one operation against the admission document. `full` is the
 * path the op writes: the object's path, plus the key for a map operation.
 * Returns nothing; records touched entities in `plan`. */
function checkOperation(op, full, ctx) {
  const { plan } = ctx;
  const where = { path: full };
  if (full[0] === "schema") {
    plan.schema = true;
    return;
  }
  if (full[0] !== "threads") reject(REJECTION.UNKNOWN_PATH, "Unknown path", where);
  if (full.length === 1) reject(REJECTION.IMMUTABLE_FIELD, "threads cannot be replaced", where);
  requireSafeIds(full, where);
  const threadId = full[1];
  const before = ctx.thread(threadId);
  const isCreate = op.action === "makeMap" && op.pred.length === 0;
  if (full.length === 2) {
    if (before) {
      if (op.action !== "del")
        reject(REJECTION.THREAD_REPLACE, "An existing thread cannot be replaced", where);
      allowed(ctx, "delete_thread", before, undefined, REJECTION.NOT_THREAD_AUTHOR, where);
      plan.deletedThreads.add(threadId);
      return;
    }
    // Deleting a thread that is already gone changes nothing visible.
    if (op.action === "del") return;
    if (!isCreate) reject(REJECTION.INVALID_CREATE, "A thread is created as a new map", where);
    plan.newThreads.add(threadId);
    return;
  }
  // Everything under a thread the batch is creating is checked as a whole
  // once the batch is merged.
  if (!before) {
    plan.newThreads.add(threadId);
    return;
  }
  const field = full[2];
  switch (field) {
    case "status":
      // Any commenter resolves or reopens; the stored value is checked after.
      plan.status.add(threadId);
      return;
    case "target":
      allowed(ctx, "move_anchor", before, undefined, REJECTION.NOT_THREAD_AUTHOR, where);
      plan.anchors.add(threadId);
      return;
    case "author":
    case "createdAt":
      return reject(REJECTION.IMMUTABLE_FIELD, `${field} is immutable`, where);
    case "messages":
      return checkMessageOperation(op, full, ctx, threadId, before, isCreate, where);
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
        "An existing message cannot be removed or replaced; set deletedAt instead",
        where,
      );
    if (op.action === "del") return;
    if (!isCreate) reject(REJECTION.INVALID_CREATE, "A message is created as a new map", where);
    ctx.plan.newMessages.add(threadId, messageId);
    return;
  }
  if (!before) {
    ctx.plan.newMessages.add(threadId, messageId);
    return;
  }
  const field = full[4];
  if (field === "author" || field === "createdAt")
    reject(REJECTION.IMMUTABLE_FIELD, `${field} is immutable`, where);
  if (!MESSAGE_EDITABLE.includes(field))
    reject(REJECTION.UNKNOWN_PATH, "Unknown message field", where);
  allowed(ctx, "edit", thread, before, REJECTION.NOT_MESSAGE_AUTHOR, where);
  ctx.plan.editedMessages.add(threadId, messageId);
}

function finalize(after, plan, ctx) {
  const { principal } = ctx;
  const threads = after.threads;
  if (!isMap(threads)) reject(REJECTION.INVALID_VALUE, "threads must be a map");
  for (const threadId of plan.newThreads)
    if (own(threads, threadId)) validateNewThread(threads, threadId, principal);
  for (const [threadId, messageId] of plan.newMessages) {
    if (plan.newThreads.has(threadId) || !own(threads, threadId)) continue;
    const thread = threads[threadId];
    if (!own(thread.messages, messageId)) continue;
    const where = { thread: threadId, message: messageId };
    singleCreate(thread.messages, messageId, where);
    validateNewMessage(thread.messages[messageId], principal, where);
  }
  for (const [threadId, messageId] of plan.editedMessages) {
    const thread = own(threads, threadId) ? threads[threadId] : undefined;
    if (!thread || !own(thread.messages, messageId)) continue;
    validateMessageEdits(thread.messages[messageId], { thread: threadId, message: messageId });
  }
  for (const threadId of plan.status) {
    if (!own(threads, threadId)) continue;
    // Any commenter may write status, so every stored value must be valid:
    // a losing value could surface later under someone else's change.
    const values = conflictValues(threads[threadId], "status");
    if (!values.length || values.some((value) => !validateStatus(value)))
      reject(REJECTION.INVALID_VALUE, "Thread status must be open or resolved", {
        thread: threadId,
      });
  }
  for (const threadId of plan.anchors)
    if (own(threads, threadId) && !validateAnchor(threads[threadId].target))
      reject(REJECTION.INVALID_VALUE, "Invalid thread anchor", { thread: threadId });
  if (plan.schema) {
    // A stamp only names features this host's build knows: an unknown id
    // would make every reader's comments read-only.
    const unknown = documentFeatures(after).filter((id) => !ctx.features.includes(id));
    if (unknown.length)
      reject(REJECTION.UNSUPPORTED_FEATURE, "The schema stamp names an unknown feature", {
        features: unknown,
      });
  }
}

/** Decide one batch against the admission document.
 *
 * @param {A.Doc<unknown>} admitted every change accepted so far; never modified
 * @param {Uint8Array[]} changes encoded Automerge changes from one signer
 * @param {string} principal the signer's authenticated principal
 * @param {{ role?: string, actorPrincipal?: (actor: string) => string | undefined,
 *   features?: readonly string[] }} [options]
 *   `role` is the principal's Page role (comment-rules.mjs). `actorPrincipal`
 *   returns the principal that first wrote with an Automerge actor ID, so one
 *   account cannot write under another's actor. `features` are the schema
 *   features a stamp may name; this build's by default.
 * @returns {{ ok: true, next: A.Doc<unknown>, actors: string[], stats: object }
 *   | { ok: false, reason: { code: string, message: string, change?: string, details?: object }, stats: object }}
 *   `next` is `admitted` plus the batch, owned by the caller.
 */
export function admitCommentChanges(admitted, changes, principal, options = {}) {
  const stats = { changes: 0, ops: 0, pathLookups: 0, entityReads: 0 };
  if (typeof principal !== "string" || !principal.length)
    return {
      ok: false,
      reason: { code: REJECTION.INVALID_PRINCIPAL, message: "A principal is required" },
      stats,
    };
  if (!COMMENTING_ROLES.includes(options.role))
    return {
      ok: false,
      reason: { code: REJECTION.NOT_ALLOWED, message: "Commenting needs comment access" },
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
    // Changes the admission document already holds were accepted before.
    // Applying them again is a no-op, so only new changes are attributed.
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
      role: options.role,
      features: options.features ?? BUILD_FEATURES,
      read,
      thread: (threadId) => {
        if (!reads.has(threadId)) reads.set(threadId, read(admitted.threads, threadId));
        return reads.get(threadId);
      },
      plan: {
        newThreads: new Set(),
        deletedThreads: new Set(),
        newMessages: new EntitySet(),
        editedMessages: new EntitySet(),
        status: new Set(),
        anchors: new Set(),
        schema: false,
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
    finalize(candidate, ctx.plan, ctx);
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

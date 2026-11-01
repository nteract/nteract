import * as A from "@automerge/automerge/slim";
import { isRich } from "./richtext.mjs";
import { commentBodyProjection, setCommentContent } from "./comment-content.mjs";
const field = (block) => (isRich(block) ? "richText" : "markdown");

// The text object and final selected character must both survive. Repeated
// quotes never cause an old comment to silently attach to a different passage.
export function selectionContext(doc, target) {
  if (target.kind !== "selection") return undefined;
  try {
    const a = target.anchor,
      b = target.head;
    if (!Object.hasOwn(doc.blocks, a.blockId) || a.blockId !== b.blockId)
      return { status: "detached" };
    const block = doc.blocks[a.blockId],
      path = ["blocks", a.blockId, field(block)];
    if ([a, b].some((p) => A.getObjectId(block, field(block)) !== p.textObjectId))
      return { status: "detached" };
    const from = A.getCursorPosition(doc, path, atob(a.relativePositionBase64));
    const last = A.getCursorPosition(doc, path, atob(b.relativePositionBase64));
    if (A.getCursor(doc, path, last) !== atob(b.relativePositionBase64))
      return { status: "detached" };
    const point = block[field(block)].codePointAt(last);
    if (point === undefined) return { status: "detached" };
    const to = last + (point > 0xffff ? 2 : 1);
    if (to <= from) return { status: "detached" };
    return {
      status: "attached",
      start: { blockId: a.blockId, offsetUtf16: from },
      end: { blockId: b.blockId, offsetUtf16: to },
      text: block[field(block)].slice(from, to).replaceAll("\ufffc", "\n"),
    };
  } catch {
    return { status: "detached" };
  }
}
export function projectComments(doc) {
  return Object.entries(doc.comments ?? {}).map(([id, t]) => ({
    ...t,
    id,
    state: t.status.value,
    selectionContext: selectionContext(doc, t.target),
    messages: Object.entries(t.messages)
      .map(([id, m]) => {
        const { body: _body, richText: _richText, ...rest } = m;
        return { ...rest, id, ...(!m.deletedAt && commentBodyProjection(m)) };
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  }));
}
/** A selection target captured by the caller, usually at an older revision.
 * Symbol keys never arrive through JSON, so a request body cannot forge one.
 */
export const resolvedCommentTarget = Symbol("resolvedCommentTarget");

/** Capture cursors for the occurrence-th copy of `selected` in a block's raw
 * text. `doc` may be a historical view: cursors name characters, so the target
 * resolves in any later revision that still holds its final character.
 */
export function captureSelectionTarget(doc, id, selected, occurrence = 1) {
  const block = doc.blocks[id];
  if (!Object.hasOwn(doc.blocks, id) || !block) throw Error("Comment block not found");
  if (!Number.isSafeInteger(occurrence) || occurrence < 1 || occurrence > 10000)
    throw Error("Invalid selection occurrence");
  const name = field(block);
  let start = -1;
  for (let i = 0; i < occurrence; i++) {
    start = block[name].indexOf(selected, start + 1);
    if (start < 0) throw Error("Selected passage changed; select it again");
  }
  const endpoint = (offset) => ({
    blockId: id,
    textObjectId: A.getObjectId(block, name),
    relativePositionBase64: btoa(A.getCursor(doc, ["blocks", id, name], offset)),
  });
  return {
    kind: "selection",
    anchor: endpoint(start),
    head: endpoint(start + selected.length - Array.from(selected).at(-1).length),
  };
}

const encoder = new TextEncoder();
/** A caller-supplied thread or block ID: nonempty, at most 256 UTF-8 bytes,
 * no control characters. */
export function validCommentId(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 256) return false;
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code < 32 || code === 127) return false;
  }
  return encoder.encode(value).byteLength <= 256;
}
export const MAX_THREAD_BATCH = 100;
const STATUS_ACTIONS = ["resolve", "reopen"];
const selectorError = (message, details) =>
  Object.assign(Error(message), {
    status: 400,
    code: "invalid_comment_selector",
    ...(details && { details }),
  });

/** The thread IDs a status batch names, or null for the single-thread form.
 * resolve and reopen take exactly one of thread_id or thread_ids; every other
 * action takes thread_id only. Shape errors are 400 invalid_comment_selector,
 * raised before any thread is read. */
export function threadBatch(input, action) {
  if (input.thread_ids === undefined) {
    if (STATUS_ACTIONS.includes(action) && input.thread_id === undefined)
      throw selectorError("Provide thread_id or thread_ids");
    return null;
  }
  if (!STATUS_ACTIONS.includes(action))
    throw selectorError("thread_ids is accepted only for resolve and reopen");
  if (input.thread_id !== undefined)
    throw selectorError("Provide thread_id or thread_ids, not both");
  const ids = input.thread_ids;
  if (
    !Array.isArray(ids) ||
    ids.length < 1 ||
    ids.length > MAX_THREAD_BATCH ||
    Array.from(ids).some((id) => !validCommentId(id)) ||
    new Set(ids).size !== ids.length
  )
    throw selectorError(
      `thread_ids must contain 1–${MAX_THREAD_BATCH} unique IDs of at most 256 UTF-8 bytes each`,
    );
  return ids;
}

/** One status for every named thread, in the caller's change. The batch is
 * all-or-nothing: an unknown ID rejects it before any thread is touched, and
 * the error names every unknown ID. A thread already in the target state is
 * left as it is, so its `at` keeps the time it got there. */
function applyThreadStatuses(doc, action, ids, now) {
  const missing = ids.filter((id) => !(Object.hasOwn(doc.comments, id) && doc.comments[id]));
  if (missing.length)
    throw selectorError(
      `${missing.length} of ${ids.length} comment threads not found; nothing was changed. not_found_thread_ids names them.`,
      { not_found_thread_ids: missing },
    );
  const value = action === "resolve" ? "resolved" : "open";
  const threads = ids.map((id) => {
    const thread = doc.comments[id];
    if (String(thread.status?.value) === value)
      return { thread_id: id, outcome: action === "resolve" ? "already_resolved" : "already_open" };
    thread.status = { value, at: now };
    return { thread_id: id, outcome: action === "resolve" ? "resolved" : "reopened" };
  });
  return { threads };
}

export function applyComment(doc, input, identity, nativeSpans) {
  const action = input.action ?? "add",
    now = new Date().toISOString();
  const batch = threadBatch(input, action);
  if (batch) return applyThreadStatuses(doc, action, batch, now);
  const author = {
    principal: identity?.principal ?? "",
    displayName: identity?.displayName ?? "Collaborator",
    driver: identity?.driver ?? "Browser",
  };
  const body = String(input.body ?? "");
  if (["add", "reply", "edit"].includes(action) && (!body.trim() || body.length > 16000))
    throw Error("Comment must contain 1–16000 characters");
  const threadId = action === "add" ? crypto.randomUUID() : input.thread_id;
  const messageId = ["add", "reply"].includes(action) ? crypto.randomUUID() : input.message_id;
  if (action === "add") {
    const id = input.block_id,
      block = doc.blocks[id];
    if (!Object.hasOwn(doc.blocks, id) || !block) throw Error("Comment block not found");
    let target = { kind: "block", blockId: id };
    if (input[resolvedCommentTarget]) {
      target = input[resolvedCommentTarget];
      if (target.anchor?.blockId !== id) throw Error("Selected passage changed; select it again");
    } else if (input.selected_text)
      target = captureSelectionTarget(doc, id, String(input.selected_text), input.occurrence ?? 1);
    doc.comments[threadId] = {
      target,
      author,
      createdAt: now,
      status: { value: "open", at: now },
      messages: { [messageId]: { body, author, createdAt: now, deletedAt: null } },
    };
    setCommentContent(doc, ["comments", threadId, "messages", messageId], input, nativeSpans);
  } else {
    const thread = Object.hasOwn(doc.comments, threadId) && doc.comments[threadId];
    if (!thread) throw Error("Comment not found");
    if (action === "reply") {
      thread.messages[messageId] = { body, author, createdAt: now, deletedAt: null };
      setCommentContent(doc, ["comments", threadId, "messages", messageId], input, nativeSpans);
    } else if (action === "resolve" || action === "reopen")
      thread.status = { value: action === "resolve" ? "resolved" : "open", at: now };
    else if (action === "edit" || action === "delete_message") {
      const message = Object.hasOwn(thread.messages, messageId) && thread.messages[messageId];
      if (!message || message.deletedAt) throw Error("Comment message not found");
      // Generic Page writers can change comments. These labels are document
      // content, not an authorization or audit mechanism.
      if (action === "edit")
        setCommentContent(doc, ["comments", threadId, "messages", messageId], input, nativeSpans);
      else message.deletedAt = now;
    } else throw Error("Unsupported comment action");
  }
  return { thread_id: threadId, message_id: messageId ?? null };
}

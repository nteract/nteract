import * as A from "@automerge/automerge/slim";
import { authorOf } from "./author.mjs";
import { commentBodyProjection, setCommentContent } from "./comment-content.mjs";
import { COMMENTS_FEATURE, COMMENT_AGENT_FEATURE, commentThreads } from "./comments-doc.mjs";
import { commentDecision, requireCommentDecision } from "./comment-rules.mjs";
import { documentFeatures, stampFeatures } from "./schema-features.mjs";
import { storedFormUnsupported } from "./stored-form.mjs";

// The text object and final selected character must both survive. Repeated
// quotes never cause an old comment to silently attach to a different passage.
export function selectionContext(doc, target) {
  if (target?.kind !== "selection") return undefined;
  const a = target.anchor,
    b = target.head;
  if (!Object.hasOwn(doc.blocks, a?.blockId) || a.blockId !== b?.blockId)
    return { status: "detached" };
  const block = doc.blocks[a.blockId];
  try {
    const path = ["blocks", a.blockId, "richText"];
    if ([a, b].some((p) => A.getObjectId(block, "richText") !== String(p.textObjectId)))
      return { status: "detached" };
    const from = A.getCursorPosition(doc, path, atob(String(a.relativePositionBase64)));
    const last = A.getCursorPosition(doc, path, atob(String(b.relativePositionBase64)));
    if (A.getCursor(doc, path, last) !== atob(String(b.relativePositionBase64)))
      return { status: "detached" };
    const point = block.richText.codePointAt(last);
    if (point === undefined) return { status: "detached" };
    const to = last + (point > 0xffff ? 2 : 1);
    if (to <= from) return { status: "detached" };
    return {
      status: "attached",
      start: { blockId: a.blockId, offsetUtf16: from },
      end: { blockId: b.blockId, offsetUtf16: to },
      text: block.richText.slice(from, to).replaceAll("\ufffc", "\n"),
    };
  } catch {
    return { status: "detached" };
  }
}

/** Whether the Page carries the `comments-doc` stamp: its comments live in
 * their own document. */
export const commentsMigrated = (page) => documentFeatures(page).includes(COMMENTS_FEATURE);

/** A Page's threads, from its comments document (none until it's open).
 * An unstamped Page that still holds a `comments` map kept its threads in
 * the Page document, as an earlier build wrote them, and fails closed. An
 * unstamped Page without one holds nothing to misread: a browser replica
 * opens empty and gets the stamp when the Page syncs. */
export function threadsOf(page, commentsDoc) {
  if (page && !commentsMigrated(page) && page.comments !== undefined)
    throw storedFormUnsupported("this Page's comments");
  return commentsDoc ? commentThreads(commentsDoc) : {};
}

export function projectComments(page, commentsDoc) {
  return Object.entries(threadsOf(page, commentsDoc)).map(([id, t]) => ({
    ...t,
    id,
    state: t.status?.value,
    selectionContext: selectionContext(page, t.target),
    messages: Object.entries(t.messages ?? {})
      .map(([id, m]) => {
        const { body: _body, richText: _richText, bodyFormat: _bodyFormat, ...rest } = m;
        return { ...rest, id, ...(!m.deletedAt && commentBodyProjection(m)) };
      })
      // Messages written in the same millisecond keep one order everywhere.
      .sort(
        (a, b) =>
          String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id),
      ),
  }));
}
/** A selection target captured by the caller, usually at an older revision.
 * Symbol keys never arrive through JSON, so a request body cannot forge one.
 */
export const resolvedCommentTarget = Symbol("resolvedCommentTarget");

/** Capture cursors for the occurrence-th copy of `selected` in a block's raw
 * text, or only in its range `within` (`{ start, end }`, one top-level node's
 * text) when given. `doc` may be a historical view: cursors name characters,
 * so the target resolves in any later revision that still holds its final
 * character.
 */
export function captureSelectionTarget(doc, id, selected, occurrence = 1, within) {
  const block = doc.blocks[id];
  if (!Object.hasOwn(doc.blocks, id) || !block) throw Error("Comment block not found");
  if (!Number.isSafeInteger(occurrence) || occurrence < 1 || occurrence > 10000)
    throw Error("Invalid selection occurrence");
  const name = "richText";
  const end = within ? within.end : block[name].length;
  let start = within ? within.start - 1 : -1;
  for (let i = 0; i < occurrence; i++) {
    start = block[name].indexOf(selected, start + 1);
    if (start < 0 || start + selected.length > end)
      throw Error("Selected passage changed; select it again");
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

const hasThread = (threads, id) => Object.hasOwn(threads, id) && !!threads[id];

/** One status for every named thread, in the caller's change. The batch is
 * all-or-nothing: an unknown ID rejects it before any thread is touched, and
 * the error names every unknown ID. A thread already in the target state is
 * left as it is, so its `at` keeps the time it got there. */
function applyThreadStatuses(threads, action, ids, now) {
  const missing = ids.filter((id) => !hasThread(threads, id));
  if (missing.length)
    throw selectorError(
      `${missing.length} of ${ids.length} comment threads not found; nothing was changed. not_found_thread_ids names them.`,
      { not_found_thread_ids: missing },
    );
  const value = action === "resolve" ? "resolved" : "open";
  const results = ids.map((id) => {
    const thread = threads[id];
    if (String(thread.status?.value) === value)
      return { thread_id: id, outcome: action === "resolve" ? "already_resolved" : "already_open" };
    thread.status = { value, at: now };
    return { thread_id: id, outcome: action === "resolve" ? "resolved" : "reopened" };
  });
  return { threads: results };
}

/**
 * Apply one comment action to a comments document inside its `A.change`.
 *
 * `page` is the Page document (or a view of it) that anchors resolve
 * against: a new comment's block must exist there, and a passage comment
 * captures cursors into it. `role` is the caller's Page role; comment-rules
 * decides what it may do. `nativeSpans` is the browser composer's draft;
 * without it, `input.body` and `input.body_format` are the content
 * (comment-content.mjs setCommentContent). Agent Markdown refuses math and
 * HTML with `unsupported_markdown`.
 *
 * `agent` is `{ name?, model? }`, what the writing client said about itself
 * (shared/client-provenance.mjs). A new message keeps it on its author, under
 * the `comment-agent` stamp; later edits never touch it.
 */
export function applyComment(
  commentsDoc,
  input,
  identity,
  nativeSpans,
  { page, role, agent } = {},
) {
  const action = input.action ?? "add",
    now = new Date().toISOString();
  if (!page) throw Error("A comment needs its Page");
  if (!commentsDoc.threads) throw Error("Comments are not available for this Page yet");
  const threads = commentsDoc.threads;
  const principal = identity?.principal ?? "";
  const batch = threadBatch(input, action);
  if (batch) {
    requireCommentDecision(commentDecision({ action, role, principal }));
    return applyThreadStatuses(threads, action, batch, now);
  }
  const author = authorOf(identity, agent);
  if (author.agent && ["add", "reply"].includes(action))
    stampFeatures(commentsDoc, [COMMENT_AGENT_FEATURE]);
  const threadId = action === "add" ? crypto.randomUUID() : input.thread_id;
  const messageId = ["add", "reply"].includes(action) ? crypto.randomUUID() : input.message_id;
  const path = (id) => ["threads", threadId, "messages", id];
  if (action === "add") {
    requireCommentDecision(commentDecision({ action, role, principal }));
    const id = input.block_id,
      block = page.blocks?.[id];
    if (!Object.hasOwn(page.blocks ?? {}, id) || !block) throw Error("Comment block not found");
    let target = { kind: "block", blockId: id };
    if (input[resolvedCommentTarget]) {
      target = input[resolvedCommentTarget];
      if (target.anchor?.blockId !== id) throw Error("Selected passage changed; select it again");
    } else if (input.selected_text)
      target = captureSelectionTarget(page, id, String(input.selected_text), input.occurrence ?? 1);
    threads[threadId] = {
      target,
      author,
      createdAt: now,
      status: { value: "open", at: now },
      messages: { [messageId]: { author, createdAt: now, deletedAt: null } },
    };
    setCommentContent(commentsDoc, path(messageId), input, nativeSpans);
    return { thread_id: threadId, message_id: messageId };
  }
  const thread = hasThread(threads, threadId) && threads[threadId];
  if (!thread) throw Error("Comment not found");
  if (action === "reply") {
    requireCommentDecision(commentDecision({ action, role, principal, thread }));
    thread.messages[messageId] = { author, createdAt: now, deletedAt: null };
    setCommentContent(commentsDoc, path(messageId), input, nativeSpans);
  } else if (action === "resolve" || action === "reopen") {
    requireCommentDecision(commentDecision({ action, role, principal, thread }));
    // A thread already in the target state is left as it is, as in a batch:
    // nothing is written, so no comment revision is made.
    const [{ outcome }] = applyThreadStatuses(threads, action, [threadId], now).threads;
    return { thread_id: threadId, message_id: null, outcome };
  } else if (action === "edit" || action === "delete_message") {
    const message = Object.hasOwn(thread.messages, messageId) && thread.messages[messageId];
    if (!message || message.deletedAt) throw Error("Comment message not found");
    requireCommentDecision(commentDecision({ action, role, principal, thread, message }));
    if (action === "edit") setCommentContent(commentsDoc, path(messageId), input, nativeSpans);
    else message.deletedAt = now;
  } else if (action === "delete_thread") {
    requireCommentDecision(commentDecision({ action, role, principal, thread }));
    delete threads[threadId];
    return { thread_id: threadId, message_id: null };
  } else throw Error("Unsupported comment action");
  return { thread_id: threadId, message_id: messageId ?? null };
}

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
export function applyComment(doc, input, identity, nativeSpans) {
  const action = input.action ?? "add",
    now = new Date().toISOString();
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
    if (input.selected_text) {
      let start = -1;
      const selected = String(input.selected_text),
        occurrence = input.occurrence ?? 1;
      if (!Number.isSafeInteger(occurrence) || occurrence < 1 || occurrence > 10000)
        throw Error("Invalid selection occurrence");
      for (let i = 0; i < occurrence; i++) {
        start = block[field(block)].indexOf(selected, start + 1);
        if (start < 0) throw Error("Selected passage changed; select it again");
      }
      const endpoint = (offset) => ({
        blockId: id,
        textObjectId: A.getObjectId(block, field(block)),
        relativePositionBase64: btoa(A.getCursor(doc, ["blocks", id, field(block)], offset)),
      });
      target = {
        kind: "selection",
        anchor: endpoint(start),
        head: endpoint(start + selected.length - Array.from(selected).at(-1).length),
      };
    }
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

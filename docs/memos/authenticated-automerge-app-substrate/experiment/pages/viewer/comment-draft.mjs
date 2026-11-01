import * as A from "@automerge/automerge/slim";
import { selectionContext } from "../model/comments.mjs";
import { isRich } from "../model/richtext.mjs";

const textField = (block) => (isRich(block) ? "richText" : "markdown");
const changedPassage = () => Error("Selected passage was removed or replaced; select it again");

function commentBlock(doc, blockId) {
  if (!Object.hasOwn(doc.blocks, blockId))
    throw Error("Comment block was removed; choose another passage");
  return doc.blocks[blockId];
}

// This is local composer state. Its anchors use the existing comment target
// shape; nothing is added to the shared document until the comment is sent.
export function captureCommentDraft(doc, blockId, selection) {
  const block = commentBlock(doc, blockId);
  const blockObjectId = A.getObjectId(block);
  if (!blockObjectId) throw Error("Comment block is unavailable");
  let target = { kind: "block", blockId };
  if (selection) {
    const { text, occurrence } = selection;
    if (
      typeof text !== "string" ||
      !text ||
      !Number.isSafeInteger(occurrence) ||
      occurrence < 1 ||
      occurrence > 10000
    )
      throw Error("Select a passage before commenting");
    const field = textField(block),
      source = block[field],
      textObjectId = A.getObjectId(block, field);
    if (typeof source !== "string" || !textObjectId) throw changedPassage();
    let start = -1;
    for (let i = 0; i < occurrence; i++) {
      start = source.indexOf(text, start + 1);
      if (start < 0) throw changedPassage();
    }
    const endpoint = (offset) =>
      Object.freeze({
        blockId,
        textObjectId,
        relativePositionBase64: btoa(A.getCursor(doc, ["blocks", blockId, field], offset)),
      });
    target = {
      kind: "selection",
      anchor: endpoint(start),
      head: endpoint(start + text.length - Array.from(text).at(-1).length),
    };
  }
  return Object.freeze({ blockId, blockObjectId, target: Object.freeze(target) });
}

// Resolve immediately before session.comment so the semantic operation receives
// today's occurrence, even when a peer inserted another copy ahead of the draft.
export function resolveCommentDraft(doc, draft) {
  const block = commentBlock(doc, draft.blockId);
  if (A.getObjectId(block) !== draft.blockObjectId)
    throw Error("Comment block was replaced; choose another passage");
  if (draft.target.kind === "block") return { block_id: draft.blockId };
  const field = textField(block),
    path = ["blocks", draft.blockId, field],
    context = selectionContext(doc, draft.target);
  if (context?.status !== "attached") throw changedPassage();
  // Existing published comments may contract when their first character goes
  // away. A draft must instead ask the writer to choose its passage again.
  for (const endpoint of [draft.target.anchor, draft.target.head]) {
    const cursor = atob(endpoint.relativePositionBase64);
    const offset = A.getCursorPosition(doc, path, cursor);
    if (A.getCursor(doc, path, offset) !== cursor) throw changedPassage();
  }
  const source = block[field],
    start = context.start.offsetUtf16,
    selected = source.slice(start, context.end.offsetUtf16);
  let occurrence = 0,
    at = -1;
  do {
    at = source.indexOf(selected, at + 1);
    occurrence++;
  } while (at >= 0 && at < start && occurrence <= 10000);
  if (at !== start || occurrence > 10000) throw changedPassage();
  return { block_id: draft.blockId, selected_text: selected, occurrence };
}

/**
 * Add a thread for `draft` through `session.comment` and resolve with the new
 * thread's id once the change is stored. Resolving and writing happen without
 * an await between them. The id is read by comparing thread keys around the
 * local change, which applies synchronously.
 */
export async function sendCommentDraft(session, draft, body) {
  const markdown = body?.markdown ?? body;
  if (typeof markdown !== "string" || !markdown.trim()) throw Error("Write a comment first");
  const target = resolveCommentDraft(session.doc, draft);
  const before = new Set(Object.keys(session.commentThreads ?? {}));
  const stored = session.comment(
    { ...target, action: "add", body: markdown, body_format: "markdown" },
    body?.spans,
  );
  const threadId = Object.keys(session.commentThreads ?? {}).find((id) => !before.has(id)) ?? null;
  await stored;
  return threadId;
}

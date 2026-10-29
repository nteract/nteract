import { applyPageOperation } from "../model/page.mjs";
import { orderedBlockIds } from "../model/order.mjs";
import { blockMarkdown, isRich } from "../model/richtext.mjs";

function emptyTrailingBlock(doc) {
  const id = orderedBlockIds(doc).at(-1),
    block = doc?.blocks?.[id];
  return block?.kind === "markdown" && isRich(block) && !blockMarkdown(block).trim() ? id : null;
}

/** Continue from the current replica, reusing a blank paragraph after repeated activation. */
export function writingContinuation(session) {
  if (!session?.alive || !session.canWrite) return null;
  const existing = emptyTrailingBlock(session.doc);
  if (existing) return existing;
  let id;
  session.change((doc) => {
    id = emptyTrailingBlock(doc);
    if (id) return;
    applyPageOperation(doc, {
      operation: "edit_page",
      arguments: { operations: [{ op: "insert_markdown", markdown: "" }] },
    });
    id = orderedBlockIds(doc).at(-1);
  });
  return id;
}

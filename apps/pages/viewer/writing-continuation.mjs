import { applyPageOperation } from "../model/page.mjs";
import { orderedBlockIds } from "../model/order.mjs";
import { isBlankBlock } from "../model/richtext-format.mjs";

function emptyTrailingBlock(doc) {
  const id = orderedBlockIds(doc).at(-1),
    block = doc?.blocks?.[id];
  return block && isBlankBlock(block) ? id : null;
}

/** Whether a projected Page (projectPage) is still empty: one paragraph with
 * nothing in it, as a new Page starts. Such a Page opens with the caret in
 * that paragraph. */
export function isEmptyPage(page) {
  const blocks = page?.blocks ?? [];
  return blocks.length === 1 && !String(blocks[0].markdown ?? "").trim();
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

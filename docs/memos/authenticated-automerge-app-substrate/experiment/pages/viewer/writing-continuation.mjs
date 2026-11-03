import { applyPageOperation } from "../model/page.mjs";
import { orderedBlockIds } from "../model/order.mjs";
import { blockMarkdown, isRich } from "../model/richtext.mjs";

function emptyTrailingBlock(doc) {
  const id = orderedBlockIds(doc).at(-1),
    block = doc?.blocks?.[id];
  return block?.kind === "markdown" && isRich(block) && !blockMarkdown(block).trim() ? id : null;
}

/** Whether a projected Page (projectPage) is still empty: one rich paragraph
 * with nothing in it, as a new Page starts. Such a Page opens with the caret
 * in that paragraph. */
export function isEmptyPage(page) {
  const blocks = page?.blocks ?? [];
  return (
    blocks.length === 1 &&
    blocks[0].kind === "markdown" &&
    blocks[0].format === "automerge-rich-text-v1" &&
    !String(blocks[0].markdown ?? "").trim()
  );
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

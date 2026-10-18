import * as A from "@automerge/automerge/slim";
import { RICH_FORMAT, setRichMarkdown, projectedBlock, blockMarkdown } from "./richtext.mjs";
import { applyComment, projectComments } from "./comments.mjs";
import { orderedBlockIds, positionForInsertion } from "./order.mjs";
export { orderedBlockIds } from "./order.mjs";
const block = (id = crypto.randomUUID(), position = positionForInsertion()) => ({
  id,
  position,
  kind: "markdown",
  format: RICH_FORMAT,
  markdown: "",
  richText: "",
  metadata: {},
});
export function createPageData({ pageId, title = "Untitled" }) {
  const first = block();
  return {
    page_id: pageId,
    title: String(title).slice(0, 1024),
    blocks: { [first.id]: first },
    comments: {},
  };
}
export function initializePage(doc, markdown = "") {
  setRichMarkdown(doc, orderedBlockIds(doc)[0], String(markdown));
}
export function projectPage(doc) {
  return {
    page_id: doc.page_id,
    title: doc.title,
    blocks: orderedBlockIds(doc).map((id) => projectedBlock(doc.blocks[id])),
    comments: projectComments(doc),
  };
}
function applyEdit(doc, op) {
  const id = op.block_id ?? op.id;
  if (op.op === "set_title") {
    A.updateText(doc, ["title"], String(op.title).slice(0, 1024));
    return;
  }
  if (op.op === "insert_markdown") {
    const value = block(crypto.randomUUID(), positionForInsertion(doc, op.after_block_id));
    doc.blocks[value.id] = value;
    setRichMarkdown(doc, value.id, String(op.markdown ?? ""));
    return;
  }
  if (!Object.hasOwn(doc.blocks, id)) throw Error("Block not found");
  if (op.op === "move_block") {
    if (op.after_block_id !== id)
      doc.blocks[id].position = positionForInsertion(doc, op.after_block_id, id);
    return;
  }
  if (op.op === "replace_block_markdown") setRichMarkdown(doc, id, String(op.markdown ?? ""));
  else if (op.op === "patch_block_markdown") {
    let source = blockMarkdown(doc.blocks[id]);
    if (!Array.isArray(op.replacements) || op.replacements.length > 100)
      throw Error("Provide up to 100 replacements");
    for (const replacement of op.replacements) {
      const old = replacement.old,
        value = replacement.new;
      if (typeof old !== "string" || !old || typeof value !== "string")
        throw Error("Replacement requires nonempty old and string new");
      const at = source.indexOf(old);
      if (at < 0 || source.indexOf(old, at + 1) >= 0)
        throw Error("Replacement text must occur exactly once");
      source = source.slice(0, at) + value + source.slice(at + old.length);
    }
    setRichMarkdown(doc, id, source);
  } else if (op.op === "delete_block") {
    delete doc.blocks[id];
  } else throw Error("Unsupported edit operation");
}
export function applyPageOperation(doc, { operation, arguments: args = {}, identity }) {
  if (operation === "manage_page_comment" || operation === "reply_page_comment")
    return applyComment(
      doc,
      operation === "reply_page_comment" ? { ...args, action: "reply" } : args,
      identity,
    );
  if (operation !== "edit_page" && operation !== "patch_page")
    throw Error("Unsupported Page operation");
  if (!Array.isArray(args.operations) || args.operations.length > 100)
    throw Error("Provide up to 100 operations");
  for (const op of args.operations) applyEdit(doc, { ...op, op: op.op ?? op.type });
  return { page_id: doc.page_id };
}

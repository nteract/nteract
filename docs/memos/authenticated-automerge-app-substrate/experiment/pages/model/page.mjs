import * as A from "@automerge/automerge/slim";
import { RICH_FORMAT, setRichMarkdown, setRichImage, projectedBlock } from "./richtext.mjs";
import { imageAssetUrl, validAssetId } from "../shared/image-assets.mjs";
import { applyComment, projectComments } from "./comments.mjs";
import { orderedBlockIds, positionForInsertion } from "./order.mjs";
import { formatMatch, replaceMatch } from "./replace-match.mjs";
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
export function validateImageInsertion(op) {
  if (
    !validAssetId(op.asset_id) ||
    typeof op.alt !== "string" ||
    op.alt.length > 2048 ||
    (op.after_block_id !== undefined &&
      op.after_block_id !== null &&
      (typeof op.after_block_id !== "string" || !op.after_block_id)) ||
    Object.keys(op).some(
      (key) => !["op", "type", "asset_id", "alt", "after_block_id"].includes(key),
    )
  )
    throw Error(
      "insert_image requires an uploaded asset_id, alt text (up to 2048 characters), and optional after_block_id",
    );
}
// `trace` records where each operation landed, for agent presence. It never
// enters the result, so stored receipts and retries are unchanged.
function applyEdit(doc, op, trace) {
  const id = op.block_id ?? op.id;
  if (op.op === "set_title") {
    A.updateText(doc, ["title"], String(op.title).slice(0, 1024));
    return;
  }
  if (op.op === "insert_markdown") {
    const value = block(crypto.randomUUID(), positionForInsertion(doc, op.after_block_id));
    doc.blocks[value.id] = value;
    setRichMarkdown(doc, value.id, String(op.markdown ?? ""));
    trace?.push({ type: "block", block_id: value.id });
    return;
  }
  if (op.op === "insert_image") {
    validateImageInsertion(op);
    const value = block(crypto.randomUUID(), positionForInsertion(doc, op.after_block_id));
    const asset_url = imageAssetUrl(doc.page_id, op.asset_id);
    doc.blocks[value.id] = value;
    setRichImage(doc, value.id, { src: asset_url, alt: op.alt });
    trace?.push({ type: "block", block_id: value.id });
    return {
      op: "insert_image",
      block_id: value.id,
      asset_id: op.asset_id,
      asset_url,
      alt: op.alt,
    };
  }
  if (!Object.hasOwn(doc.blocks, id)) throw Error("Block not found");
  if (op.op === "move_block") {
    if (op.after_block_id !== id)
      doc.blocks[id].position = positionForInsertion(doc, op.after_block_id, id);
    trace?.push({ type: "block", block_id: id });
    return;
  }
  if (op.op === "replace_match") return replaceMatch(doc, id, op, trace);
  if (op.op === "format_match") return formatMatch(doc, id, op, trace);
  if (op.op === "replace_block_markdown") {
    setRichMarkdown(doc, id, String(op.markdown ?? ""));
    trace?.push({ type: "block", block_id: id });
  } else if (op.op === "delete_block") {
    delete doc.blocks[id];
  } else throw Error("Unsupported edit operation");
}
export function applyPageOperation(doc, { operation, arguments: args = {}, identity, trace }) {
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
  const edits = [],
    inserted_images = [];
  for (const op of args.operations) {
    const edit = applyEdit(doc, { ...op, op: op.op ?? op.type }, trace);
    if (edit?.op === "insert_image") {
      const { op: _op, ...image } = edit;
      inserted_images.push(image);
    } else if (edit) edits.push(edit);
  }
  return {
    page_id: doc.page_id,
    ...(edits.length ? { edits } : {}),
    ...(inserted_images.length ? { inserted_images } : {}),
  };
}

import * as A from "@automerge/automerge/slim";
import {
  RICH_FORMAT,
  isRich,
  redundantFirstMarker,
  requireRich,
  textPath,
} from "./richtext-format.mjs";
import { quotableNodeType } from "./richtext-notices.mjs";
import { markdownlessNode } from "./richtext-spans.mjs";
import { nativeRead, readKind } from "./native-read.mjs";
import {
  setRichMarkdown,
  setRichMarkdownKeepingNodes,
  setRichImage,
  setRichNode,
  projectedBlock,
} from "./richtext-page.mjs";
import { resolveNodeId } from "./node-ids.mjs";
import { imageIds, resolveImageId } from "./image-ids.mjs";
import { updateSpansConfig } from "./marks.mjs";
import { stampSpans } from "./schema-features.mjs";
import { imageAssetUrl, validAssetId } from "../shared/image-assets.mjs";
import { DATAFRAME_BLOCK, dataframeFor } from "../shared/dataset-assets.mjs";
import { projectComments } from "./comments.mjs";
import { COMMENTS_FEATURE } from "./comments-doc.mjs";
import { orderedBlockIds, positionForInsertion } from "./order.mjs";
import { anchorOccurrence, formatMatch, replaceMatch } from "./replace-match.mjs";
import { setNode } from "./set-node.mjs";
import { insertOperation } from "./node-registry.mjs";
import { stampFeatures } from "./schema-features.mjs";
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
  };
}
/** A new Page's first change: its first block's Markdown, and the stamp that
 * says its comments live in their own document (model/comments-doc.mjs). */
export function initializePage(doc, markdown = "") {
  setRichMarkdown(doc, orderedBlockIds(doc)[0], String(markdown));
  stampFeatures(doc, [COMMENTS_FEATURE]);
}
/** `commentsDoc` is the Page's comments document, when it's available. */
export function projectPage(doc, commentsDoc) {
  return {
    page_id: doc.page_id,
    title: doc.title,
    blocks: orderedBlockIds(doc).map((id) => projectedBlock(doc.blocks[id], doc.page_id)),
    comments: projectComments(doc, commentsDoc),
  };
}
export function validateImageInsertion(op) {
  if (
    !validAssetId(op.asset_id) ||
    (op.dark_asset_id !== undefined && !validAssetId(op.dark_asset_id)) ||
    (op.title !== undefined &&
      op.title !== null &&
      (typeof op.title !== "string" || op.title.length > 2048)) ||
    typeof op.alt !== "string" ||
    op.alt.length > 2048 ||
    (op.after_block_id !== undefined &&
      op.after_block_id !== null &&
      (typeof op.after_block_id !== "string" || !op.after_block_id)) ||
    Object.keys(op).some(
      (key) =>
        !["op", "type", "asset_id", "dark_asset_id", "alt", "title", "after_block_id"].includes(
          key,
        ),
    )
  )
    throw Error(
      "insert_image requires an uploaded asset_id, alt text (up to 2048 characters), and optional after_block_id",
    );
}
export function validateImageChange(op) {
  if (
    !op ||
    Object.keys(op).some(
      (key) =>
        !["op", "block_id", "image_id", "asset_id", "dark_asset_id", "alt", "title"].includes(key),
    ) ||
    typeof op.block_id !== "string" ||
    !op.block_id ||
    typeof op.image_id !== "string" ||
    !op.image_id ||
    op.image_id.length > 192 ||
    !["asset_id", "dark_asset_id", "alt", "title"].some((key) => Object.hasOwn(op, key)) ||
    (op.asset_id !== undefined && !validAssetId(op.asset_id)) ||
    (op.dark_asset_id !== undefined &&
      op.dark_asset_id !== null &&
      !validAssetId(op.dark_asset_id)) ||
    (op.alt !== undefined && (typeof op.alt !== "string" || op.alt.length > 2048)) ||
    (op.title !== undefined &&
      op.title !== null &&
      (typeof op.title !== "string" || op.title.length > 2048))
  )
    throw Error(
      "set_image requires block_id, live image_id and asset_id, dark_asset_id (null removes), alt or title",
    );
}
const NODE_INSERTION_USAGE =
  'insert_node requires node: {type: "dataframe", attrs: {asset_id, title?, media_type?}} and optional after_block_id';
const only = (value, keys) =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));
/** Check an insert_node operation without a Page: its shape, the node type and
 * the attrs an agent may set. Returns the agent's attrs. */
export function validateNodeInsertion(op) {
  const node = op?.node;
  if (
    !only(op, ["op", "type", "node", "after_block_id"]) ||
    !only(node, ["type", "attrs"]) ||
    node.type !== DATAFRAME_BLOCK ||
    !only(node.attrs, ["asset_id", "media_type", "title"]) ||
    !validAssetId(node.attrs.asset_id) ||
    (op.after_block_id !== undefined &&
      op.after_block_id !== null &&
      (typeof op.after_block_id !== "string" || !op.after_block_id))
  )
    throw Error(NODE_INSERTION_USAGE);
  // Title and media type rules live with the node.
  dataframeFor("00000000-0000-4000-8000-000000000000", node.attrs);
  return node.attrs;
}
/** The stored assets a batch's node-creating operations name, for the host
 * to check before the change (`apply` can't await). Each operation is
 * validated first; an invalid one throws. Driven by insertOperation in
 * model/node-registry.mjs, so a new node type that names an asset declares
 * its asset kind there and gets the check. Image assets are listed once
 * each. */
export function insertedAssets(operations, pageId) {
  const assets = [];
  const seen = new Set();
  for (const op of operations) {
    const name = op?.op ?? op?.type;
    if (name === "set_image") {
      validateImageChange(op);
      for (const assetId of [op.asset_id, op.dark_asset_id].filter(Boolean)) {
        if (seen.has(assetId)) continue;
        seen.add(assetId);
        assets.push({ asset: "image", assetId });
      }
      continue;
    }
    const insert = insertOperation(name);
    if (!insert) continue;
    if (insert.asset === "image") {
      validateImageInsertion(op);
      for (const assetId of [op.asset_id, op.dark_asset_id].filter(Boolean)) {
        if (seen.has(assetId)) continue;
        seen.add(assetId);
        assets.push({ asset: "image", assetId });
      }
    } else if (insert.asset === "dataset") {
      const attrs = dataframeFor(pageId, validateNodeInsertion(op));
      assets.push({
        asset: "dataset",
        assetId: op.node.attrs.asset_id,
        mediaType: attrs.media_type,
      });
    } else throw Error(`No asset check for ${insert.asset}`);
  }
  return assets;
}
const PASSAGE_OPS = new Set(["replace_match", "format_match", "set_node"]);
const MARKDOWN_OPS = new Set(["replace_block_markdown", "insert_markdown"]);
// `trace` records where each operation landed, for agent presence. It never
// enters the result, so stored receipts and retries are unchanged.
function applyEdit(doc, op, trace, context) {
  const id = op.block_id ?? op.id;
  if (op.op === "set_title") {
    A.updateText(doc, ["title"], String(op.title).slice(0, 1024));
    return;
  }
  if (op.op === "insert_markdown") {
    const value = block(crypto.randomUUID(), positionForInsertion(doc, op.after_block_id));
    doc.blocks[value.id] = value;
    setRichMarkdown(doc, value.id, op.markdown);
    trace?.push({ type: "block", block_id: value.id });
    return;
  }
  if (op.op === "insert_image") {
    validateImageInsertion(op);
    const value = block(crypto.randomUUID(), positionForInsertion(doc, op.after_block_id));
    const asset_url = imageAssetUrl(doc.page_id, op.asset_id);
    doc.blocks[value.id] = value;
    const dark_src = op.dark_asset_id ? imageAssetUrl(doc.page_id, op.dark_asset_id) : null;
    setRichImage(doc, value.id, { src: asset_url, dark_src, alt: op.alt, title: op.title });
    trace?.push({ type: "block", block_id: value.id });
    return {
      op: "insert_image",
      block_id: value.id,
      asset_id: op.asset_id,
      asset_url,
      image_id: imageIds(doc, value.id)[0].image_id,
      ...(dark_src && { dark_asset_id: op.dark_asset_id, dark_src }),
      ...(op.title !== undefined && { title: op.title }),
      alt: op.alt,
    };
  }
  if (op.op === "insert_node") {
    const input = validateNodeInsertion(op);
    const value = block(crypto.randomUUID(), positionForInsertion(doc, op.after_block_id));
    const attrs = dataframeFor(doc.page_id, input);
    doc.blocks[value.id] = value;
    setRichNode(doc, value.id, { type: op.node.type, attrs });
    trace?.push({ type: "block", block_id: value.id });
    return {
      op: "insert_node",
      block_id: value.id,
      type: op.node.type,
      attrs: { asset_id: input.asset_id, ...attrs },
    };
  }
  if (!Object.hasOwn(doc.blocks, id)) throw Error("Block not found");
  if (op.op === "set_image") {
    validateImageChange(op);
    const { index } = resolveImageId(doc, id, op.image_id);
    const spans = A.spans(doc, textPath(id));
    const attrs = { ...spans[index].value.attrs };
    if (op.asset_id !== undefined)
      attrs.src = new A.ImmutableString(imageAssetUrl(doc.page_id, op.asset_id));
    if (op.dark_asset_id === null) delete attrs.dark_src;
    else if (op.dark_asset_id !== undefined)
      attrs.dark_src = new A.ImmutableString(imageAssetUrl(doc.page_id, op.dark_asset_id));
    for (const key of ["alt", "title"])
      if (op[key] !== undefined)
        attrs[key] = op[key] === null ? null : new A.ImmutableString(op[key]);
    spans[index] = { ...spans[index], value: { ...spans[index].value, attrs } };
    A.updateSpans(doc, textPath(id), spans, updateSpansConfig);
    stampSpans(doc, spans);
    trace?.push({ type: "block", block_id: id });
    return { op: "set_image", block_id: id, image_id: op.image_id };
  }
  if (op.op === "move_block") {
    if (op.after_block_id !== id)
      doc.blocks[id].position = positionForInsertion(doc, op.after_block_id, id);
    trace?.push({ type: "block", block_id: id });
    return;
  }
  if (op.op === "replace_match") return replaceMatch(doc, id, op, trace, context);
  if (op.op === "format_match") return formatMatch(doc, id, op, trace, context);
  if (op.op === "set_node") return setNode(doc, id, op, trace, context);
  if (op.op === "replace_block_markdown") {
    const node = markdownlessNode(doc.blocks[id], doc.page_id);
    if (node)
      throw Object.assign(
        Error(
          `This block holds ${quotableNodeType(node) ? `${/^[aeiou]/.test(node) ? "an" : "a"} ${node}` : "a node this version of Pages doesn't know"}, which has no Markdown form, so a Markdown rewrite would lose it. Remove it with delete_node, or edit around it with patch_page.`,
        ),
        { code: "markdownless_node" },
      );
    // A dataframe's read-back line, left unchanged, keeps the node. Runs
    // after the unknown-node refusal: with no dataframe in the block it
    // falls through to a plain rewrite.
    setRichMarkdownKeepingNodes(doc, id, op.markdown);
    trace?.push({ type: "block", block_id: id });
  } else if (op.op === "delete_block") {
    delete doc.blocks[id];
  } else if (op.op === "delete_node") {
    return deleteNode(doc, id, op, trace, context.opened);
  } else throw Error("Unsupported edit operation");
}
/** Delete the top-level node `op.node_id` names: its marker through the next
 * node's marker, so its text, marks and children go with it and its
 * neighbours keep their identity. Refused when the block ends up with fewer
 * than one node less: a list has no marker of its own to keep it apart, so
 * two alike on either side of the deleted node would join into one. (Deleting a
 * block's only node leaves the one empty paragraph a block always has.)
 * A delete of the node that opens the block is recorded in `opened`; the
 * batch drops the next node's plain paragraph marker once it's done
 * (dropOpeningMarkers), so later deletes in the batch still find their ids. */
function deleteNode(doc, id, op, trace, opened) {
  requireRich(doc.blocks[id]);
  const tree = nativeRead(doc.blocks[id], doc.page_id);
  const { index, start, end } = resolveNodeId(doc, id, op.node_id, tree);
  const type = readKind(tree.nodes[index]);
  A.splice(doc, textPath(id), start, end - start);
  // Removing whole top-level nodes keeps the tree valid; check it anyway, so
  // a malformed result can never be committed.
  const result = nativeRead(doc.blocks[id], doc.page_id);
  if (result.nodes.length < tree.nodes.length - 1) {
    const name = (offset) => readKind(tree.nodes[index + offset]);
    // Throwing aborts the whole change, the splice included.
    throw Object.assign(
      Error(
        `delete_node would join the ${name(-1)} before this node and the ${name(1)} after it into one. Delete one of them first, earlier in the same batch, or rewrite the block with replace_block_markdown.`,
      ),
      { code: "nodes_would_join" },
    );
  }
  if (start === 0) opened.add(id);
  trace?.push({ type: "block", block_id: id });
  return { op: "delete_node", block_id: id, node_id: op.node_id, type };
}
/** A block whose opening node a delete removed loses the plain paragraph
 * marker it may now open with, as the editor would on its next edit. */
function dropOpeningMarkers(doc, opened) {
  for (const id of opened) {
    if (!Object.hasOwn(doc.blocks, id) || !isRich(doc.blocks[id])) continue;
    const path = textPath(id);
    if (redundantFirstMarker(A.spans(doc, path))) A.splice(doc, path, 0, 1);
  }
}
export function applyPageOperation(doc, options) {
  const result = applyOperation(doc, options);
  // Every write repairs a stamp left incomplete by concurrent first stamps.
  stampFeatures(doc);
  return result;
}
function applyOperation(doc, { operation, arguments: args = {}, trace }) {
  // Comments are written to the comments document, never the Page.
  if (operation !== "edit_page" && operation !== "patch_page")
    throw Error("Unsupported Page operation");
  if (!Array.isArray(args.operations) || args.operations.length > 100)
    throw Error("Provide up to 100 operations");
  const operations = args.operations.map((op) => ({ ...op, op: op.op ?? op.type }));
  // The edit_page schema requires only `op`, so a Markdown operation can leave
  // `markdown` out. Read as an empty string it would erase the block
  // replace_block_markdown names. An explicit empty string is a stated
  // rewrite and is written. Checked before any operation of the batch runs.
  for (const op of operations)
    if (MARKDOWN_OPS.has(op.op) && typeof op.markdown !== "string")
      throw Error(`${op.op} requires a markdown string`);
  const imageTargets = new Set();
  for (const op of operations) {
    if (op.op !== "set_image") continue;
    validateImageChange(op);
    const target = JSON.stringify([op.block_id, op.image_id]);
    if (imageTargets.has(target)) throw Error("A batch cannot set the same image twice");
    imageTargets.add(target);
    if (!Object.hasOwn(doc.blocks, op.block_id)) throw Error("Block not found");
    resolveImageId(doc, op.block_id, op.image_id);
  }
  // Every occurrence names a match in the batch's starting snapshot, the one
  // the caller read. Resolve them all before any operation runs.
  const anchors = operations.map((op) => {
    if (!PASSAGE_OPS.has(op.op) || op.occurrence === undefined) return undefined;
    const id = op.block_id ?? op.id;
    if (!Object.hasOwn(doc.blocks, id)) throw Error("Block not found");
    return anchorOccurrence(doc, id, op);
  });
  const budget = { writes: 0 };
  const opened = new Set();
  const edits = [],
    inserted_images = [],
    inserted_nodes = [];
  for (const [index, op] of operations.entries()) {
    const edit = applyEdit(doc, op, trace, { anchor: anchors[index], budget, opened });
    if (edit?.op === "insert_image") {
      const { op: _op, ...image } = edit;
      inserted_images.push(image);
    } else if (edit?.op === "insert_node") {
      const { op: _op, ...node } = edit;
      inserted_nodes.push(node);
    } else if (edit) edits.push(edit);
  }
  dropOpeningMarkers(doc, opened);
  return {
    page_id: doc.page_id,
    ...(edits.length ? { edits } : {}),
    ...(inserted_images.length ? { inserted_images } : {}),
    ...(inserted_nodes.length ? { inserted_nodes } : {}),
  };
}

import * as A from "@automerge/automerge/slim";
import { textPath, updateSpansExactly } from "./richtext-format.mjs";
import { quotableNodeType } from "./richtext-notices.mjs";
import { markdownlessNode, newerContent, readableMarker } from "./richtext-spans.mjs";
import { nativeRead, readKind } from "./native-read.mjs";
import {
  repairBlockMarkers,
  setRichEmpty,
  setRichMarkdown,
  setRichMarkdownKeepingNodes,
  setRichImage,
  setRichNode,
  projectedBlock,
} from "./richtext-page.mjs";
import { nodeIds } from "./node-ids.mjs";
import { imageIds } from "./image-ids.mjs";
import { addressIndex, blockAddress, nodeAddresses, resolveAddressFor } from "./addresses.mjs";
import { updateSpansConfig } from "./marks.mjs";
import { stampSpans } from "./schema-features.mjs";
import { imageAssetUrl, validAssetId } from "../shared/image-assets.mjs";
import { MAX_PAGE_TITLE } from "../shared/page-title.mjs";
import { DATAFRAME_BLOCK, dataframeFor } from "../shared/dataset-assets.mjs";
import { projectComments } from "./comments.mjs";
import { COMMENTS_FEATURE } from "./comments-doc.mjs";
import { orderedBlockIds, positionForInsertion } from "./order.mjs";
import { anchorOccurrence, formatMatch, replaceMatch, withinNode } from "./replace-match.mjs";
import { setNode } from "./set-node.mjs";
import { listStartWarning } from "./list-start-warning.mjs";
import { insertOperation, insertedTypes } from "./node-registry.mjs";
import { RESERVED_VIEW_IDS, VIEW_BLOCK, VIEW_ID_PATTERN, validViewId } from "../shared/views.mjs";
import { stampFeatures } from "./schema-features.mjs";
export { orderedBlockIds } from "./order.mjs";
// A stored block holds its order and its text. Its id is its key in `blocks`.
// Its text is written in the change that adds it, and always opens with a
// node's marker: every writer below follows `block` with setRich*.
const block = (position = positionForInsertion()) => ({ position, richText: "" });
/** A new Page's root, with no blocks. initializePage adds the first one. */
export function createPageData({ pageId, title = "Untitled" }) {
  return {
    page_id: pageId,
    title: String(title).slice(0, 1024),
    blocks: {},
  };
}
/** A new Page's first change: its first block, holding `markdown` (one empty
 * paragraph when that is empty), and the stamp that says its comments live
 * in their own document (model/comments-doc.mjs). On a Page that already has
 * blocks, it rewrites the first one. `blockId` names a new block; a fixture
 * passes one to keep its history the same on every run. */
export function initializePage(doc, markdown = "", blockId = crypto.randomUUID()) {
  let id = orderedBlockIds(doc)[0];
  if (id === undefined) doc.blocks[(id = blockId)] = block();
  setRichMarkdown(doc, id, String(markdown));
  stampFeatures(doc, [COMMENTS_FEATURE]);
}
/** The Page as the viewer draws it: blocks in order without their Markdown.
 * The editor decodes each block's spans itself, so nothing here runs the
 * Markdown codec. projectPage is the agent projection; call it on demand for
 * export and Copy as Markdown. */
export function projectPageView(doc, commentsDoc) {
  return {
    page_id: doc.page_id,
    title: doc.title,
    blocks: orderedBlockIds(doc).map((id) => ({ id, position: doc.blocks[id].position })),
    comments: projectComments(doc, commentsDoc),
  };
}
/** `commentsDoc` is the Page's comments document, when it's available. */
export function projectPage(doc, commentsDoc) {
  return {
    page_id: doc.page_id,
    title: doc.title,
    blocks: orderedBlockIds(doc).map((id) => projectedBlock(doc, id)),
    comments: projectComments(doc, commentsDoc),
  };
}
/** Whether `value` is a valid after_node_id: omitted (append), null
 * (prepend) or an id. Its shape and kind are checked when it resolves. */
const afterAnchor = (value) => value === undefined || value === null || typeof value === "string";
export function validateImageInsertion(op) {
  if (
    !validAssetId(op.asset_id) ||
    (op.dark_asset_id !== undefined && !validAssetId(op.dark_asset_id)) ||
    (op.title !== undefined &&
      op.title !== null &&
      (typeof op.title !== "string" || op.title.length > 2048)) ||
    typeof op.alt !== "string" ||
    op.alt.length > 2048 ||
    !afterAnchor(op.after_node_id) ||
    Object.keys(op).some(
      (key) => !["op", "asset_id", "dark_asset_id", "alt", "title", "after_node_id"].includes(key),
    )
  )
    throw Error(
      "insert_image requires an uploaded asset_id, alt text (up to 2048 characters), and optional after_node_id",
    );
}
export function validateImageChange(op) {
  if (
    !op ||
    Object.keys(op).some(
      (key) => !["op", "node_id", "asset_id", "dark_asset_id", "alt", "title"].includes(key),
    ) ||
    typeof op.node_id !== "string" ||
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
      "set_image requires an image's node_id and asset_id, dark_asset_id (null removes), alt or title",
    );
}
const NODE_INSERTION_USAGE =
  'insert_node requires node: {type: "dataframe", attrs: {asset_id, title?, media_type?}} or {type: "view", attrs: {view_id}}, and optional after_node_id';
const isPlainObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);
/** The first key of `value` outside `keys`, or undefined. */
const extraKey = (value, keys) => Object.keys(value).find((key) => !keys.includes(key));
const quoted = (key) => `"${String(key).slice(0, 64)}"`;
// The attrs an agent gives each type insert_node creates, checked without a
// Page: `problem(attrs)` is why it may not store them, or null, and
// `stored(pageId, attrs)` is the node's stored attrs.
const NODE_INSERTIONS = Object.freeze({
  [DATAFRAME_BLOCK]: {
    problem: (attrs) => {
      if (!isPlainObject(attrs))
        return "a dataframe node's attrs must be {asset_id, title?, media_type?}";
      const extra = extraKey(attrs, ["asset_id", "media_type", "title"]);
      if (extra !== undefined)
        return `a dataframe node's attrs take asset_id, media_type and title, not ${quoted(extra)}`;
      if (!validAssetId(attrs.asset_id))
        return "attrs.asset_id is 64 lowercase hex characters: the asset_id an upload returned";
      // Title and media type rules live with the node, and throw their own.
      dataframeFor("00000000-0000-4000-8000-000000000000", attrs);
      return null;
    },
    stored: (pageId, attrs) => dataframeFor(pageId, attrs),
  },
  [VIEW_BLOCK]: {
    problem: (attrs) => {
      if (!isPlainObject(attrs)) return "a view node's attrs must be {view_id}";
      const extra = extraKey(attrs, ["view_id"]);
      if (extra !== undefined) return `a view node's attrs take view_id only, not ${quoted(extra)}`;
      if (attrs.view_id === undefined)
        return "a view node needs attrs.view_id: the view_id a set_view on this Page created";
      if (!validViewId(attrs.view_id))
        return `attrs.view_id must match ${VIEW_ID_PATTERN}, not ${RESERVED_VIEW_IDS}`;
      return null;
    },
    stored: (_pageId, attrs) => ({ view_id: attrs.view_id }),
  },
});
/** Why an insert_node operation can't run, checked without a Page: its
 * shape, the node type and the attrs an agent may set. Null when it can. */
function nodeInsertionProblem(op) {
  if (!isPlainObject(op)) return NODE_INSERTION_USAGE;
  const extra = extraKey(op, ["op", "node", "after_node_id"]);
  if (extra !== undefined)
    return `insert_node does not take ${String(extra).slice(0, 64)}; it takes node and after_node_id`;
  const node = op.node;
  if (!isPlainObject(node)) return NODE_INSERTION_USAGE;
  const extraNode = extraKey(node, ["type", "attrs"]);
  if (extraNode !== undefined)
    return `insert_node's node takes type and attrs, not ${quoted(extraNode)}`;
  const types = insertedTypes("insert_node");
  if (!types.includes(node.type))
    return `node.type must be ${types.join(" or ")}, not ${quoted(node.type)}`;
  if (!afterAnchor(op.after_node_id))
    return "after_node_id must be a block's id, or null to insert first";
  return NODE_INSERTIONS[node.type].problem(node.attrs);
}
/** Check an insert_node operation without a Page: its shape, the node type and
 * the attrs an agent may set. Returns the agent's attrs. */
export function validateNodeInsertion(op) {
  const problem = nodeInsertionProblem(op);
  if (problem) throw Error(problem);
  return op.node.attrs;
}
/** The view ids a batch's insert_node operations name, each once, in order.
 * Each operation is validated first; an invalid one throws. The host checks
 * every one is a view on the Page before the change. */
export function insertedViews(operations) {
  const views = [];
  for (const op of operations) {
    if (!insertOperation(op?.op)?.[op?.node?.type]?.view) continue;
    const { view_id } = validateNodeInsertion(op);
    if (!views.includes(view_id)) views.push(view_id);
  }
  return views;
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
    const name = op?.op;
    if (name === "set_image") {
      validateImageChange(op);
      for (const assetId of [op.asset_id, op.dark_asset_id].filter(Boolean)) {
        if (seen.has(assetId)) continue;
        seen.add(assetId);
        assets.push({ asset: "image", assetId });
      }
      continue;
    }
    const types = insertOperation(name);
    if (!types) continue;
    // insert_image creates one type; insert_node names its type.
    const insert = name === "insert_node" ? types[op?.node?.type] : Object.values(types)[0];
    if (!insert) {
      validateNodeInsertion(op);
      continue;
    }
    // A view names no asset; insertedViews lists the views to check.
    if (insert.view) {
      validateNodeInsertion(op);
      continue;
    }
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
// The fields each operation takes, for the operations with no validator of
// their own. The tool schema is one flat object for every operation, so it
// can't refuse a field that belongs to another one; this does. The image and
// node operations check their fields in validateImageInsertion,
// validateImageChange and validateNodeInsertion. set_node lists the
// shorthand names it refuses so model/set-node.mjs can answer with the
// attribute to use.
const LOCATOR = ["node_id", "match_text", "context_before", "context_after", "occurrence"];
const EDIT_FIELDS = new Map([
  ["set_title", ["title"]],
  ["replace_block_markdown", ["node_id", "markdown"]],
  ["insert_markdown", ["markdown", "after_node_id"]],
  ["move_block", ["node_id", "after_node_id"]],
  ["delete_block", ["node_id"]],
  ["delete_node", ["node_id"]],
  ["replace_match", [...LOCATOR, "replacement", "replacement_markdown"]],
  ["format_match", [...LOCATOR, "all", "add", "remove"]],
  ["set_node", [...LOCATOR, "type", "attrs", "checked", "language", "heading_level", "align"]],
]);
/** Refuse a field operation `op` doesn't take, and a Markdown operation
 * without a Markdown string. The flat schema marks no field required, so a
 * request that leaves `markdown` out reaches here; read as an empty string it
 * would erase the block replace_block_markdown names. An explicit empty
 * string is a stated rewrite and is written. */
export function validateEditFields(op) {
  const fields = EDIT_FIELDS.get(op.op);
  if (!fields) return;
  const unexpected = Object.keys(op).find((field) => !["op", ...fields].includes(field));
  if (unexpected) throw Error(`${op.op} does not take ${unexpected}`);
  if (fields.includes("markdown") && typeof op.markdown !== "string")
    throw Error(`${op.op} requires a markdown string`);
}
// The addresses each operation names, by field, and the kinds each field
// takes (model/addresses.mjs). Kinds are strict: no operation acts on the
// block that holds a node it was given. after_node_id takes a block's id;
// omitted appends and null prepends.
const BLOCK = ["block"];
const ADDRESSES = new Map([
  ["replace_block_markdown", [["node_id", BLOCK]]],
  ["delete_block", [["node_id", BLOCK]]],
  [
    "move_block",
    [
      ["node_id", BLOCK],
      ["after_node_id", BLOCK],
    ],
  ],
  ["insert_markdown", [["after_node_id", BLOCK]]],
  ["insert_image", [["after_node_id", BLOCK]]],
  ["insert_node", [["after_node_id", BLOCK]]],
  ["delete_node", [["node_id", ["node"]]]],
  ["set_image", [["node_id", ["image"]]]],
  ...[...PASSAGE_OPS].map((name) => [name, [["node_id", ["block", "node"]]]]),
]);
const anchorField = (field, value) => field === "after_node_id" && (value ?? null) === null;
/** The things `op` names, resolved in `index`'s document: `{ [field]:
 * resolved }` (resolveAddress), with an omitted or null after_node_id kept as
 * it is. Throws node_not_found or wrong_address_kind. */
function resolveOperation(index, doc, op) {
  const resolved = {};
  for (const [field, kinds] of ADDRESSES.get(op.op) ?? [])
    resolved[field] = anchorField(field, op[field])
      ? op[field]
      : resolveAddressFor(index, doc, op[field], { op: op.op, field, kinds });
  return resolved;
}
/** A passage operation's input for the matcher: scoped to its node when its
 * node_id names one, and to the whole block when it names a block. */
const scoped = (op, target) =>
  target.kind === "node" ? { ...op, [withinNode]: { start: target.start, end: target.end } } : op;
const afterKey = (anchor) => (anchor && typeof anchor === "object" ? anchor.key : anchor);

/** A new block's addresses, as an insert reports them so the next request
 * can name the block and its nodes without a read. */
const insertedBlock = (doc, op, key) => ({
  op,
  node_id: blockAddress(doc, key),
  nodes: nodeAddresses(doc, key),
});
// A Markdown write whose ordered lists restart at 1 says so in its entry; the
// receipt lists the warning with the edit it came from.
const withListWarning = (result, markdown) => {
  const warning = listStartWarning(markdown);
  return warning ? { ...result, warnings: [warning] } : result;
};

// `trace` records where each operation landed, for agent presence, by block
// key. It never enters the result, so stored receipts and retries are
// unchanged. `touched` collects the keys of the blocks an operation wrote,
// added, moved or deleted, which the caller's address index forgets.
function applyEdit(doc, op, at, { trace, touched, ...context }) {
  if (op.op === "set_title") {
    // null clears an image's title; a Page always has a title, "" included.
    if (typeof op.title !== "string")
      throw Error('set_title takes title as a string; "" leaves the Page untitled');
    // The limit is for new titles. A title already stored longer (a browser
    // merge admits one) can be sent back unchanged, as in a batch that
    // echoes it, and writes nothing.
    if (op.title === String(doc.title ?? "")) return;
    if (op.title.length > MAX_PAGE_TITLE)
      throw Error(
        `set_title's title is at most ${MAX_PAGE_TITLE} characters; this one has ${op.title.length}`,
      );
    A.updateText(doc, ["title"], op.title);
    return;
  }
  if (op.op === "insert_markdown") {
    const key = crypto.randomUUID();
    doc.blocks[key] = block(positionForInsertion(doc, afterKey(at.after_node_id)));
    setRichMarkdown(doc, key, op.markdown);
    touched.push(key);
    trace?.push({ type: "block", block_id: key });
    return withListWarning(insertedBlock(doc, "insert_markdown", key), op.markdown);
  }
  if (op.op === "insert_image") {
    validateImageInsertion(op);
    const key = crypto.randomUUID();
    const asset_url = imageAssetUrl(doc.page_id, op.asset_id);
    doc.blocks[key] = block(positionForInsertion(doc, afterKey(at.after_node_id)));
    const dark_src = op.dark_asset_id ? imageAssetUrl(doc.page_id, op.dark_asset_id) : null;
    setRichImage(doc, key, { src: asset_url, dark_src, alt: op.alt, title: op.title });
    touched.push(key);
    trace?.push({ type: "block", block_id: key });
    return {
      ...insertedBlock(doc, "insert_image", key),
      image: imageIds(doc, key)[0].id,
      asset_id: op.asset_id,
      asset_url,
      ...(dark_src && { dark_asset_id: op.dark_asset_id, dark_src }),
      ...(op.title !== undefined && { title: op.title }),
      alt: op.alt,
    };
  }
  if (op.op === "insert_node") {
    const input = validateNodeInsertion(op);
    const key = crypto.randomUUID();
    const attrs = NODE_INSERTIONS[op.node.type].stored(doc.page_id, input);
    doc.blocks[key] = block(positionForInsertion(doc, afterKey(at.after_node_id)));
    setRichNode(doc, key, { type: op.node.type, attrs });
    touched.push(key);
    trace?.push({ type: "block", block_id: key });
    return {
      ...insertedBlock(doc, "insert_node", key),
      type: op.node.type,
      attrs: { ...input, ...attrs },
    };
  }
  const target = at.node_id;
  if (!target) throw Error("Unsupported edit operation");
  const id = target.key;
  touched.push(id);
  if (op.op === "set_image") {
    validateImageChange(op);
    const spans = A.spans(doc, textPath(id));
    const { index } = target;
    if (!readableMarker(spans[index].value))
      throw newerContent(
        "This image holds values from a newer version of Pages that this version can't read, so set_image can't change it. Remove it with delete_node, or remove its block with delete_block and the block's id.",
      );
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
    updateSpansExactly(doc, textPath(id), spans, updateSpansConfig);
    stampSpans(doc, spans);
    trace?.push({ type: "block", block_id: id });
    return { op: "set_image", node_id: op.node_id, block: blockAddress(doc, id) };
  }
  if (op.op === "move_block") {
    const after = afterKey(at.after_node_id);
    if (after !== id) doc.blocks[id].position = positionForInsertion(doc, after, id);
    trace?.push({ type: "block", block_id: id });
    return;
  }
  if (PASSAGE_OPS.has(op.op)) {
    const input = scoped(op, target);
    const edit =
      op.op === "replace_match"
        ? replaceMatch(doc, id, input, trace, context)
        : op.op === "format_match"
          ? formatMatch(doc, id, input, trace, context)
          : setNode(doc, id, input, trace, context);
    const { op: name, ...rest } = edit;
    return { op: name, node_id: op.node_id, ...rest };
  }
  if (op.op === "replace_block_markdown") {
    const node = markdownlessNode(doc.blocks[id], doc.page_id);
    if (node)
      throw Object.assign(
        Error(
          `This block holds ${quotableNodeType(node) ? `${/^[aeiou]/.test(node) ? "an" : "a"} ${node}` : "a node this version of Pages doesn't know"}, which has no Markdown form, so a Markdown rewrite would lose it. Remove it with delete_node, or with delete_block and the block's id when read_page reports no node_id for it. edit_page still edits text in the nodes this version reads; it answers newer_content for text in the node itself.`,
        ),
        { code: "markdownless_node" },
      );
    // A dataframe's read-back line, left unchanged, keeps the node. Runs
    // after the unknown-node refusal: with no dataframe in the block it
    // falls through to a plain rewrite.
    setRichMarkdownKeepingNodes(doc, id, op.markdown);
    trace?.push({ type: "block", block_id: id });
    return withListWarning(
      { op: "replace_block_markdown", node_id: op.node_id, nodes: nodeAddresses(doc, id) },
      op.markdown,
    );
  }
  if (op.op === "delete_block") {
    delete doc.blocks[id];
    return;
  }
  if (op.op === "delete_node") return deleteNode(doc, op, target, trace);
  throw Error("Unsupported edit operation");
}
/** Delete the top-level node `target` names: its marker through the next
 * node's marker, so its text, marks and children go with it and its
 * neighbours keep their identity. Refused when the block ends up with fewer
 * than one node less: a list has no marker of its own to keep it apart, so
 * two alike on either side of the deleted node would join into one.
 * Deleting a block's only node leaves the one empty paragraph a block always
 * has, with a marker of its own, and keeps the block: removing the block's
 * map entry would discard what a peer writes into it concurrently. An agent
 * that wants the block gone uses delete_block. */
function deleteNode(doc, op, { key: id, index, start, end }, trace) {
  const tree = nativeRead(doc.blocks[id], doc.page_id);
  // The node's type comes from the readable tree, which must name the same
  // nodes as the stored markers.
  try {
    nodeIds(doc, id, tree);
  } catch {
    throw Object.assign(
      Error(
        "This block holds nodes this version of Pages reads differently from how they're stored, so delete_node can't remove one. Use delete_block with the block's id, or rewrite the block with replace_block_markdown.",
      ),
      { code: "node_not_found" },
    );
  }
  const type = readKind(tree.nodes[index]);
  A.splice(doc, textPath(id), start, end - start);
  if (!doc.blocks[id].richText.length) setRichEmpty(doc, id);
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
  trace?.push({ type: "block", block_id: id });
  return { op: "delete_node", node_id: op.node_id, block: blockAddress(doc, id), type };
}
export function applyPageOperation(doc, options) {
  const result = applyOperation(doc, options);
  // Every write repairs a stamp left incomplete by concurrent first stamps.
  stampFeatures(doc);
  return result;
}
/** The block key an address names, or undefined, before any refusal: the
 * block itself, or the block holding the node or image. */
const blockOf = (index, address) =>
  typeof address === "string" ? (index.block(address) ?? index.find(address)?.key) : undefined;

function applyOperation(doc, { operation, arguments: args = {}, trace }) {
  // Comments are written to the comments document, never the Page.
  if (operation !== "edit_page") throw Error("Unsupported Page operation");
  if (!Array.isArray(args.operations) || args.operations.length > 100)
    throw Error("Provide up to 100 operations");
  if (args.operations.some((op) => !op || typeof op !== "object" || Array.isArray(op)))
    throw Error("Each operation is an object with an op");
  const { operations } = args;
  for (const op of operations) validateEditFields(op);
  const index = addressIndex(doc);
  // Every block the batch edits has its markers repaired first, in this
  // change: nodes stored under parents no writer wrote get the parents they
  // are drawn with, and unmarked text gets its marker, so every node an
  // operation resolves has one. Repair changes no visible text or node, so
  // the matches and ids the caller read still hold.
  for (const op of operations) {
    const key = op.op === "delete_block" ? undefined : blockOf(index, op.node_id);
    if (key === undefined) continue;
    repairBlockMarkers(doc, key);
    index.forget(key);
  }
  // Every address names something live, of the kind its operation takes,
  // before any operation runs.
  const imageTargets = new Set();
  const starts = operations.map((op) => {
    if (op.op === "set_image") {
      validateImageChange(op);
      if (imageTargets.has(op.node_id)) throw Error("A batch cannot set the same image twice");
      imageTargets.add(op.node_id);
    }
    return resolveOperation(index, doc, op);
  });
  // Every occurrence names a match in the batch's starting snapshot, the one
  // the caller read. Resolve them all before any operation runs.
  const anchors = operations.map((op, i) => {
    if (!PASSAGE_OPS.has(op.op) || op.occurrence === undefined) return undefined;
    const target = starts[i].node_id;
    return anchorOccurrence(doc, target.key, scoped(op, target));
  });
  const budget = { writes: 0 };
  const edits = [];
  for (const [i, op] of operations.entries()) {
    // Resolved again where the batch has reached: an earlier operation can
    // move the node's range, or delete what this one names.
    const touched = [];
    const edit = applyEdit(doc, op, i ? resolveOperation(index, doc, op) : starts[i], {
      trace,
      touched,
      anchor: anchors[i],
      budget,
    });
    for (const key of touched) index.forget(key);
    if (edit) edits.push(edit);
  }
  return { page_id: doc.page_id, ...(edits.length ? { edits } : {}) };
}

import { orderedBlockIds } from "./order.mjs";
import { readableNodeIds } from "./node-ids.mjs";
import { readableImageIds } from "./image-ids.mjs";
import { DATAFRAME_TITLE_MAX, parseAssetPath, readDataframe } from "../shared/dataset-assets.mjs";
import { readViewNode } from "../shared/views.mjs";
import { headingAnchorsByBlock } from "./heading-anchors.mjs";
import { quotableNodeType } from "./richtext-notices.mjs";
import {
  nativeRead,
  readMarkdown,
  readKind,
  readChildren,
  readDescendants,
  readVisibleText,
} from "./native-read.mjs";
import { Alignment, CodeBlockLanguage, TaskChecked } from "./wordgard-doc.mjs";
import { blockMarkdown } from "./richtext-page.mjs";
import { addressIndex, addressKind, blockAddress } from "./addresses.mjs";

const utf8 = new TextEncoder();
const fail = (status, code, message, details) => {
  throw Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });
};
const invalid = (message) => fail(400, "invalid_read_selector", message);
const missing = (message) => fail(404, "read_target_not_found", message);
const boundedString = (value, max) =>
  typeof value === "string" && value.length > 0 && value.length <= max;

function validateSelectors(doc, args) {
  if (!args || typeof args !== "object" || Array.isArray(args))
    invalid("Read arguments must be an object");
  if (args.include_content !== undefined && typeof args.include_content !== "boolean")
    invalid("include_content must be a boolean");
  if (args.section !== undefined && args.search !== undefined)
    invalid("Use only one of section or search");
  if (
    args.node_ids !== undefined &&
    (!Array.isArray(args.node_ids) ||
      args.node_ids.length < 1 ||
      args.node_ids.length > 100 ||
      args.node_ids.some((id) => typeof id !== "string") ||
      new Set(args.node_ids).size !== args.node_ids.length)
  )
    invalid("node_ids must contain 1 to 100 unique ids from read_page");
  if (args.section !== undefined && !boundedString(args.section, 1024))
    invalid("section must be a nonempty heading text of up to 1024 characters");
  if (
    args.section_occurrence !== undefined &&
    (args.section === undefined ||
      !Number.isSafeInteger(args.section_occurrence) ||
      args.section_occurrence < 1)
  )
    invalid("section_occurrence requires section and a positive one-based integer");
  if (
    args.search !== undefined &&
    (!Array.isArray(args.search) ||
      args.search.length < 1 ||
      args.search.length > 8 ||
      args.search.some((term) => !boundedString(term, 512)))
  )
    invalid("search must contain 1 to 8 nonempty literal strings of up to 512 characters");
  if (
    args.context_nodes !== undefined &&
    (args.search === undefined ||
      !Number.isInteger(args.context_nodes) ||
      args.context_nodes < 0 ||
      args.context_nodes > 2)
  )
    invalid("context_nodes requires search and an integer from 0 to 2");
}

/** What `node_ids` names: the keys of the blocks it names, and the
 * addresses of the nodes it names. A block's id selects the block, a node's
 * id the node. With section or search it names blocks only, which scope
 * them. */
function namedAddresses(doc, args) {
  if (args.node_ids === undefined) return null;
  const index = addressIndex(doc);
  const blocks = new Set(),
    nodes = new Set();
  for (const id of args.node_ids) {
    let resolved;
    try {
      resolved = addressKind(index, id);
    } catch (error) {
      if (error.code === "node_not_found") missing(`Nothing in this Page has node_id ${id}`);
      invalid(error.message.replace("node_id must", "Each node_ids entry must"));
    }
    if (resolved.kind === "image")
      fail(
        400,
        "wrong_address_kind",
        `${id} names an image; read_page reports it in its node's summary.images. node_ids takes a block's or a node's id.`,
      );
    if (resolved.kind === "block") blocks.add(resolved.key);
    else if (args.section !== undefined || args.search !== undefined)
      invalid("With section or search, node_ids takes block ids only");
    else nodes.add(id);
  }
  return { blocks, nodes };
}

const visibleText = readVisibleText;

const markdownFor = readMarkdown;

// Every top-level rich-text node of this captured document version, in
// order; lists, tables and other containers stay intact. node_id
// (model/node-ids.mjs) is the node's stable name, where it has one, and
// block its block's (model/addresses.mjs).
function indexNodes(doc) {
  const nodes = [],
    trees = new Map(),
    headings = [],
    anchorsByBlock = headingAnchorsByBlock(doc);
  for (const blockId of orderedBlockIds(doc)) {
    const tree = nativeRead(doc.blocks[blockId], doc.page_id),
      block = blockAddress(doc, blockId),
      ids = readableNodeIds(doc, blockId, tree),
      imageIds = readableImageIds(doc, blockId, tree),
      anchors = blockAnchors(tree, anchorsByBlock.get(blockId) ?? []);
    trees.set(blockId, tree);
    tree.nodes.forEach((node, nodeIndex) => {
      const entry = {
        blockId,
        block,
        nodeIndex,
        node,
        nodeId: ids[nodeIndex]?.id ?? null,
        imageIds,
        metadata: tree.metadata,
      };
      if (readKind(node) === "heading") {
        entry.heading = visibleText(node);
        entry.level = node.tag.param;
        entry.anchor = anchors.get(nodeIndex);
        while (headings.length && headings.at(-1).level >= entry.level) headings.pop();
        headings.push(entry);
      }
      entry.headingPath = headings.map((heading) => heading.heading);
      nodes.push(entry);
    });
  }
  return { nodes, trees };
}

/** Each top-level heading's anchor (model/heading-anchors.mjs), by node
 * index. Anchors count every heading in the block's spans, nested ones too,
 * so they're matched to the tree by ordinal. A block whose tree draws a
 * different number of headings than its spans hold (a node this build reads
 * as a notice) reports none rather than a wrong one. */
function blockAnchors(tree, anchors) {
  const byIndex = new Map();
  let ordinal = 0;
  tree.nodes.forEach((node, nodeIndex) => {
    if (readKind(node) === "heading") byIndex.set(nodeIndex, anchors[ordinal++]);
    else
      readDescendants(node, (child) => {
        if (readKind(child) === "heading") ordinal++;
      });
  });
  return ordinal === anchors.length ? byIndex : new Map();
}

/** The most per-item values (task states, column alignments) an outline
 * entry lists. One entry can't be split across outline pages, so its size
 * stays bounded; the change feed, which already carries the node's Markdown,
 * lists them all. */
export const OUTLINE_MAX_ITEMS = 200;

const bounded = (name, values, max) =>
  values.length > max
    ? { [name]: values.slice(0, max), [`${name}_truncated`]: true }
    : { [name]: values };

/** The typed read of a top-level node, as fields to spread into an outline
 * entry or a changed node:
 *
 * - `attrs`: the node's own stored attributes, under the names set_node and
 *   insert_node take (`level`, `language`, a dataframe's `asset_id`).
 * - `summary`: values computed from the node's children (a task list's
 *   states, a table's size and column alignment), or for a view, its
 *   view's `title` and `media_type` when `viewSummary(view_id)` reads them.
 * - `node_type`: the type of a node this build doesn't know.
 * - `readable: false`: a dataframe this build can't show. richDoc already
 *   reads one naming another Page's asset as a notice paragraph, so this is
 *   the backstop if one reaches here: nothing of its stored attrs is
 *   reported.
 *
 * Nested lists read as their own Markdown. `maxItems` bounds per-item
 * arrays. */
export function nodeFields(
  node,
  { pageId, maxItems = Infinity, imageIds, metadata, viewSummary } = {},
) {
  // Child-index paths are relative to this top-level node at the read revision,
  // not stable identities. Image occurrences stay bounded even in change feeds.
  const fields = ownNodeFields(node, { pageId, maxItems, metadata, viewSummary });
  const images = [];
  let count = 0;
  const limit = Math.min(maxItems, OUTLINE_MAX_ITEMS);
  const visit = (child, path) => {
    if (readKind(child) === "image") {
      count++;
      if (images.length < limit) {
        const { src, dark_src, alt, title } = child.param;
        const asset = parseAssetPath(src);
        const darkAsset = parseAssetPath(dark_src);
        images.push({
          path,
          node_id: imageIds?.get(child) ?? null,
          src: String(src ?? "").slice(0, 4096),
          alt: String(alt ?? "").slice(0, 2048),
          title: title == null ? null : String(title).slice(0, 2048),
          ...(dark_src != null && { dark_src: String(dark_src).slice(0, 4096) }),
          ...(darkAsset &&
            (!pageId || darkAsset.pageId === pageId) && { dark_asset_id: darkAsset.assetId }),
          ...(asset && (!pageId || asset.pageId === pageId) && { asset_id: asset.assetId }),
          ...(String(src ?? "").length > 4096 ||
          String(alt ?? "").length > 2048 ||
          String(title ?? "").length > 2048 ||
          String(dark_src ?? "").length > 4096
            ? { truncated: true }
            : {}),
        });
      }
    }
    readChildren(child).forEach((nested, index) => visit(nested, [...path, index]));
  };
  visit(node, []);
  if (count)
    fields.summary = {
      ...fields.summary,
      images,
      ...(count > images.length && { images_truncated: true }),
    };
  return fields;
}

function ownNodeFields(node, { pageId, maxItems, metadata, viewSummary }) {
  switch (readKind(node)) {
    case "view": {
      const value = readViewNode(node.param);
      if (!value) return { readable: false };
      const view = viewSummary?.(value.view_id);
      return {
        attrs: { view_id: value.view_id },
        ...(view && { summary: { title: view.title, media_type: view.media_type } }),
      };
    }
    case "heading":
      return { attrs: { level: node.tag.param } };
    case "code-block":
      return { attrs: { language: String(node.mark(CodeBlockLanguage) ?? "") } };
    case "task-list": {
      const checked = [];
      node.content.forEach((item) => checked.push(item.mark(TaskChecked) === true));
      return {
        summary: {
          items: checked.length,
          checked_count: checked.filter(Boolean).length,
          ...bounded("checked", checked, maxItems),
        },
      };
    }
    case "table": {
      // As wide as its widest row, like its Markdown; a concurrent structural
      // edit can leave rows ragged. Alignment comes from the first row.
      let columns = 0;
      node.content.forEach((row) => (columns = Math.max(columns, row.content.length)));
      const align = Array.from({ length: columns }, () => null);
      node.content[0]?.content.forEach(
        (cell, index) =>
          (align[index] = metadata?.get(cell)?.align ?? cell.mark(Alignment) ?? null),
      );
      return {
        summary: { rows: node.content.length, columns, ...bounded("align", align, maxItems) },
      };
    }
    case "dataframe": {
      // The same check the Markdown projection and the viewer make: a
      // dataframe is readable only when it names an asset on this Page.
      const value = readDataframe(node.param);
      const asset = value && parseAssetPath(value.src);
      if (!value || (!value.binding && (!asset || (pageId && asset.pageId !== pageId))))
        return { readable: false };
      return {
        attrs: {
          ...(value.binding
            ? { binding: value.binding }
            : { asset_id: asset.assetId, src: value.src }),
          media_type: value.media_type,
          // Writers cap a title; a peer-written one can be longer.
          title: value.title?.slice(0, DATAFRAME_TITLE_MAX) ?? null,
        },
      };
    }
    case "unknown":
      return {
        node_type: quotableNodeType(node.tag.param?.type ?? node.tag.param),
      };
    default:
      return {};
  }
}

function outlineEntry(entry, pageId, viewSummary) {
  return {
    // Stable across edits. Null for a paragraph of unmarked text, which a
    // merge can leave and the next write to the block marks, and in a block
    // holding a node this build can't place (readableNodeIds).
    node_id: entry.nodeId,
    // A block's first node names the block; the entries after it, up to the
    // next one that names a block, are in the same block.
    ...(entry.nodeIndex === 0 && { block: entry.block }),
    // The agent-facing name set_node and insert_node take (node-registry.mjs).
    type: readKind(entry.node),
    heading_path: entry.headingPath,
    // Bytes of this node's standalone Markdown projection, excluding inter-node separators.
    markdown_bytes: utf8.encode(markdownFor([entry.node])).byteLength,
    ...(entry.heading !== undefined
      ? {
          heading: entry.heading,
          level: entry.level,
          // Link to it as [text](#anchor) on this Page, /p/<page_id>#anchor elsewhere.
          ...(entry.anchor !== undefined && { anchor: entry.anchor }),
        }
      : {}),
    ...nodeFields(entry.node, {
      pageId,
      maxItems: OUTLINE_MAX_ITEMS,
      imageIds: entry.imageIds,
      metadata: entry.metadata,
      viewSummary,
    }),
  };
}

function selectedNodes(nodes, args, inScope) {
  if (args.section !== undefined) {
    const candidates = nodes.filter((entry) => inScope(entry) && entry.heading === args.section);
    if (!candidates.length) missing("Section heading not found");
    if (candidates.length > 1 && args.section_occurrence === undefined)
      fail(
        409,
        "ambiguous_section",
        "Section heading occurs more than once; choose section_occurrence",
        {
          total: candidates.length,
          candidates: candidates.slice(0, 20).map((entry) => ({
            node_id: entry.nodeId,
            level: entry.level,
          })),
        },
      );
    const occurrence = args.section_occurrence ?? 1,
      start = candidates[occurrence - 1];
    if (!start) missing("Section occurrence not found");
    const from = nodes.indexOf(start);
    let to = from + 1;
    while (to < nodes.length && !(nodes[to].level <= start.level)) to++;
    return {
      nodes: nodes.slice(from, to).filter(inScope),
      selection: { type: "section", section: args.section, section_occurrence: occurrence },
    };
  }
  if (args.search !== undefined) {
    const context = args.context_nodes ?? 1,
      included = new Set();
    let matched = 0;
    nodes.forEach((entry, index) => {
      if (!inScope(entry)) return;
      const text = visibleText(entry.node);
      if (!args.search.some((term) => text.includes(term))) return;
      matched++;
      for (
        let i = Math.max(0, index - context);
        i <= Math.min(nodes.length - 1, index + context);
        i++
      )
        if (inScope(nodes[i])) included.add(nodes[i]);
    });
    return {
      nodes: nodes.filter((entry) => included.has(entry)),
      selection: {
        type: "search",
        search: [...args.search],
        context_nodes: context,
        matched_nodes: matched,
      },
    };
  }
  return { nodes: nodes.filter(inScope) };
}

/** A whole block as an agent reads it. */
export const agentBlock = (doc, key) => ({
  node_id: blockAddress(doc, key),
  position: doc.blocks[key].position,
  markdown: blockMarkdown(doc.blocks[key], doc.page_id),
});

/** Runs of consecutive selected nodes in one block, as partial blocks: the
 * block's id, its position, the run's Markdown and the run's node ids (null
 * for a node with no id). */
function projectedSlices(doc, nodes) {
  const slices = [];
  for (const entry of nodes) {
    const prior = slices.at(-1);
    if (prior?.blockId === entry.blockId && prior.to === entry.nodeIndex) {
      prior.to++;
      prior.entries.push(entry);
    } else slices.push({ blockId: entry.blockId, to: entry.nodeIndex + 1, entries: [entry] });
  }
  return slices.map(({ blockId, entries }) => ({
    node_id: entries[0].block,
    position: doc.blocks[blockId].position,
    markdown: markdownFor(entries.map((entry) => entry.node)),
    partial: true,
    nodes: entries.map((entry) => entry.nodeId),
  }));
}

/** A node node_ids names, read whole: its Markdown and every typed field,
 * with no per-item cap, as the change feed reports a node. */
const namedNode = (entry, pageId, viewSummary) => ({
  node_id: entry.nodeId,
  block: entry.block,
  type: readKind(entry.node),
  heading_path: entry.headingPath,
  markdown: markdownFor([entry.node]),
  ...nodeFields(entry.node, {
    pageId,
    imageIds: entry.imageIds,
    metadata: entry.metadata,
    viewSummary,
  }),
});

/** Pure projection of one captured Automerge document. The caller binds the
 * response to its heads and enforces response/outline budgets. No bytes are
 * silently omitted here. Wrapper-only options are deliberately ignored.
 * `nodes` is present when node_ids names a node. `viewSummary(view_id)` is
 * the `{ title, media_type }` of one of the Page's views, or undefined.
 */
export function projectReadContent(doc, args = {}, { viewSummary } = {}) {
  validateSelectors(doc, args);
  const named = namedAddresses(doc, args),
    { nodes, trees } = indexNodes(doc),
    inScope = (entry) => !named || named.blocks.has(entry.blockId) || named.nodes.has(entry.nodeId),
    chosen = selectedNodes(nodes, args, inScope),
    outline = nodes.filter(inScope).map((entry) => outlineEntry(entry, doc.page_id, viewSummary)),
    content = args.include_content !== false,
    selectedNodeEntries = named ? nodes.filter((entry) => named.nodes.has(entry.nodeId)) : [];
  if (named && selectedNodeEntries.length !== named.nodes.size)
    missing("A node in node_ids has no id in this build's reading of its block");
  const blocks = !content
    ? []
    : chosen.selection
      ? projectedSlices(doc, chosen.nodes)
      : [...trees.keys()]
          .filter((key) => !named || named.blocks.has(key))
          .map((key) => agentBlock(doc, key));
  return {
    blocks,
    ...(named?.nodes.size && {
      nodes: content
        ? selectedNodeEntries.map((entry) => namedNode(entry, doc.page_id, viewSummary))
        : [],
    }),
    outline,
    ...(chosen.selection
      ? { selection: chosen.selection }
      : named
        ? { selection: { type: "nodes", node_ids: [...args.node_ids] } }
        : {}),
  };
}

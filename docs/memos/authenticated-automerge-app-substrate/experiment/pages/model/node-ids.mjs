// Node ids: a stable name for a top-level node in a rich-text block.
//
// A top-level node (a paragraph, heading, list, quote, table, rule or
// dataframe) opens with a block marker: a character in the block's text. A
// node's id is an Automerge cursor at that marker. It survives edits to the
// node's text and marks, insertions before it, and concurrent edits
// elsewhere, because a cursor names the marker character itself, not an
// offset. It stops resolving once the marker is deleted, which is when the
// node is gone (or retyped by a writer that replaces markers).
//
// A list has no marker of its own: its id is the marker of its first item,
// and changes when that item is deleted or moved. Pages and the editor write
// a quote's own marker, but content in the ProseMirror adapter's form can
// lack it when the quote's first child isn't a paragraph; that quote's id is
// its first child's, the same way. A Markdown rewrite diffs the block and can replace markers, so it
// can mint new ids.
//
// The block's implicit first paragraph has no marker, so it has no id
// (null). Inline embeds (images, line breaks) are markers too, but they sit
// inside a node and never open one.
//
// An id is meaningful only with its block_id: cursors are per text object.
import * as A from "@automerge/automerge/slim";
import { eventsWithIndexChanges, traverseSpans } from "@automerge/prosemirror/dist/traversal.js";
import { pmDocFromSpans } from "@automerge/prosemirror";
import { adapter, codeTextUnmarked, richDoc, textPath } from "./richtext.mjs";

// A cursor is `<counter>@<actor hex>`; Pages accepts actors of up to 64 bytes
// (worker/actor-authorship.mjs), 128 hex characters.
export const MAX_NODE_ID = 192;

/** For each top-level node of rich block `blockId`, in order: `{ id, at }`,
 * the cursor at its opening marker and that marker's index in the text, or
 * `{ id: null, at: null }` for the implicit first paragraph. `tree` is the
 * block's richDoc, when the caller already has it; the ids line up with its
 * nodes. Throws when the binding can't place a stored marker. */
export function nodeIds(doc, blockId, tree = richDoc(doc.blocks[blockId], doc.page_id)) {
  const path = textPath(blockId);
  // Ranges come from the stored spans, the ones the traversal walks. richDoc
  // can read a node through notice text (a dataframe naming another Page's
  // asset), which changes its size but never the number of top-level nodes.
  const spans = codeTextUnmarked(A.spans(doc, path));
  const stored = pmDocFromSpans(adapter, spans);
  if (stored.childCount !== tree.childCount)
    throw Error("The stored and readable trees disagree on top-level nodes");
  const ranges = [];
  stored.forEach((node, offset) =>
    ranges.push({ end: offset + node.nodeSize, id: null, at: null }),
  );
  // One pass over the binding's indexed traversal. A node's opening marker is
  // the first non-embed block marker inside its ProseMirror range.
  let index = 0;
  let leafClosures = 0;
  for (const state of eventsWithIndexChanges(traverseSpans(adapter, spans))) {
    // The binding can emit open/close tags for leaves such as rules. A PM
    // leaf occupies one position, so its closing tag adds no width.
    if (state.event.type === "closeTag" && adapter.schema.nodes[state.event.tag].isLeaf)
      leafClosures++;
    while (index < ranges.length && state.after.pmIdx - leafClosures >= ranges[index].end)
      index++;
    const range = ranges[index];
    if (!range || range.at !== null) continue;
    if (state.event.type !== "block" || state.event.block.isEmbed) continue;
    range.at = state.after.amIdx;
    range.id = A.getCursor(doc, path, range.at);
  }
  return ranges.map(({ id, at }) => ({ id, at }));
}

/** nodeIds, or no ids (all null) when the binding can't place one of the
 * block's markers: a node a newer build wrote inside a table cell, say.
 * richDoc still reads such a block, through text it rewrites, so its
 * positions don't name stored markers and no id is better than a wrong one. */
export function readableNodeIds(doc, blockId, tree) {
  try {
    return nodeIds(doc, blockId, tree);
  } catch {
    return Array.from({ length: tree.childCount }, () => ({ id: null, at: null }));
  }
}

const notFound = (message) => Object.assign(Error(message), { code: "node_not_found" });

/** The top-level node `nodeId` names in block `blockId`: its index among the
 * block's top-level nodes and its text range `[start, end)`, from its marker
 * to the next node's marker. Throws `node_not_found` when the id doesn't name
 * a live top-level node in this block. */
export function resolveNodeId(doc, blockId, nodeId, tree) {
  if (typeof nodeId !== "string" || !nodeId || nodeId.length > MAX_NODE_ID)
    throw Error(`node_id must be a string of up to ${MAX_NODE_ID} characters from read_page`);
  let ids;
  try {
    ids = nodeIds(doc, blockId, tree);
  } catch {
    throw notFound(
      "This block holds a node this version of Pages can't place, so its nodes have no ids. Use delete_block, or edit around it with patch_page.",
    );
  }
  const index = ids.findIndex((entry) => entry.id === nodeId);
  if (index < 0)
    throw notFound(
      "node_id doesn't name a node in this block: it was deleted, or it came from another block. Read the outline again for current ids.",
    );
  const length = A.spans(doc, textPath(blockId)).reduce(
    (total, span) => total + (span.type === "text" ? span.value.length : 1),
    0,
  );
  return { index, ...nodeRange(ids, index, length) };
}

/** The text range `[start, end)` of node `index`: its marker up to the next
 * node's marker, or to the end of the text for the last node. A node with no
 * marker after the first can't bound the range, so that's refused rather
 * than letting the range run on over the nodes after it. */
export function nodeRange(ids, index, length) {
  const next = ids[index + 1];
  if (next && next.at === null)
    throw Error(
      "delete_node can't tell where this node ends: the node after it has no marker. Edit the block with replace_block_markdown or delete_block instead.",
    );
  return { start: ids[index].at, end: next ? next.at : length };
}

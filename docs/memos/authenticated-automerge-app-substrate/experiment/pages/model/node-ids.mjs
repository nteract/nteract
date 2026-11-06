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
// and changes when that item is deleted or moved. A quote has its own
// marker. A Markdown rewrite diffs the block and can replace markers, so it
// can mint new ids.
//
// The block's implicit first paragraph has no marker, so it has no id
// (null). Inline embeds (images, line breaks) are markers too, but they sit
// inside a node and never open one.
//
// An id is meaningful only with its block_id: cursors are per text object.
import * as A from "@automerge/automerge/slim";
import { textPath } from "./richtext-format.mjs";
import { blockAddresses } from "./node-addresses.mjs";

// A cursor is `<counter>@<actor hex>`; Pages accepts actors of up to 64 bytes
// (worker/actor-authorship.mjs), 128 hex characters.
export const MAX_NODE_ID = 192;

/** For each top-level node of rich block `blockId`, in order: `{ id, at }`,
 * the cursor at its opening marker and that marker's index in the text, or
 * `{ id: null, at: null }` for the implicit first paragraph. Addresses come
 * from the stored spans (model/node-addresses.mjs). `tree` is the block's
 * richDoc, when the caller pairs the ids with its nodes; the ids line up with
 * them, or this throws. Also throws when the block holds a node this build
 * can't place where it was stored. */
export function nodeIds(doc, blockId, tree) {
  const path = textPath(blockId);
  const { nodes, placed } = blockAddresses(A.spans(doc, path));
  if (!placed) throw Error("This block holds a node this build can't place");
  // richDoc can read a node through notice text (a dataframe naming another
  // Page's asset), which changes its size but never the number of top-level
  // nodes.
  if (tree && tree.childCount !== nodes.length)
    throw Error("The stored and readable trees disagree on top-level nodes");
  return nodes.map(({ at }) => ({ id: at === null ? null : A.getCursor(doc, path, at), at }));
}

/** nodeIds, or no ids (all null) when the block holds a node this build
 * can't place: a node a newer build wrote inside a table cell, say. richDoc
 * still reads such a block, through text it rewrites, so its positions don't
 * name stored markers and no id is better than a wrong one. */
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

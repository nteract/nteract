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
// Every writer opens every node with a marker, the block's first node
// included, so every written node has an id. A paragraph of unmarked text,
// which only a merge leaves (decode in model/wordgard-doc.mjs), has none
// (null) until the next host write to its block marks it. Inline embeds
// (images, line breaks) are markers too, but they sit inside a node and
// never open one.
//
// Ids are unique across the document; model/addresses.mjs resolves one to
// its block by comparing it with the ids minted from the live document.
import * as A from "@automerge/automerge/slim";
import { textPath } from "./richtext-format.mjs";
import { blockAddresses } from "./node-addresses.mjs";

// A cursor is `<counter>@<actor hex>`; Pages accepts actors of up to 64 bytes
// (worker/actor-authorship.mjs), 128 hex characters.
export const MAX_NODE_ID = 192;

/** For each top-level node of rich block `blockId`, in order: `{ id, at,
 * end }`, the cursor at its opening marker, that marker's index in the text
 * and where the node's text ends (the next node's start as the reader draws
 * it, unmarked text included), or `{ id: null, at: null, end }` for a
 * paragraph of unmarked text. Addresses come from the stored spans (model/node-addresses.mjs). `tree` is the block's
 * richDoc, when the caller pairs the ids with its nodes; the ids line up with
 * them, or this throws. Also throws when the block holds a node this build
 * can't place where it was stored. */
export function nodeIds(doc, blockId, tree) {
  const path = textPath(blockId);
  const ids = spanNodeIds(doc, path, A.spans(doc, path));
  // richDoc can read a node through notice text (a dataframe naming another
  // Page's asset), which changes its size but never the number of top-level
  // nodes.
  if (tree && (tree.nodes?.length ?? tree.content.length) !== ids.length)
    throw Error("The stored and readable trees disagree on top-level nodes");
  if (
    tree?.source &&
    tree.nodes.some((node, index) => {
      const at = tree.source.get(node);
      return at != null && at !== ids[index].at;
    })
  )
    throw Error("The readable nodes do not correspond to the stored markers");
  return ids;
}

/** nodeIds for the text at `path`, from `spans` the caller already read
 * from it, with no readable tree to check against. */
export function spanNodeIds(doc, path, spans) {
  const { nodes, placed } = blockAddresses(spans);
  if (!placed) throw Error("This block holds a node this build can't place");
  return nodes.map(({ at, end }) => ({
    id: at === null ? null : A.getCursor(doc, path, at),
    at,
    end,
  }));
}

/** nodeIds, or no ids (all null) when the block holds a node this build
 * can't place: a node a newer build wrote inside a table cell, say. richDoc
 * still reads such a block, through text it rewrites, so its positions don't
 * name stored markers and no id is better than a wrong one. */
export function readableNodeIds(doc, blockId, tree) {
  try {
    return nodeIds(doc, blockId, tree);
  } catch {
    return Array.from({ length: tree.nodes?.length ?? tree.content.length }, () => ({
      id: null,
      at: null,
    }));
  }
}

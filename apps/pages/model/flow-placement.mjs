// Where an insert with no node anchor goes, so a Page stays one flow
// (DIRECTION.md, "One flow per Page"). An omitted after_node_id writes after
// the last top-level node of the last block, and null writes before the
// first node of the first block, with insertInPlace. A block's id as
// after_node_id still puts the content in a block of its own.
//
// The insert falls back to a new block, at the same end of the Page, when
// the edge block can't take it in place, so no insert that made a block
// before is refused now:
// - the Page has no block;
// - the block would pass MAX_PASSAGE_BLOCK_LENGTH, past which passage
//   operations can't search it, or the batch's in-place budget;
// - the block holds content this build reads lossily, or nodes whose ids it
//   can't name;
// - the new content would join a list of the same kind at that edge;
// - for null, the first block opens with unmarked text the batch didn't
//   repair;
// - a later operation in the batch deletes the block or rewrites it with
//   Markdown (delete_block, replace_block_markdown), which would drop the
//   insert.
// A blank edge block (a new Page's empty paragraph) takes the content in
// place of its empty paragraph.
import { isBlankBlock } from "./richtext-format.mjs";
import { nativeReadSpans, readKind } from "./native-read.mjs";
import { nodeIds } from "./node-ids.mjs";
import { orderedBlockIds } from "./order.mjs";
import { MAX_PASSAGE_BLOCK_LENGTH } from "./replace-match.mjs";
import { MAX_BATCH_IN_PLACE_UNITS } from "./insert-in-place.mjs";

const LISTS = new Set(["bullet-list", "ordered-list", "task-list"]);
const width = (span) => (span.type === "text" ? span.value.length : 1);

/** "end" for an omitted after_node_id, "start" for null, or undefined for
 * an insert that names its place. */
export function flowEdge(op) {
  if (op.after_node_id === undefined) return "end";
  if (op.after_node_id === null) return "start";
  return undefined;
}

/** The block an insert with no node anchor writes into, before any
 * operation runs, so the batch repairs its markers: the last block for an
 * omitted after_node_id, the first for null. */
export function flowBlock(doc, op) {
  const edge = flowEdge(op);
  if (!edge) return undefined;
  const keys = orderedBlockIds(doc);
  return edge === "end" ? keys.at(-1) : keys[0];
}

/**
 * Where `spans` (an encoded document) go for insert `op` with no node
 * anchor, at `edge` of the Page: `{ kind: "node", key, index, start, end }`
 * for insertInPlace (index -1 before the block's first node), `{ blank:
 * true, key }` for a blank edge block, or null for a new block.
 * `reads` are the batch's reads (model/block-reads.mjs). `replaced` holds
 * the keys of blocks a later operation in the batch deletes or rewrites
 * whole.
 */
export function flowAnchor(doc, spans, edge, { budget, reads, replaced }) {
  const keys = orderedBlockIds(doc);
  if (!keys.length) return null;
  const key = edge === "end" ? keys.at(-1) : keys[0];
  if (replaced?.has(key)) return null;
  const length = doc.blocks[key].richText.length;
  const adding = spans.reduce((sum, span) => sum + width(span), 0);
  if (length + adding > MAX_PASSAGE_BLOCK_LENGTH) return null;
  if ((budget?.inPlace ?? 0) + length > MAX_BATCH_IN_PLACE_UNITS) return null;
  if (isBlankBlock(doc.blocks[key])) return { blank: true, key };
  let tree, nodes;
  try {
    if (reads.decoded(key).lossy) return null;
    tree = reads.tree(key);
    nodes = reads.addresses(key).nodes;
    const ids = nodeIds(doc, key, tree, reads.nodeIds(key));
    if (!ids.length || ids.some(({ id }) => id === null)) return null;
  } catch {
    return null;
  }
  if (!nodes.length || nodes.length !== tree.nodes.length) return null;
  const added = nativeReadSpans(spans, doc.page_id).nodes;
  if (!added.length) return null;
  const outer = readKind(edge === "end" ? tree.nodes.at(-1) : tree.nodes[0]);
  const inner = readKind(edge === "end" ? added[0] : added.at(-1));
  if (LISTS.has(outer) && outer === inner) return null;
  // Unmarked text before the first marker would read as part of the last
  // new node. The batch repairs the edge block it sees before any operation
  // runs; one that became the edge later in the batch may not be repaired.
  if (edge === "start") {
    if (nodes[0].at === null) return null;
    return { kind: "node", key, index: -1, start: 0, end: 0 };
  }
  const last = nodes.at(-1);
  return { kind: "node", key, index: nodes.length - 1, start: last.start, end: last.end };
}

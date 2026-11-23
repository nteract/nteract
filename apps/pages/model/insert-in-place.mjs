// In-place inserts: new top-level nodes written into an existing block,
// directly after a top-level node an agent names, with no new block.
//
// The write is targeted: one A.splitBlock per marker and one A.splice per
// text run, at the end of the anchor node's range. Every character and
// marker already stored keeps its identity, so node ids, image ids and
// comment anchors on the neighbours stay where they are. Nothing diffs or
// rewrites the block.
//
// Marks with `expand: "both"` (em, strong, strike, highlight) grow over text
// spliced at their end, so every inserted character is unmarked first and
// then given exactly the marks its encoded span names, as the editor binding
// writes typed text (viewer/wordgard-binding.mjs).
//
// A list has no marker of its own: its items' markers name it as a parent.
// A list item written next to items of the same kind joins their list, and a
// node can join its neighbour in other ways a merge-free check can't predict
// from types alone. So the block is decoded after the write and the insert
// is refused, with the whole change, unless the block holds the old nodes,
// with their ids, around exactly the new ones.
import * as A from "@automerge/automerge/slim";
import { textPath } from "./richtext-format.mjs";
import { markExpand } from "./marks.mjs";
import { stampSpans } from "./schema-features.mjs";
import { newerContent } from "./richtext-spans.mjs";
import { decode } from "./wordgard-doc.mjs";
import { nativeRead, nativeReadSpans, readFingerprint, readKind } from "./native-read.mjs";
import { nodeIds } from "./node-ids.mjs";
import { blockAddress } from "./addresses.mjs";
import { refused } from "./edit-refusals.mjs";

const width = (span) => (span.type === "text" ? span.value.length : 1);

/** The most block text, in UTF-16 units, one batch's in-place writes may
 * count. Each insert decodes its whole block to place the new nodes and again
 * to check them, so its cost follows the block's length, not the insert's:
 * about 100 inserts into a 10 KB block, or 4 into a 200 KB one. The unit is
 * one block written in, not one decode: a move counts its source block and
 * its destination block once each (move-nodes.mjs). */
export const MAX_BATCH_IN_PLACE_UNITS = 1_000_000;
const INSERT_BUDGET =
  "This batch inserts inside blocks too many times for their size. Send fewer inserts per request, or put several nodes in one insert_markdown.";
/** Count block `key`'s length against the batch before an operation reads
 * it, refusing before anything is written. `message` is the refusal for an
 * operation other than an insert. */
export function spendInPlaceRead(budget, doc, key, message = INSERT_BUDGET) {
  if (!budget) return;
  budget.inPlace = (budget.inPlace ?? 0) + doc.blocks[key].richText.length;
  if (budget.inPlace > MAX_BATCH_IN_PLACE_UNITS)
    throw refused("in_place_budget", message, "after_node_id");
}
const article = (kind) => `${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind}`;
// Stored attrs come back in whatever key order Automerge keeps.
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
// The kinds that have no marker of their own, so two alike side by side read
// as one.
const LISTS = new Set(["bullet-list", "ordered-list", "task-list"]);

/** The top-level nodes of block `key` as the readers draw them, with their
 * ids. Throws node_not_found when the stored markers and the readable tree
 * disagree, as delete_node does: no id can then be checked. */
function readBlock(doc, key, op) {
  const tree = nativeRead(doc.blocks[key], doc.page_id);
  try {
    return { tree, ids: nodeIds(doc, key, tree).map(({ id }) => id) };
  } catch {
    throw Object.assign(
      Error(
        `This block holds nodes this version of Pages reads differently from how they're stored, so ${op} can't write inside it. Give after_node_id the block's id to insert after the block instead.`,
      ),
      { code: "node_not_found", editField: "after_node_id" },
    );
  }
}

/** Write `spans` (an encoded document: model/richtext-spans.mjs pageSpans)
 * into block `target.key` directly after the top-level node `target` names
 * (resolveAddress: `{ key, index, start, end }`), inside the caller's change.
 * The caller repairs the block's markers first (repairBlockMarkers), so no
 * unmarked text follows the anchor.
 *
 * Returns `{ block, nodes, start, end }`: the block's id, the new nodes' ids
 * in order, and the text range they occupy. Throws `newer_content` for a
 * block holding content from a newer build, and `nodes_would_join` when a
 * new node would join the anchor or the node after it; a throw aborts the
 * whole change. */
export function insertInPlace(doc, target, spans, op) {
  const { key, index } = target;
  const path = textPath(key);
  const stored = A.spans(doc, path);
  const decoded = decode(stored);
  if (decoded.lossy && decoded.newer)
    throw newerContent(
      `This block holds content from a newer version of Pages that this version can't read, so ${op} can't write inside it. Give after_node_id the block's id to insert after the block instead.`,
    );
  if (spans[0]?.type !== "block") throw Error("New content opens with a node marker");
  const before = readBlock(doc, key, op);
  const expected = nativeReadSpans(spans, doc.page_id);
  const added = expected.nodes.length;

  const start = target.end;
  let at = start;
  const runs = [];
  for (const span of spans) {
    if (span.type === "block") A.splitBlock(doc, path, at, span.value);
    else {
      A.splice(doc, path, at, 0, span.value);
      runs.push({ at, length: span.value.length, marks: span.marks ?? {} });
    }
    at += width(span);
  }
  const end = at;
  // Marks that grew over the new text from the anchor's end are taken off the
  // whole inserted range, markers included, so none ends inside it. The
  // anchor's mark still spans the range in storage, so the removal grows at
  // its end: text a later writer splices after the last new node stays out of
  // the anchor's mark. It doesn't grow at its start, so text typed at the
  // anchor's end continues the anchor's mark.
  const present = new Set(
    A.marks(doc, path)
      .filter((mark) => mark.start < end && mark.end > start)
      .map((mark) => mark.name),
  );
  for (const name of present) A.unmark(doc, path, { start, end, expand: "after" }, name);
  for (const run of runs)
    for (const name of Object.keys(run.marks))
      if (run.marks[name] !== undefined && run.marks[name] !== null)
        A.mark(
          doc,
          path,
          { start: run.at, end: run.at + run.length, expand: markExpand(name) },
          name,
          run.marks[name],
        );
  stampSpans(doc, spans);

  // The old nodes, with their ids, around exactly the new ones; anything
  // else means a node joined a neighbour. Throwing aborts the whole change.
  const after = readBlock(doc, key, op);
  const fresh = after.ids.slice(index + 1, index + 1 + added);
  const kept =
    after.ids.length === before.ids.length + added &&
    before.ids.every((id, i) => after.ids[i <= index ? i : i + added] === id) &&
    fresh.every((id) => id !== null && !before.ids.includes(id));
  if (!kept) {
    const first = readKind(expected.nodes[0]);
    const last = readKind(expected.nodes.at(-1));
    const anchor = readKind(before.tree.nodes[index]);
    const next = before.tree.nodes[index + 1];
    const joined =
      LISTS.has(first) && first === anchor
        ? `the new ${first} and the ${anchor} it follows`
        : next && LISTS.has(last) && last === readKind(next)
          ? `the new ${last} and the ${last} after it`
          : "a new node and its neighbour";
    throw Object.assign(
      Error(
        `${op} would join ${joined} into one. Start the new content with a different kind of node, such as a paragraph, insert after another node, or give after_node_id the block's id to put it in a block of its own.`,
      ),
      { status: 400, code: "nodes_would_join", editField: "after_node_id" },
    );
  }
  // The new nodes read back as encoded: their content and marks.
  const same = expected.nodes.every(
    (node, i) =>
      canonical(readFingerprint(node, expected.metadata)) ===
      canonical(readFingerprint(after.tree.nodes[index + 1 + i], after.tree.metadata)),
  );
  if (!same)
    throw Object.assign(
      Error(
        `${op} could not write ${article(readKind(expected.nodes[0]))} here as given. Give after_node_id the block's id to put it in a block of its own.`,
      ),
      { status: 400, code: "nodes_would_join", editField: "after_node_id" },
    );
  return { block: blockAddress(doc, key), nodes: fresh, start, end };
}

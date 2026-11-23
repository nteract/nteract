// move_nodes: a run of top-level nodes moved to after another top-level node,
// in the same block or another one. This is a candidate operation for one
// flow per Page (DIRECTION.md, "How an agent moves a section").
//
// Automerge text has no move. The run's stored spans are read, deleted, and
// written again after the anchor with insertInPlace, so every character and
// mark comes back as it was stored, under new ids: the moved nodes get new
// node ids, and the receipt names them. Every node outside the run keeps its
// id.
//
// Comment threads whose whole selection lies inside the run are re-anchored
// on the same text at its new place. The rewrites are collected in
// `comments.rewrites`; the host writes them to the comments document, not on
// any author's behalf. A thread that only partly overlaps the run loses part
// of its text and is counted as detached.
import * as A from "@automerge/automerge/slim";
import { textPath } from "./richtext-format.mjs";
import { nativeRead, readKind } from "./native-read.mjs";
import { setRichEmpty } from "./richtext-page.mjs";
import { insertInPlace, spendInPlaceRead } from "./insert-in-place.mjs";
import { selectionContext } from "./comments.mjs";
import { orderedBlockIds } from "./order.mjs";

const width = (span) => (span.type === "text" ? span.value.length : 1);

/** The comment state a batch of moves reads and updates: a plain copy of
 * each thread's target from `commentsDoc`, the rewrites the moves make, and
 * the threads they cut through. */
export function moveComments(commentsDoc) {
  const threads = {};
  for (const [id, thread] of Object.entries(commentsDoc?.threads ?? {}))
    if (thread?.target) threads[id] = JSON.parse(JSON.stringify(thread.target));
  return { threads, rewrites: new Map(), detached: [] };
}

/** Write `rewrites` (moveComments) into a comments document draft. A thread
 * deleted since the move read it stays deleted. */
export function applyCommentRewrites(draft, rewrites) {
  for (const [id, target] of rewrites)
    if (Object.hasOwn(draft.threads ?? {}, id) && draft.threads[id])
      draft.threads[id].target = target;
  return { threads_reanchored: rewrites.size };
}

/** The stored spans of block `key` from `start` to `end`. The caller repaired
 * the block's markers, so both ends fall on node markers and no text span
 * crosses them. */
function sliceSpans(doc, key, start, end) {
  const slice = [];
  let at = 0;
  for (const span of A.spans(doc, textPath(key))) {
    const next = at + width(span);
    if (at >= start && next <= end) slice.push(span);
    else if (at < end && next > start)
      throw Error("move_nodes found a node whose text crosses its range");
    at = next;
    if (at >= end) break;
  }
  return slice;
}

function endpoint(doc, key, offset) {
  return {
    blockId: key,
    textObjectId: A.getObjectId(doc.blocks[key], "richText"),
    relativePositionBase64: btoa(A.getCursor(doc, textPath(key), offset)),
  };
}

const refuse = (message, code = "invalid_move") =>
  Object.assign(Error(message), { status: 400, code });

/** A selection target over `[from, to)` of block `key`: the anchor on the
 * first character, the head on the last. */
function selection(doc, key, from, to) {
  const low = doc.blocks[key].richText.charCodeAt(to - 1);
  const head = to - (low >= 0xdc00 && low <= 0xdfff ? 2 : 1);
  return { kind: "selection", anchor: endpoint(doc, key, from), head: endpoint(doc, key, head) };
}

/**
 * Move the nodes `first` through `last` (resolved top-level nodes of one
 * block: `{ key, index, start, end }`) to directly after `anchor` (a resolved
 * top-level node), or to the start of the Page when `op.after_node_id` is
 * null. An omitted after_node_id is refused: for an insert it appends, and a
 * move that guessed would reorder the Page.
 *
 * `comments`, when given, is `{ threads, rewrites, detached }`: `threads`
 * maps thread ids to their current targets and is updated in place, so a
 * later move in the same batch sees an earlier one's rewrites; `rewrites`
 * (a Map) collects each changed target; `detached` collects ids of threads
 * the move cut through.
 */
export function moveNodes(doc, op, { first, last, anchor }, context) {
  const { trace, touched, budget, comments } = context;
  if (op.after_node_id === undefined)
    throw refuse(
      "move_nodes needs after_node_id: the id of the node the run goes after, or null for the start of the Page",
    );
  if (first.key !== last.key)
    throw refuse(
      "move_nodes moves nodes of one block: node_id and through_node_id name nodes in different blocks",
    );
  if (last.index < first.index)
    throw refuse("move_nodes needs through_node_id at or after node_id in the Page");
  const src = first.key;
  if (anchor && anchor.key === src && anchor.index >= first.index && anchor.index <= last.index)
    throw refuse("after_node_id names a node inside the range move_nodes moves");
  const top = orderedBlockIds(doc)[0];
  if (!anchor && src === top && first.index === 0)
    throw refuse("These nodes are already at the start of the Page; nothing to move");
  if (anchor && anchor.key === src && anchor.index === first.index - 1)
    throw refuse("These nodes already follow after_node_id; nothing to move");
  const dst = anchor ? anchor.key : top;
  // The move reads its block before and after the delete and slices its
  // spans; insertInPlace decodes the destination block three times.
  for (let i = 0; i < 3; i++) spendInPlaceRead(budget, doc, src);
  for (let i = 0; i < 3; i++) spendInPlaceRead(budget, doc, dst);

  const count = last.index - first.index + 1;
  const { start } = first;
  const { end } = last;
  const length = end - start;
  const before = nativeRead(doc.blocks[src], doc.page_id);
  const spans = sliceSpans(doc, src, start, end);

  // Threads on this block's text: the ones wholly inside the run move with
  // it; the ones that cross its edge lose part of their text.
  const moving = [];
  if (comments)
    for (const [id, target] of Object.entries(comments.threads)) {
      if (target?.kind !== "selection" || target.anchor?.blockId !== src) continue;
      const context = selectionContext(doc, target);
      if (context?.status !== "attached") continue;
      const from = context.start.offsetUtf16;
      const to = context.end.offsetUtf16;
      if (from >= start && to <= end) moving.push({ id, from: from - start, to: to - start });
      else if (from < end && to > start) comments.detached.push(id);
    }

  A.splice(doc, textPath(src), start, length);
  const emptied = !doc.blocks[src].richText.length;
  if (emptied) setRichEmpty(doc, src);
  else {
    const left = nativeRead(doc.blocks[src], doc.page_id);
    if (left.nodes.length < before.nodes.length - count) {
      const name = (index) => readKind(before.nodes[index]);
      throw refuse(
        `move_nodes would join the ${name(first.index - 1)} before these nodes and the ${name(last.index + 1)} after them into one. Move a node that sits between them too, or delete one of them first.`,
        "nodes_would_join",
      );
    }
  }

  // Where the anchor sits now that the run is gone from its block.
  let target;
  if (!anchor) target = { key: dst, index: -1, start: 0, end: 0 };
  else if (anchor.key === src && anchor.index > last.index)
    target = {
      ...anchor,
      index: anchor.index - count,
      start: anchor.start - length,
      end: anchor.end - length,
    };
  else target = anchor;
  const placed = insertInPlace(doc, target, spans, "move_nodes");

  // An emptied source block in another place than the destination holds only
  // the empty paragraph setRichEmpty wrote. It goes. Its whole-block
  // comments named exactly the moved text, so they become selections over it.
  let removed = false;
  if (emptied && dst !== src) {
    delete doc.blocks[src];
    removed = true;
    if (comments)
      for (const [id, target] of Object.entries(comments.threads))
        if (target?.kind === "block" && target.blockId === src) {
          const next = selection(doc, dst, placed.start, placed.end);
          comments.threads[id] = next;
          comments.rewrites.set(id, next);
        }
  }

  if (comments)
    for (const { id, from, to } of moving) {
      const next = selection(doc, dst, placed.start + from, placed.start + to);
      comments.threads[id] = next;
      comments.rewrites.set(id, next);
    }

  touched.push(src, dst);
  trace?.push({ type: "text", block_id: dst, start: placed.start, end: placed.end });
  return {
    op: "move_nodes",
    block: placed.block,
    nodes: placed.nodes,
    ...(removed && { removed_block: true }),
    ...(comments && { comments_moved: moving.length }),
  };
}

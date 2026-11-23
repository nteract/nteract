// What one edit_page batch has read from each block, so a later operation on
// the same block doesn't read it again.
//
// Reading a block's spans is most of what a host edit costs: Automerge
// hydrates every node marker, about 80 ms for a block of 100,000 UTF-16
// units, while a mark or a splice costs well under a millisecond. One
// operation needs its block's spans several times (to find a match, test it
// for code, name the node that owns it, place an insert and check it), and a
// batch often edits one block many times. This keeps one read per block for
// the whole batch (scripts/edit-batch-benchmark.mjs measures it).
//
// Two reads are kept per block, keyed by block:
//
// - `spans`: the block's spans as A.spans returns them, with what is derived
//   from them (marks, decode, the readable tree, node addresses and ids).
//   Any write to the block drops them; the next read is fresh.
// - `runs`: the block's text runs and node markers without marks. A mark or
//   unmark changes neither, so they survive formatting writes, and a text
//   splice that stays inside text updates them in place. Passage operations
//   find their match, its code-block context and its owning node from these.
//
// The cache lives inside one change, or over one unchanging document (the
// target-scope guard's base and current revisions, model/passage-edits.mjs).
// It is never stored, and nothing in it reaches a receipt that a fresh read
// wouldn't give.
//
// An operation that writes a block tells this cache about the write, or the
// batch drops the block's reads after the operation (`settle`, with the
// blocks the operation lists as touched). An operation that reports one of
// its writes to a block reports every one, since the batch then trusts what
// is cached. These report:
//
// - format_match: `marked` (model/replace-match.mjs).
// - replace_match: `spliced` for each splice, then `marked`.
// - in-place inserts and move_nodes: `wrote` before the read that checks
//   the write (model/insert-in-place.mjs, model/move-nodes.mjs).
// - delete_node: `wrote` before the read that checks the write
//   (model/page.mjs).
//
// Every other write is dropped by `settle`: set_node, set_image, a dataframe
// edit, replace_block_markdown, move_block, delete_block and a new block.
// The batch's marker repair runs before any operation and calls `forget`.
import * as A from "@automerge/automerge/slim";
import { textPath } from "./richtext-format.mjs";
import { decode } from "./wordgard-doc.mjs";
import { nativeReadSpans } from "./native-read.mjs";
import { spanNodeIds } from "./node-ids.mjs";
import { blockAddresses } from "./node-addresses.mjs";

const width = (span) => (span.type === "text" ? span.value.length : 1);

/** `spans` without marks, with neighbouring text joined: what a text search,
 * a code-block test and a node owner read. Each marker keeps its value. */
export function textRuns(spans) {
  const runs = [];
  for (const span of spans) {
    if (span.type === "block") runs.push({ type: "block", value: span.value });
    else if (runs.at(-1)?.type === "text")
      runs[runs.length - 1] = { type: "text", value: runs.at(-1).value + span.value };
    else if (span.value) runs.push({ type: "text", value: span.value });
  }
  return runs;
}

/** `runs` after a text splice at `at` that removes `remove` units and inserts
 * `insert`, as A.splice writes it, or null when the splice reaches a marker:
 * only a fresh read can say where the text then lands. */
export function spliceRuns(runs, at, remove, insert) {
  let pos = 0;
  for (let i = 0; i <= runs.length; i++) {
    const run = runs[i];
    // Between two markers, or at either end, with no text there yet.
    if (pos === at && run?.type !== "text" && runs[i - 1]?.type !== "text") {
      if (remove) return null;
      return insert
        ? [...runs.slice(0, i), { type: "text", value: insert }, ...runs.slice(i)]
        : runs;
    }
    if (!run) return null;
    const end = pos + width(run);
    if (run.type === "text" && at >= pos && at + remove <= end) {
      const value = run.value.slice(0, at - pos) + insert + run.value.slice(at - pos + remove);
      return [
        ...runs.slice(0, i),
        ...(value ? [{ type: "text", value }] : []),
        ...runs.slice(i + 1),
      ];
    }
    if (at < end) return null;
    pos = end;
  }
  return null;
}

/** The reads of one batch over `doc`, a draft inside A.change. */
export function blockReads(doc) {
  const blocks = new Map();
  // The blocks the current operation reported its writes to.
  const reported = new Set();
  const entry = (key) => {
    let found = blocks.get(key);
    if (!found) blocks.set(key, (found = {}));
    return found;
  };
  const reads = {
    /** Block `key`'s spans as stored now. */
    spans(key) {
      const block = entry(key);
      return (block.spans ??= A.spans(doc, textPath(key)));
    },
    /** A.marks of block `key`. */
    marks(key) {
      const block = entry(key);
      return (block.marks ??= A.marks(doc, textPath(key)));
    },
    /** decode of block `key`'s spans (model/wordgard-doc.mjs). */
    decoded(key) {
      const block = entry(key);
      return (block.decoded ??= decode(reads.spans(key)));
    },
    /** nativeReadSpans of block `key`'s spans: the tree every reader draws. */
    tree(key) {
      const block = entry(key);
      return (block.tree ??= nativeReadSpans(reads.spans(key), doc.page_id));
    },
    /** spanNodeIds of block `key`'s spans. Throws as spanNodeIds does, every
     * time it is asked. */
    nodeIds(key) {
      const block = entry(key);
      if (!block.nodeIds)
        try {
          block.nodeIds = { ids: spanNodeIds(doc, textPath(key), reads.spans(key)) };
        } catch (error) {
          block.nodeIds = { error };
        }
      if (block.nodeIds.error) throw block.nodeIds.error;
      return block.nodeIds.ids;
    },
    /** blockAddresses of block `key`'s spans (model/node-addresses.mjs).
     * Throws as blockAddresses does, and is read again after a throw. */
    addresses(key) {
      const block = entry(key);
      return (block.addresses ??= blockAddresses(reads.spans(key)));
    },
    /** Block `key`'s text runs and markers, without marks (textRuns). */
    runs(key) {
      const block = entry(key);
      return (block.runs ??= textRuns(reads.spans(key)));
    },
    /** Drop block `key`'s reads after a write outside any operation, such as
     * the batch's marker repair. */
    forget(key) {
      blocks.delete(key);
    },
    /** The operation wrote block `key` in a way this cache can't follow:
     * its next read is fresh. */
    wrote(key) {
      reported.add(key);
      blocks.delete(key);
    },
    /** The operation added or removed marks on block `key`, and wrote nothing
     * else to it. */
    marked(key) {
      reported.add(key);
      const { runs } = entry(key);
      blocks.set(key, runs ? { runs } : {});
    },
    /** The operation spliced text into block `key` (A.splice at `at`,
     * removing `remove` units and inserting `insert`). */
    spliced(key, at, remove, insert) {
      reported.add(key);
      const { runs } = entry(key);
      const next = runs && spliceRuns(runs, at, remove, insert);
      blocks.set(key, next ? { runs: next } : {});
    },
    /** After an operation: drop the reads of each block in `touched` that it
     * didn't report its writes to. */
    settle(touched) {
      for (const key of touched) if (!reported.has(key)) blocks.delete(key);
      reported.clear();
    },
  };
  return reads;
}

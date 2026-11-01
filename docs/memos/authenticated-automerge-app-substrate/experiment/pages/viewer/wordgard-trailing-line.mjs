import { Plot } from "wordgard/doc";
import { Correction, GardSelection } from "wordgard/state";
import { Doc } from "wordgard/types";
import { CodeBlock, Paragraph, needsTrailingLine } from "./wordgard-model.mjs";

// A Page block's editor always ends in a paragraph when its last node is one a
// caret can't type its way out of (wordgard-model.mjs needsTrailingLine). The
// binding decodes that line without a native span and doesn't encode it while
// it's empty, so the line costs the Automerge document nothing until someone
// writes in it. This correction keeps local transactions in the same shape:
// deleting the line, or turning the last paragraph into a code block, puts an
// empty line back. Remote changes go through decode, which does the same.
//
// onContent, not onChildList: Backspace on the empty line joins it into the
// code block, and Wordgard scans that as a change inside the code block, not
// to the document's children. The check is one look at the last child.
export const trailingLine = Correction.onContent(Doc, (doc) =>
  needsTrailingLine(doc.node.content.at(-1))
    ? { from: doc.end, to: doc.end, insert: [Paragraph, Plot.End] }
    : null,
);

/** Whether `pos` is on the projection's trailing line, which has no native
 * offset of its own. A caret there maps to the native end, which decodes to
 * the end of the block before it; callers mapping a local caret through a
 * remote change keep it on the line instead. */
export const onTrailingLine = (map, pos) => map?.trailing != null && pos > map.trailing;

// Mod-Enter in a code block puts the caret on the line after it: the next
// paragraph when it's empty (the trailing line, after a final code block),
// otherwise a new empty paragraph.
export function exitCodeBlock(target) {
  const { state } = target;
  if (state.readOnly || !state.sel.selection.empty) return false;
  const block = state.sel.head.textblockParent;
  if (!block || block.node.type !== CodeBlock.type || !block.parent) return false;
  const next = block.nextSibling;
  if (next?.type === Paragraph.type && !next.content.length)
    return {
      selection: GardSelection.cursor(block.after + 1),
      scrollIntoView: true,
      userEvent: "select",
    };
  if (!state.doc.schema.canContain(block.parent.node.type, Paragraph.type)) return false;
  return {
    changes: { from: block.after, to: block.after, insert: [Paragraph, Plot.End] },
    selection: GardSelection.cursor(block.after + 1),
    scrollIntoView: true,
    userEvent: "split.textblock",
  };
}

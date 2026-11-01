import { Plot } from "wordgard/doc";
import { GardSelection } from "wordgard/state";
import { CodeBlock, OpaqueBlock, PagesImage, Paragraph, Table } from "./wordgard-model.mjs";

// A caret can't type its way out of some final nodes: Enter adds a line in a
// code block, moves between table cells, and a preserved block or an image
// is selected whole. When one of these ends a Page block, ArrowDown on its
// last line, Mod-Enter, or a click below it adds a real empty paragraph after
// it and puts the caret there. That's an ordinary edit, so it merges like any
// Enter, and opening a Page still writes nothing.

/** The final top-level node when the caret can't leave it by typing: a code
 * block, table or preserved block, or a paragraph that ends in an image. */
export function finalBlock(doc) {
  const node = doc.content.at(-1);
  if (!node) return null;
  const blocked =
    node.type === CodeBlock.type ||
    node.type === Table.type ||
    node.type === OpaqueBlock ||
    (node.type === Paragraph.type && node.content.at(-1)?.type === PagesImage);
  return blocked ? { node, from: doc.length - node.length, to: doc.length } : null;
}

const addLine = (end) => ({
  changes: { from: end, to: end, insert: [Paragraph, Plot.End] },
  selection: GardSelection.cursor(end + 1),
  scrollIntoView: true,
  userEvent: "split.textblock",
});

function inFinal(state, final) {
  return !!final && state.selection.from >= final.from;
}

/** ArrowDown. Only when vertical motion has nowhere left to go in the final
 * node: the last line of a code block or of a paragraph holding images, the
 * last table row, or a selected preserved block. Otherwise ArrowDown moves as
 * usual. A selected image moves down from its own end, like Wordgard's
 * moveByLine, so an image on an earlier line reaches the lines below it. */
export function leaveFinalBlock(target) {
  const { state } = target;
  const final = finalBlock(state.doc);
  if (state.readOnly || !inFinal(state, final)) return false;
  const { selection } = state;
  const text = selection instanceof GardSelection.Text;
  if (text && !selection.empty) return false;
  const start = text ? selection : GardSelection.cursor(selection.to);
  if (start.head < final.to && belowInside(target, start, final)) return false;
  return addLine(final.to);
}

/** Whether moving down from `start` lands somewhere else inside `final`. */
function belowInside(target, start, final) {
  const moved = target.moveVertically?.(start, true, undefined, true);
  if (!moved) return false;
  if (moved instanceof GardSelection.Node) return moved.from >= start.head && moved.from < final.to;
  return (
    moved.head !== start.head &&
    moved.head < final.to &&
    target.state.doc.resolve(moved.head).parent.node.inlineContent
  );
}

/** Mod-Enter. In any code block, put the caret on the line after it: the next
 * paragraph when it's empty, otherwise a new empty paragraph. In a final table,
 * image paragraph or preserved block, add a paragraph after it. */
export function exitBlock(target) {
  const { state } = target;
  if (state.readOnly) return false;
  const block = state.selection.empty ? state.sel.head.textblockParent : null;
  if (block?.node.type === CodeBlock.type && block.parent) {
    const next = block.nextSibling;
    if (next?.type === Paragraph.type && !next.content.length)
      return {
        selection: GardSelection.cursor(block.after + 1),
        scrollIntoView: true,
        userEvent: "select",
      };
    if (!state.doc.schema.canContain(block.parent.node.type, Paragraph.type)) return false;
    return addLine(block.after);
  }
  const final = finalBlock(state.doc);
  return inFinal(state, final) ? addLine(final.to) : false;
}

/** A click in the empty space below the last node of a Page block. */
export function clickBelowFinalBlock(target, event) {
  const { state } = target;
  if (state.readOnly || event.button !== 0 || event.defaultPrevented) return false;
  const final = finalBlock(state.doc);
  const last = target.contentDOM?.lastElementChild;
  if (!final || !last || event.clientY <= last.getBoundingClientRect().bottom) return false;
  event.preventDefault();
  target.dispatch(addLine(final.to));
  target.focus();
  return true;
}

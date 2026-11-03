import { GardSelection } from "wordgard/state";
import { PagesDataframe, PagesImage } from "./wordgard-model.mjs";

// Clicks, touch, and keyboard navigation all use Wordgard's node selection.
// A text range containing an image still has text-formatting controls.
export function selectedImage(state) {
  const selection = state.selection;
  return selection instanceof GardSelection.Node && selection.node.type === PagesImage
    ? selection
    : null;
}

/** A node selection of an atomic embed: an image or a dataframe. Text
 * formatting controls stay hidden for it, and a remote edit maps it through
 * Wordgard's change set instead of rebuilding it as a text range. */
export function selectedAtom(state) {
  const selection = state.selection;
  return selection instanceof GardSelection.Node &&
    (selection.node.type === PagesImage || selection.node.type === PagesDataframe)
    ? selection
    : null;
}

/**
 * Each Page block is its own editor. When focus moves into another block's
 * editor, a selected image or dataframe here is deselected (the caret goes
 * just after it), so at most one object on the Page is selected and Cmd-X
 * never acts on one you left behind. Focus moving inside this editor (into a
 * table's grid) or out to a toolbar, a dialog or another window keeps it.
 */
export function collapseAtomOnLeave(editor, event) {
  const next = event.relatedTarget;
  if (!next?.closest || editor.dom.contains(next) || !next.closest("wg-content")) return false;
  const selection = selectedAtom(editor.state);
  if (!selection) return false;
  editor.dispatch({
    selection: (cx) =>
      selection.nextNormalCursor(cx, true) ?? GardSelection.near(cx, selection.from, -1),
  });
  return true;
}

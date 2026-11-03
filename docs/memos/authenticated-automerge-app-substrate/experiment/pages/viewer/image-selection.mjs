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

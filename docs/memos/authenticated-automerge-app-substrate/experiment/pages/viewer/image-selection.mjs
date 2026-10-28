import { GardSelection } from "wordgard/state";
import { PagesImage } from "./wordgard-model.mjs";

// Clicks, touch, and keyboard navigation all use Wordgard's node selection.
// A text range containing an image still has text-formatting controls.
export function selectedImage(state) {
  const selection = state.selection;
  return selection instanceof GardSelection.Node && selection.node.type === PagesImage
    ? selection
    : null;
}

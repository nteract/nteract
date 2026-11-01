import { GardSelection } from "wordgard/state";
import { DEFAULT_HIGHLIGHT, normalizeHighlight } from "../model/marks.mjs";
import { PagesHighlight } from "./wordgard-model.mjs";

/** The highlight state of the current selection: `color` when every selected
 * character has the same highlight, `colors` for every value present. */
export function selectionHighlight(state) {
  const { selection, doc } = state;
  if (selection instanceof GardSelection.Text && selection.empty) {
    const mark = PagesHighlight.isInSet(selection.marks || state.sel.head.marks());
    return { color: mark?.value ?? null, colors: mark ? [mark.value] : [] };
  }
  const colors = new Set();
  let text = 0,
    highlighted = 0;
  for (const range of selection.ranges)
    doc.iterate(range.from, range.to, (node) => {
      if (!node.isText) return true;
      text++;
      const mark = PagesHighlight.isInSet(node.tag.marks);
      if (mark) {
        highlighted++;
        colors.add(mark.value);
      }
      return true;
    });
  return {
    color: text > 0 && highlighted === text && colors.size === 1 ? [...colors][0] : null,
    colors: [...colors],
  };
}

/** Wordgard command: highlight the selection in one color, replacing any
 * other highlight in it. A collapsed selection sets the color for typing. */
// Command.dispatch passes null when no value is given, so default explicitly.
export const setHighlight = ({ state }, color) => {
  if (state.readOnly) return false;
  const mark = PagesHighlight.of(normalizeHighlight(color ?? DEFAULT_HIGHLIGHT));
  const { selection } = state;
  if (selection instanceof GardSelection.Text && selection.empty) {
    const marks = mark.addToSet(selection.marks || state.sel.head.marks());
    return {
      selection: GardSelection.Text.create({
        anchor: selection.anchor,
        headSide: selection.headSide,
        goalColumn: selection.goalColumn,
        marks,
      }),
      userEvent: "mark.add",
    };
  }
  return {
    changes: selection.ranges.map((range) => ({ from: range.from, to: range.to, add: mark })),
    userEvent: "mark.add",
  };
};

/** Wordgard command: clear every highlight color from the selection. */
export const clearHighlight = ({ state }) => {
  if (state.readOnly) return false;
  const { selection } = state;
  if (selection instanceof GardSelection.Text && selection.empty) {
    const current = selection.marks || state.sel.head.marks();
    if (!PagesHighlight.isInSet(current)) return false;
    return {
      selection: GardSelection.Text.create({
        anchor: selection.anchor,
        headSide: selection.headSide,
        goalColumn: selection.goalColumn,
        marks: PagesHighlight.removeFromSet(current),
      }),
      userEvent: "mark.remove",
    };
  }
  // Wordgard removes a valued mark only when the value matches, so remove
  // each color present in the selection.
  const { colors } = selectionHighlight(state);
  if (!colors.length) return false;
  return {
    changes: selection.ranges.flatMap((range) =>
      colors.map((color) => ({
        from: range.from,
        to: range.to,
        remove: PagesHighlight.of(color),
      })),
    ),
    userEvent: "mark.remove",
  };
};

/** Wordgard command for the keyboard shortcut: clear a uniform highlight,
 * otherwise apply the given color. */
export const toggleHighlight = (target, color) =>
  selectionHighlight(target.state).color
    ? clearHighlight(target)
    : setHighlight(target, color ?? DEFAULT_HIGHLIGHT);

import { ChangeSet } from "wordgard/doc";
import { GardSelection } from "wordgard/state";
import { KeyBinding, Decoration } from "wordgard/editor";
import { addRow } from "wordgard/table";
import { Table, TableRow, Cell, HeaderCell } from "wordgard/types";
import { Alignment } from "./wordgard-model.mjs";

export const selectedTable = (state) =>
  state.sel.head.matchingParent((node) => node.type === Table.type);
const selectedCell = (state) =>
  state.sel.head.matchingParent((node) => [Cell.type, HeaderCell.type].includes(node.type));

// Header appearance follows the first row without replacing shared cell markers.
// Concurrent row insertion must never turn the same retained header text into
// two independently authored replacement cells.
export const tablePresentation = Decoration.Point.source.of((state) => {
  const entries = [];
  state.doc.iterate((node, position) => {
    if (node.type !== Table.type) return;
    let rowPos = position + 1;
    node.content.forEach((row, index) => {
      let cellPos = rowPos + 1;
      for (const cell of row.content) {
        const align = cell.mark(Alignment);
        const attrs = {
          role: index === 0 ? "columnheader" : "cell",
          "data-table-header": String(index === 0),
        };
        if (["left", "center", "right"].includes(align)) attrs.style = `text-align: ${align}`;
        entries.push([Decoration.Point.attributes(attrs), cellPos]);
        cellPos += cell.length;
      }
      rowPos += row.length;
    });
    return false;
  });
  return Decoration.Point.set(entries);
});

export function insertTable(editor, columns = 3, rows = 3) {
  if (!editor.editable || selectedTable(editor.state)) return false;
  if (![columns, rows].every((n) => Number.isInteger(n) && n >= 1 && n <= 20)) return false;
  const table = Table.create(
    Array.from({ length: rows }, (_, r) =>
      TableRow.create(Array.from({ length: columns }, () => (r ? Cell : HeaderCell).create([]))),
    ),
  );
  const { from, to } = editor.state.selection.replacementRange;
  const changes = ChangeSet.create(editor.state.doc, { from, to, insert: [table], fit: true });
  const position = changes.findInserted((tag) => tag.type === Table.type);
  editor.dispatch({
    changes,
    selection: (cx) => GardSelection.near(cx, position == null ? from : position + 3, 1),
    userEvent: "insert.table",
  });
  return true;
}

export function moveTableCell(editor, direction) {
  if (!editor.editable) return false;
  const table = selectedTable(editor.state),
    cell = selectedCell(editor.state);
  if (!table || !cell) return false;
  const positions = [];
  let pos = table.start;
  for (const row of table.node.content) {
    let at = pos + 1;
    for (const entry of row.content) {
      positions.push(at);
      at += entry.length;
    }
    pos += row.length;
  }
  const index = positions.indexOf(cell.before);
  if (index < 0) return false;
  const next = positions[index + direction];
  if (next !== undefined) {
    editor.dispatch({ selection: GardSelection.cursor(next + 1) });
    return true;
  }
  if (direction < 0) return false;
  const append = addRow({ state: editor.state }, "after");
  if (!append) return false;
  editor.dispatch(append);
  const updated = selectedTable(editor.state);
  if (!updated) return false;
  const last = updated.node.content.at(-1);
  editor.dispatch({ selection: GardSelection.cursor(updated.after - last.length + 1) });
  return true;
}

export const tableKeys = [
  KeyBinding.of({ key: "Tab", run: (editor) => moveTableCell(editor, 1) }),
  KeyBinding.of({ key: "Shift-Tab", run: (editor) => moveTableCell(editor, -1) }),
];

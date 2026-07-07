/**
 * Shared editor registry — single Map<cellId, EditorView> used by both
 * cursor-registry and attribution-registry.
 *
 * Cell components register/unregister their EditorView here once.
 * Both presence cursors and text attribution highlights dispatch
 * StateEffects to the same view instance.
 */

import type { EditorView } from "@codemirror/view";

const editors = new Map<string, EditorView>();

export type CellCursorPosition = "start" | "end";

export interface CellFocusTarget {
  cursorPosition?: CellCursorPosition;
  line?: number;
}

interface NormalizedCellFocusTarget {
  cursorPosition: CellCursorPosition;
  line?: number;
}

interface PendingCellFocus {
  cellId: string;
  target: NormalizedCellFocusTarget;
}

let pendingCellFocus: PendingCellFocus | null = null;

function normalizeCellFocusTarget(
  target: CellCursorPosition | CellFocusTarget = "start",
): NormalizedCellFocusTarget {
  if (typeof target === "string") {
    return { cursorPosition: target };
  }
  return { cursorPosition: "start", ...target };
}

export function focusEditorView(
  view: EditorView,
  target: CellCursorPosition | CellFocusTarget = "start",
): void {
  const focusTarget = normalizeCellFocusTarget(target);
  const doc = view.state.doc;
  const line = typeof focusTarget.line === "number" ? focusTarget.line : null;
  const pos =
    line !== null && Number.isFinite(line) && line > 0
      ? doc.line(Math.max(1, Math.min(Math.floor(line), doc.lines))).from
      : focusTarget.cursorPosition === "end"
        ? doc.length
        : 0;
  view.dispatch({
    selection: { anchor: pos, head: pos },
    scrollIntoView: true,
  });
  view.focus();
}

function applyPendingFocus(pending: PendingCellFocus, view: EditorView): void {
  focusEditorView(view, pending.target);
  if (pendingCellFocus === pending) {
    pendingCellFocus = null;
  }
}

/**
 * Focus a registered editor, or remember the request until the cell registers.
 */
export function requestCellEditorFocus(
  cellId: string,
  target: CellCursorPosition | CellFocusTarget = "start",
): boolean {
  const pending = { cellId, target: normalizeCellFocusTarget(target) };
  pendingCellFocus = pending;

  const view = editors.get(cellId);
  if (!view) return false;

  applyPendingFocus(pending, view);
  return true;
}

export function clearPendingCellFocus(cellId?: string): void {
  if (cellId !== undefined && pendingCellFocus?.cellId !== cellId) return;
  pendingCellFocus = null;
}

/**
 * Register a CodeMirror EditorView for a cell.
 * Both cursor and attribution dispatchers will use this view.
 */
export function registerCellEditor(cellId: string, view: EditorView): void {
  editors.set(cellId, view);
  const pending = pendingCellFocus;
  if (pending?.cellId === cellId) {
    applyPendingFocus(pending, view);
  }
}

/**
 * Unregister an EditorView when a cell unmounts or the view changes.
 */
export function unregisterCellEditor(cellId: string): void {
  editors.delete(cellId);
  clearPendingCellFocus(cellId);
}

/** Get the EditorView for a cell, or undefined if not registered. */
export function getCellEditor(cellId: string): EditorView | undefined {
  return editors.get(cellId);
}

/** Get all registered cell IDs and their EditorViews. */
export function getAllCellEditors(): Map<string, EditorView> {
  return editors;
}

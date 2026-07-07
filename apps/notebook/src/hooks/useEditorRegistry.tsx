import { EditorView } from "@codemirror/view";
import { scrollElementIntoView } from "@/components/notebook";
import { createContext, type ReactNode, useCallback, useContext } from "react";
import {
  clearPendingCellFocus,
  focusEditorView,
  requestCellEditorFocus,
  type CellCursorPosition,
  type CellFocusTarget,
} from "../lib/editor-registry";
import { logger } from "../lib/logger";

interface EditorRegistryContextType {
  focusCell: (cellId: string, target?: CellCursorPosition | CellFocusTarget) => void;
}

const EditorRegistryContext = createContext<EditorRegistryContextType | null>(null);

export function EditorRegistryProvider({ children }: { children: ReactNode }) {
  const focusCell = useCallback(
    (cellId: string, target: CellCursorPosition | CellFocusTarget = "start") => {
      const focusedRegisteredEditor = requestCellEditorFocus(cellId, target);

      const cellElement = document.querySelector(`[data-cell-id="${CSS.escape(cellId)}"]`);
      if (cellElement) {
        scrollElementIntoView(cellElement, { block: "nearest", behavior: "auto" });
      }
      if (focusedRegisteredEditor) return;

      if (!cellElement) {
        logger.warn(`[cell-nav] Cell element not found: ${cellId.slice(0, 8)}`);
        return;
      }

      // Find CodeMirror's content element inside the cell
      const cmContent = cellElement.querySelector(".cm-content");
      if (!cmContent) {
        const fallbackFocusElement = cellElement.querySelector<HTMLElement>(
          "[data-cell-focus-target]",
        );
        if (fallbackFocusElement) {
          clearPendingCellFocus(cellId);
          fallbackFocusElement.focus({ preventScroll: true });
          return;
        }

        // Might be a markdown preview or hidden cell with no explicit fallback.
        logger.debug(`[cell-nav] No focus target in cell: ${cellId.slice(0, 8)}`);
        return;
      }

      // Use CodeMirror's API to find the EditorView from DOM
      const view = EditorView.findFromDOM(cmContent as HTMLElement);
      if (!view) {
        logger.warn(`[cell-nav] EditorView not found for: ${cellId.slice(0, 8)}`);
        return;
      }

      clearPendingCellFocus(cellId);
      focusEditorView(view, target);
    },
    [],
  );

  return (
    <EditorRegistryContext.Provider value={{ focusCell }}>
      {children}
    </EditorRegistryContext.Provider>
  );
}

export function useEditorRegistry() {
  const context = useContext(EditorRegistryContext);
  if (!context) {
    throw new Error("useEditorRegistry must be used within EditorRegistryProvider");
  }
  return context;
}

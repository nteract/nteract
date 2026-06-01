import { EditorView } from "@codemirror/view";
import { createContext, type ReactNode, useCallback, useContext } from "react";
import { logger } from "../lib/logger";

interface EditorRegistryContextType {
  focusCell: (cellId: string, cursorPosition: "start" | "end") => void;
}

const EditorRegistryContext = createContext<EditorRegistryContextType | null>(null);

export function EditorRegistryProvider({ children }: { children: ReactNode }) {
  // Focus a cell's editor using DOM lookup - bypasses registration timing issues
  const focusCell = useCallback((cellId: string, cursorPosition: "start" | "end") => {
    // Find the cell element by data attribute
    const cellElement = document.querySelector(`[data-cell-id="${CSS.escape(cellId)}"]`);
    if (!cellElement) {
      logger.warn(`[cell-nav] Cell element not found: ${cellId.slice(0, 8)}`);
      return;
    }

    // Scroll the cell container into the notebook viewport
    cellElement.scrollIntoView({ block: "nearest", behavior: "smooth" });

    // Find CodeMirror's content element inside the cell
    const cmContent = cellElement.querySelector(".cm-content");
    if (!cmContent) {
      const focusTarget = cellElement.querySelector<HTMLElement>("[data-cell-focus-target]");
      if (focusTarget) {
        focusTarget.focus({ preventScroll: true });
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

    // Set cursor position and focus
    const doc = view.state.doc;
    const pos = cursorPosition === "start" ? 0 : doc.length;
    view.dispatch({
      selection: { anchor: pos, head: pos },
      scrollIntoView: true,
    });
    view.focus();
  }, []);

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

// @vitest-environment jsdom
import type { EditorView } from "@codemirror/view";
import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  clearPendingCellFocus,
  getAllCellEditors,
  registerCellEditor,
  unregisterCellEditor,
} from "../../lib/editor-registry";
import { EditorRegistryProvider, useEditorRegistry } from "../useEditorRegistry";

function FocusProbe({
  cellId,
  cursorPosition,
}: {
  cellId: string;
  cursorPosition?: "start" | "end";
}) {
  const { focusCell } = useEditorRegistry();

  useEffect(() => {
    focusCell(cellId, cursorPosition ?? "start");
  }, [cellId, cursorPosition, focusCell]);

  return null;
}

function RetargetProbe({
  firstCellId,
  secondCellId,
}: {
  firstCellId: string;
  secondCellId: string;
}) {
  const { focusCell } = useEditorRegistry();

  useEffect(() => {
    focusCell(firstCellId, "start");
    focusCell(secondCellId, "end");
  }, [firstCellId, focusCell, secondCellId]);

  return null;
}

function createEditorView(docText = ""): EditorView {
  return {
    state: {
      doc: {
        length: docText.length,
        lines: docText.split("\n").length,
        line: vi.fn((lineNumber: number) => {
          const lines = docText.split("\n");
          const from = lines.slice(0, lineNumber - 1).reduce((offset, line) => {
            return offset + line.length + 1;
          }, 0);
          return { from };
        }),
      },
    },
    dispatch: vi.fn(),
    focus: vi.fn(),
  } as unknown as EditorView;
}

afterEach(() => {
  clearPendingCellFocus();
  getAllCellEditors().clear();
  vi.restoreAllMocks();
});

describe("useEditorRegistry", () => {
  it("focuses a cell focus target when the cell has no CodeMirror editor", () => {
    Element.prototype.scrollIntoView = vi.fn();

    render(
      <EditorRegistryProvider>
        <div data-cell-id="hidden-cell">
          <button type="button" data-cell-focus-target="">
            Show hidden cell
          </button>
        </div>
        <FocusProbe cellId="hidden-cell" />
      </EditorRegistryProvider>,
    );

    expect(document.activeElement?.textContent).toBe("Show hidden cell");
  });

  it.each(["code", "markdown"] as const)(
    "applies pending insert focus when a %s cell editor registers",
    (cellType) => {
      Element.prototype.scrollIntoView = vi.fn();
      const cellId = `${cellType}-cell`;
      const view = createEditorView("hello");

      render(
        <EditorRegistryProvider>
          <div data-cell-id={cellId} data-cell-type={cellType} />
          <FocusProbe cellId={cellId} />
        </EditorRegistryProvider>,
      );

      expect(view.focus).not.toHaveBeenCalled();

      act(() => {
        registerCellEditor(cellId, view);
      });

      expect(view.dispatch).toHaveBeenCalledWith({
        selection: { anchor: 0, head: 0 },
        scrollIntoView: true,
      });
      expect(view.focus).toHaveBeenCalledTimes(1);
    },
  );

  it("retargets pending focus when another cell is focused before registration", () => {
    Element.prototype.scrollIntoView = vi.fn();
    const firstView = createEditorView("first");
    const secondView = createEditorView("second");

    render(
      <EditorRegistryProvider>
        <div data-cell-id="first-cell" />
        <div data-cell-id="second-cell" />
        <RetargetProbe firstCellId="first-cell" secondCellId="second-cell" />
      </EditorRegistryProvider>,
    );

    act(() => {
      registerCellEditor("first-cell", firstView);
    });

    expect(firstView.focus).not.toHaveBeenCalled();

    act(() => {
      registerCellEditor("second-cell", secondView);
    });

    expect(secondView.dispatch).toHaveBeenCalledWith({
      selection: { anchor: 6, head: 6 },
      scrollIntoView: true,
    });
    expect(secondView.focus).toHaveBeenCalledTimes(1);

    unregisterCellEditor("second-cell");
  });
});

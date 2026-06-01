// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { EditorRegistryProvider, useEditorRegistry } from "../useEditorRegistry";

function FocusProbe({
  cellId,
  cursorPosition = "start",
}: {
  cellId: string;
  cursorPosition?: "start" | "end";
}) {
  const { focusCell } = useEditorRegistry();

  useEffect(() => {
    focusCell(cellId, cursorPosition);
  }, [cellId, cursorPosition, focusCell]);

  return null;
}

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
});

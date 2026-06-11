import { describe, it, expect, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useActiveOutlineItemId, useOutlineSelection } from "../outline-interaction";
import type { NotebookOutlineItem } from "runtimed";

describe("useActiveOutlineItemId", () => {
  it("returns null when disabled", () => {
    const items: NotebookOutlineItem[] = [];
    const cellIds: string[] = [];
    const { result } = renderHook(() => useActiveOutlineItemId(items, cellIds, false));
    expect(result.current).toBe(null);
  });

  it("returns null when enabled with empty inputs", () => {
    const items: NotebookOutlineItem[] = [];
    const cellIds: string[] = [];
    const { result } = renderHook(() => useActiveOutlineItemId(items, cellIds, true));
    expect(result.current).toBe(null);
  });

  it("does not throw when enabled", () => {
    const items: NotebookOutlineItem[] = [
      {
        id: "outline-1",
        cellId: "cell-1",
        level: 1,
        content: "Heading 1",
        statusLabel: null,
        headingAnchorId: null,
      },
    ];
    const cellIds = ["cell-1"];
    expect(() => {
      renderHook(() => useActiveOutlineItemId(items, cellIds, true));
    }).not.toThrow();
  });
});

describe("useOutlineSelection", () => {
  it("clears selection when focus moves to a different cell", () => {
    const items: NotebookOutlineItem[] = [
      {
        id: "outline-1",
        cellId: "cell-1",
        level: 1,
        content: "Heading 1",
        statusLabel: null,
        headingAnchorId: null,
      },
      {
        id: "outline-2",
        cellId: "cell-2",
        level: 1,
        content: "Heading 2",
        statusLabel: null,
        headingAnchorId: null,
      },
    ];

    const { result, rerender } = renderHook(
      (props: { focusedCellId: string | null }) =>
        useOutlineSelection({
          outlineItems: items,
          focusedCellId: props.focusedCellId,
          setFocusedCellId: vi.fn(),
        }),
      { initialProps: { focusedCellId: null } },
    );

    // Select outline-1
    act(() => {
      result.current.handleSelectOutlineItem(items[0]);
    });
    expect(result.current.selectedOutlineItemId).toBe("outline-1");

    // Move focus to cell-2 (different from selected outline-1's cell-1)
    rerender({ focusedCellId: "cell-2" });
    expect(result.current.selectedOutlineItemId).toBe(null);
  });

  it("preserves selection when focus stays on the same cell", () => {
    const items: NotebookOutlineItem[] = [
      {
        id: "outline-1",
        cellId: "cell-1",
        level: 1,
        content: "Heading 1",
        statusLabel: null,
        headingAnchorId: null,
      },
    ];

    // Start with focus already on cell-1
    const { result } = renderHook(() =>
      useOutlineSelection({
        outlineItems: items,
        focusedCellId: "cell-1",
        setFocusedCellId: vi.fn(),
      }),
    );

    act(() => {
      result.current.handleSelectOutlineItem(items[0]);
    });
    expect(result.current.selectedOutlineItemId).toBe("outline-1");
  });

  it("works without setFocusedCellId", () => {
    const items: NotebookOutlineItem[] = [
      {
        id: "outline-1",
        cellId: "cell-1",
        level: 1,
        content: "Heading 1",
        statusLabel: null,
        headingAnchorId: null,
      },
    ];

    // When setFocusedCellId is undefined, focus stays null, so the effect will clear selection
    // unless focusedCellId matches the item's cellId
    const { result } = renderHook(() =>
      useOutlineSelection({
        outlineItems: items,
        focusedCellId: "cell-1",
        setFocusedCellId: undefined,
      }),
    );

    expect(() => {
      act(() => {
        result.current.handleSelectOutlineItem(items[0]);
      });
    }).not.toThrow();
    expect(result.current.selectedOutlineItemId).toBe("outline-1");
  });

  it("calls setFocusedCellId when provided", () => {
    const items: NotebookOutlineItem[] = [
      {
        id: "outline-1",
        cellId: "cell-1",
        level: 1,
        content: "Heading 1",
        statusLabel: null,
        headingAnchorId: null,
      },
    ];
    const setFocusedCellId = vi.fn();

    // Simulate the real flow: focusedCellId matches after selection
    const { result, rerender } = renderHook(
      (props: { focusedCellId: string | null }) =>
        useOutlineSelection({
          outlineItems: items,
          focusedCellId: props.focusedCellId,
          setFocusedCellId,
        }),
      { initialProps: { focusedCellId: null } },
    );

    act(() => {
      result.current.handleSelectOutlineItem(items[0]);
    });
    expect(setFocusedCellId).toHaveBeenCalledWith("cell-1");

    // Simulate store update causing rerender with new focusedCellId
    rerender({ focusedCellId: "cell-1" });
    expect(result.current.selectedOutlineItemId).toBe("outline-1");
  });
});

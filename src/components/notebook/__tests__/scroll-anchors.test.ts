import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  captureCellDeletionScrollAnchor,
  isNotebookTailPinned,
  restoreScrollAnchor,
  scrollToDocumentAnchor,
  selectCellDeletionScrollAnchor,
  shouldTailFollowCellCountChange,
} from "../scroll-anchors";

describe("notebook scroll anchors", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("preserves the current top visible anchor when deleting a cell above the viewport", () => {
    const snapshot = selectCellDeletionScrollAnchor(
      [
        candidate("cell-a", -180, -20),
        candidate("cell-b", -10, 120),
        candidate("cell-c", 120, 260),
      ],
      ["cell-a", "cell-b", "cell-c"],
      "cell-a",
      500,
    );

    expect(snapshot).toEqual({
      anchorId: "notebook-cell-cell-b",
      cellId: "cell-b",
      offsetFromContainerTop: -10,
    });
  });

  it("falls forward when the deleted cell is the top visible anchor", () => {
    const snapshot = selectCellDeletionScrollAnchor(
      [candidate("cell-a", -20, 180), candidate("cell-b", 180, 320), candidate("cell-c", 320, 460)],
      ["cell-a", "cell-b", "cell-c"],
      "cell-a",
      500,
    );

    expect(snapshot).toEqual({
      anchorId: "notebook-cell-cell-b",
      cellId: "cell-b",
      offsetFromContainerTop: -20,
    });
  });

  it("falls backward when deleting the last visible cell", () => {
    const snapshot = selectCellDeletionScrollAnchor(
      [candidate("cell-a", -220, -20), candidate("cell-b", -20, 180)],
      ["cell-a", "cell-b"],
      "cell-b",
      500,
    );

    expect(snapshot).toEqual({
      anchorId: "notebook-cell-cell-a",
      cellId: "cell-a",
      offsetFromContainerTop: -20,
    });
  });

  it("skips zero-height candidates when choosing a visible anchor", () => {
    const snapshot = selectCellDeletionScrollAnchor(
      [candidate("hidden-group-placeholder", 0, 0), candidate("cell-b", 24, 160)],
      ["hidden-group-placeholder", "cell-b"],
      "cell-a",
      500,
    );

    expect(snapshot).toEqual({
      anchorId: "notebook-cell-cell-b",
      cellId: "cell-b",
      offsetFromContainerTop: 24,
    });
  });

  it("allows tail-follow only on cell-count increases while pinned", () => {
    expect(shouldTailFollowCellCountChange(2, 3, true)).toBe(true);
    expect(shouldTailFollowCellCountChange(3, 2, true)).toBe(false);
    expect(shouldTailFollowCellCountChange(2, 2, true)).toBe(false);
    expect(shouldTailFollowCellCountChange(2, 3, false)).toBe(false);
  });

  it("computes tail-pinned state from distance or last-cell visibility", () => {
    expect(
      isNotebookTailPinned({
        cellCount: 2,
        containerScrollHeight: 1000,
        containerClientHeight: 400,
        containerScrollTop: 520,
        containerTop: 0,
        containerBottom: 400,
        lastCellTop: 360,
        lastCellBottom: 460,
        thresholdPx: 96,
      }),
    ).toBe(true);

    expect(
      isNotebookTailPinned({
        cellCount: 2,
        containerScrollHeight: 1000,
        containerClientHeight: 400,
        containerScrollTop: 200,
        containerTop: 0,
        containerBottom: 400,
        lastCellTop: 100,
        lastCellBottom: 350,
        thresholdPx: 40,
      }),
    ).toBe(false);
  });

  it("captures and restores a deletion anchor against real DOM positions", () => {
    const { container, cells } = mountScrollFixture([
      ["cell-a", -20, 180],
      ["cell-b", 180, 320],
    ]);

    const snapshot = captureCellDeletionScrollAnchor(container, ["cell-a", "cell-b"], "cell-a");
    expect(snapshot).toEqual({
      anchorId: "notebook-cell-cell-b",
      cellId: "cell-b",
      offsetFromContainerTop: -20,
    });

    setRect(cells["cell-b"], 20, 160);
    container.scrollTop = 240;

    expect(restoreScrollAnchor(container, snapshot)).toBe(true);
    expect(container.scrollTop).toBe(280);
  });

  it("routes anchor navigation through a container-owned DOM lookup", () => {
    const { container, cells } = mountScrollFixture([["cell-a", 0, 100]]);
    cells["cell-a"].scrollIntoView = vi.fn();

    expect(scrollToDocumentAnchor(container, "notebook-cell-cell-a", { behavior: "smooth" })).toBe(
      true,
    );
    expect(cells["cell-a"].scrollIntoView).toHaveBeenCalledWith({
      block: "nearest",
      behavior: "smooth",
      inline: undefined,
    });
  });
});

function candidate(cellId: string, top: number, bottom: number) {
  return {
    anchorId: `notebook-cell-${cellId}`,
    cellId,
    top,
    bottom,
  };
}

function mountScrollFixture(rects: readonly (readonly [string, number, number])[]) {
  const container = document.createElement("div");
  setRect(container, 0, 500);
  Object.defineProperty(container, "scrollHeight", { configurable: true, value: 1000 });
  Object.defineProperty(container, "clientHeight", { configurable: true, value: 500 });
  const cells: Record<string, HTMLElement> = {};

  for (const [cellId, top, bottom] of rects) {
    const cell = document.createElement("div");
    cell.id = `notebook-cell-${cellId}`;
    setRect(cell, top, bottom);
    container.append(cell);
    cells[cellId] = cell;
  }

  document.body.append(container);
  return { container, cells };
}

function setRect(element: Element, top: number, bottom: number): void {
  element.getBoundingClientRect = vi.fn(
    () =>
      ({
        x: 0,
        y: top,
        top,
        bottom,
        left: 0,
        right: 100,
        width: 100,
        height: bottom - top,
        toJSON: () => ({}),
      }) as DOMRect,
  );
}

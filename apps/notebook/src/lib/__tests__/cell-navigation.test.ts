import { describe, expect, it } from "vite-plus/test";
import { findAdjacentVisibleCellId } from "../cell-navigation";

describe("findAdjacentVisibleCellId", () => {
  const cellIds = ["a", "b", "c", "d", "e"];
  const visible = new Set(["a", "b", "e"]);
  const isVisible = (cellId: string) => visible.has(cellId);

  it("finds adjacent visible cells in both directions", () => {
    expect(findAdjacentVisibleCellId(cellIds, "a", "next", isVisible)).toBe("b");
    expect(findAdjacentVisibleCellId(cellIds, "e", "previous", isVisible)).toBe("b");
  });

  it("skips collapsed hidden-group members", () => {
    expect(findAdjacentVisibleCellId(cellIds, "b", "next", isVisible)).toBe("e");
    expect(findAdjacentVisibleCellId(cellIds, "e", "previous", isVisible)).toBe("b");
  });

  it("returns null at boundaries and for missing current cells", () => {
    expect(findAdjacentVisibleCellId(cellIds, "a", "previous", isVisible)).toBeNull();
    expect(findAdjacentVisibleCellId(cellIds, "e", "next", isVisible)).toBeNull();
    expect(findAdjacentVisibleCellId(cellIds, "missing", "next", isVisible)).toBeNull();
  });
});

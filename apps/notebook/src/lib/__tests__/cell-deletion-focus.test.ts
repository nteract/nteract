import { describe, expect, it } from "vite-plus/test";
import { getFocusAfterCellDeletion } from "../cell-deletion-focus";

describe("getFocusAfterCellDeletion", () => {
  it("selects the next cell when one survives below the deleted cell", () => {
    expect(getFocusAfterCellDeletion(["a", "b", "c"], "b")).toBe("c");
  });

  it("selects the previous cell when deleting the last cell", () => {
    expect(getFocusAfterCellDeletion(["a", "b", "c"], "c")).toBe("b");
  });

  it("returns null when deleting the only cell", () => {
    expect(getFocusAfterCellDeletion(["a"], "a")).toBeNull();
  });

  it("returns null when the deleted cell is not in the snapshot", () => {
    expect(getFocusAfterCellDeletion(["a", "b"], "missing")).toBeNull();
  });
});

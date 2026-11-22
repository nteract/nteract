import { describe, expect, it } from "vite-plus/test";
import { getFocusAfterCellDeletion, getFocusAfterCellsDeletion } from "../cell-deletion-focus";

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

describe("getFocusAfterCellsDeletion", () => {
  it("selects the first survivor after the last deleted cell, never a deleted one", () => {
    expect(getFocusAfterCellsDeletion(["a", "p", "r1", "r2", "b"], ["r1", "r2", "p"])).toBe("b");
    expect(getFocusAfterCellsDeletion(["a", "p", "r1", "r2"], ["r1", "r2", "p"])).toBe("a");
  });

  it("skips survivors between deleted cells when none follows", () => {
    expect(getFocusAfterCellsDeletion(["a", "p", "x", "r1"], ["p", "r1"])).toBe("x");
  });

  it("returns null when nothing survives or nothing is deleted", () => {
    expect(getFocusAfterCellsDeletion(["p", "r1"], ["p", "r1"])).toBeNull();
    expect(getFocusAfterCellsDeletion(["a", "b"], ["missing"])).toBeNull();
  });
});

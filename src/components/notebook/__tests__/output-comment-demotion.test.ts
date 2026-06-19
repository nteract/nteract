import { describe, expect, it } from "vitest";
import {
  shouldDemoteOutputCommentAnchor,
  type OutputCommentAnchor,
  type OutputCommentAnchorRuntimeState,
} from "../output-comment-demotion";

function outputAnchor(
  executionId: string | null = "execution-1",
  outputId: string | null = "output-1",
): OutputCommentAnchor {
  return {
    kind: "output",
    cell_id: "cell-1",
    execution_id: executionId,
    output_id: outputId,
  };
}

function runtimeState(
  currentExecutionId = "execution-1",
  currentOutputIds: readonly string[] = ["output-1"],
): OutputCommentAnchorRuntimeState {
  return {
    cellExists: true,
    currentExecutionId,
    currentOutputIds,
  };
}

describe("shouldDemoteOutputCommentAnchor", () => {
  it("demotes when the anchored execution is stale", () => {
    expect(
      shouldDemoteOutputCommentAnchor(outputAnchor("execution-1"), runtimeState("execution-2")),
    ).toBe(true);
  });

  it("keeps anchors that still point at the current execution", () => {
    expect(shouldDemoteOutputCommentAnchor(outputAnchor(), runtimeState())).toBe(false);
  });

  it("demotes when the anchored output id is missing from the current execution", () => {
    expect(
      shouldDemoteOutputCommentAnchor(outputAnchor("execution-1", "output-2"), runtimeState()),
    ).toBe(true);
  });

  it("does not demote while the cell store has not loaded the cell yet", () => {
    // Reconnect / notebook switch: comments projection is preserved while the
    // cell store is momentarily empty. Absence is not detachment.
    expect(
      shouldDemoteOutputCommentAnchor(outputAnchor("execution-1"), {
        cellExists: false,
        currentExecutionId: null,
        currentOutputIds: [],
      }),
    ).toBe(false);
  });

  it("does not demote while the runtime state has no loaded execution yet", () => {
    // Cell is back but RuntimeStateDoc execution pointers have not landed.
    // A stale-looking anchor must wait, not demote on the empty window.
    expect(
      shouldDemoteOutputCommentAnchor(outputAnchor("execution-1", "output-1"), {
        cellExists: true,
        currentExecutionId: null,
        currentOutputIds: [],
      }),
    ).toBe(false);
  });
});

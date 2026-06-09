import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { resetNotebookExecutions, setNotebookQueueProjection } from "../notebook-executions";
import {
  useCellQueuePriority,
  useIsCellExecuting,
  useIsCellQueued,
  useIsGroupExecuting,
} from "../cell-ui-state";

afterEach(() => {
  resetNotebookExecutions();
});

describe("cell UI queue projection", () => {
  it("derives cell chrome from the shared execution queue projection", () => {
    const { result } = renderHook(() => ({
      running: useIsCellExecuting("cell-1"),
      queued: useIsCellQueued("cell-2"),
      priority: useCellQueuePriority("cell-2"),
      groupRunning: useIsGroupExecuting(["cell-1", "cell-3"]),
      // A group of only queued cells is not "executing": group chrome tracks the
      // single running cell from the projection, not queue membership.
      groupQueuedOnly: useIsGroupExecuting(["cell-2", "cell-3"]),
    }));

    expect(result.current).toEqual({
      running: false,
      queued: false,
      priority: 0,
      groupRunning: false,
      groupQueuedOnly: false,
    });

    act(() => {
      setNotebookQueueProjection({
        executing_cell_id: "cell-1",
        queued_cell_ids: ["cell-2", "cell-3"],
      });
    });

    expect(result.current).toEqual({
      running: true,
      queued: true,
      priority: 1,
      groupRunning: true,
      groupQueuedOnly: false,
    });

    act(() => {
      setNotebookQueueProjection({
        executing_cell_id: null,
        queued_cell_ids: [],
      });
    });

    expect(result.current).toEqual({
      running: false,
      queued: false,
      priority: 0,
      groupRunning: false,
      groupQueuedOnly: false,
    });
  });
});

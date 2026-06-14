import { renderHook, act } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it } from "vite-plus/test";

// Render count matters here: we want to verify that output mutations do
// NOT cause `useCell` to surface a new snapshot, which would indicate
// chrome re-renders are still coupled to outputs.
import type { JupyterOutput, NotebookCell } from "../../types";
import {
  resetNotebookExecutions,
  setCellExecutionPointer,
  setExecution,
} from "../notebook-executions";
import {
  getCellIdsSnapshot,
  replaceNotebookCells,
  resetNotebookCells,
  useCell,
} from "../notebook-cells";
import {
  deleteOutput,
  useOutputStructureVersion,
  useOutputsVersion,
  resetNotebookOutputs,
  setOutput,
  useCellOutputs,
} from "../notebook-outputs";
import { useNotebookViewModel } from "../notebook-view-model";

// ---------------------------------------------------------------------------
// Phase C-lite acceptance: decoupling cell subscriptions from outputs.
//
// The goal is that an output mutation (stream append, blob resolution, etc.)
// does NOT cause `useCell(cellId)` to return a new NotebookCell reference —
// the cell's chrome (source, execution_count, metadata) is unaffected. Only
// `useCellOutputs(cellId)` re-derives.
// ---------------------------------------------------------------------------

afterEach(() => {
  resetNotebookCells();
  resetNotebookOutputs();
  resetNotebookExecutions();
});

function streamOutput(text: string): JupyterOutput {
  return { output_type: "stream", name: "stdout", text };
}

function errorOutput(ename: string): JupyterOutput {
  return {
    output_type: "error",
    ename,
    evalue: "boom",
    traceback: [],
  };
}

function imageOutput(payload = "iVBORw0KGgo="): JupyterOutput {
  return {
    output_id: "plot-output",
    output_type: "display_data",
    data: { "image/png": payload },
    metadata: {},
  };
}

function codeCell(id: string): NotebookCell {
  return {
    id,
    cell_type: "code",
    source: "print('hi')",
    execution_count: null,
    outputs: [],
    metadata: {},
  };
}

describe("Phase C-lite: cell subscription / outputs decoupling", () => {
  it("keeps structural output version stable for a stream append burst", () => {
    const structureRenderCount = { current: 0 };
    const structureOnly = renderHook(() => {
      structureRenderCount.current += 1;
      return useOutputStructureVersion();
    });
    const { result } = renderHook(() => ({
      anyOutputVersion: useOutputsVersion(),
      structureVersion: useOutputStructureVersion(),
    }));

    const initialAny = result.current.anyOutputVersion;
    const initialStructure = result.current.structureVersion;

    act(() => {
      setOutput("o1", streamOutput("a"));
    });

    expect(result.current.anyOutputVersion).toBe(initialAny + 1);
    expect(result.current.structureVersion).toBe(initialStructure + 1);
    expect(structureOnly.result.current).toBe(initialStructure + 1);
    expect(structureRenderCount.current).toBe(2);

    const burstSize = 1000;
    act(() => {
      for (let i = 0; i < burstSize; i++) {
        setOutput("o1", streamOutput(`a-appended-${i}`));
      }
    });

    expect(result.current.anyOutputVersion).toBe(initialAny + 1 + burstSize);
    expect(result.current.structureVersion).toBe(initialStructure + 1);
    expect(structureOnly.result.current).toBe(initialStructure + 1);
    expect(structureRenderCount.current).toBe(2);

    act(() => {
      setOutput("o1", errorOutput("RuntimeError"));
    });

    expect(result.current.anyOutputVersion).toBe(initialAny + 2 + burstSize);
    expect(result.current.structureVersion).toBe(initialStructure + 2);
    expect(structureOnly.result.current).toBe(initialStructure + 2);
    expect(structureRenderCount.current).toBe(3);

    act(() => {
      deleteOutput("o1");
    });

    expect(result.current.anyOutputVersion).toBe(initialAny + 3 + burstSize);
    expect(result.current.structureVersion).toBe(initialStructure + 3);
    expect(structureOnly.result.current).toBe(initialStructure + 3);
    expect(structureRenderCount.current).toBe(4);
  });

  it("output mutations don't change the cell snapshot reference", () => {
    replaceNotebookCells([codeCell("c1")]);
    // Sanity: the cell landed in the store
    expect(getCellIdsSnapshot()).toEqual(["c1"]);

    // Wire an execution + initial output
    act(() => {
      setOutput("o1", streamOutput("a"));
      setExecution("exec-1", {
        execution_count: 1,
        status: "running",
        success: null,
        output_ids: ["o1"],
      });
      setCellExecutionPointer("c1", "exec-1");
    });

    // Subscribe with a render counter. If the cell snapshot changed on
    // output mutations, the hook would re-run and the ref would increment.
    const { result } = renderHook(() => {
      const renderCount = useRef(0);
      renderCount.current += 1;
      const cell = useCell("c1");
      const outputs = useCellOutputs("c1");
      return { renderCount, cell, outputs };
    });

    const initialCell = result.current.cell;
    const initialOutputs = result.current.outputs;
    expect(initialCell?.id).toBe("c1");
    expect(initialOutputs).toHaveLength(1);

    // Mutate the output. The cell snapshot must NOT change — only the
    // outputs derivation should advance.
    act(() => {
      setOutput("o1", streamOutput("a-appended"));
    });

    expect(result.current.cell).toBe(initialCell);
    expect(result.current.outputs).not.toBe(initialOutputs);
    expect((result.current.outputs[0] as { text: string }).text).toBe(
      "a-appended",
    );

    // Add another output — still no cell snapshot change.
    act(() => {
      setOutput("o2", streamOutput("b"));
      setExecution("exec-1", {
        execution_count: 1,
        status: "running",
        success: null,
        output_ids: ["o1", "o2"],
      });
    });

    expect(result.current.cell).toBe(initialCell);
    expect(result.current.outputs).toHaveLength(2);
  });

  it("refreshes notebook view model outline items when a raster output payload lands", () => {
    act(() => {
      replaceNotebookCells([codeCell("plot")]);
      setOutput("plot-output", imageOutput(""));
      setExecution("exec-plot", {
        execution_count: 1,
        status: "running",
        success: null,
        output_ids: ["plot-output"],
      });
      setCellExecutionPointer("plot", "exec-plot");
    });

    const { result } = renderHook(() => useNotebookViewModel());

    expect(result.current.outlineItems.some((item) => item.kind === "output")).toBe(false);

    act(() => {
      setOutput("plot-output", imageOutput());
    });

    expect(result.current.outlineItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "plot:output:plot-output",
          kind: "output",
          imagePreview: expect.objectContaining({ mimeType: "image/png" }),
        }),
      ]),
    );
  });

  it("does not re-render cell A when only cell B's outputs change", () => {
    // Seed both cells with one output each.
    const oA = streamOutput("cell-a-initial");
    const oB = streamOutput("cell-b-initial");
    act(() => {
      setOutput("oA", oA);
      setOutput("oB", oB);
      setExecution("exec-a", {
        execution_count: 1,
        status: "running",
        success: null,
        output_ids: ["oA"],
      });
      setExecution("exec-b", {
        execution_count: 1,
        status: "running",
        success: null,
        output_ids: ["oB"],
      });
      setCellExecutionPointer("A", "exec-a");
      setCellExecutionPointer("B", "exec-b");
    });

    const { result } = renderHook(() => {
      const rendersA = useRef(0);
      rendersA.current += 1;
      const outputs = useCellOutputs("A");
      return { outputs, rendersA };
    });

    const rendersBeforeB = result.current.rendersA.current;
    const outputsBeforeB = result.current.outputs;

    // Mutate cell B's output. Cell A's hook should not react.
    act(() => {
      setOutput("oB", streamOutput("cell-b-updated"));
    });

    expect(result.current.rendersA.current).toBe(rendersBeforeB);
    expect(result.current.outputs).toBe(outputsBeforeB);
  });
});

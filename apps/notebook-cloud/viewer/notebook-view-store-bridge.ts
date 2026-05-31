import type { JupyterOutput as SharedJupyterOutput } from "@/components/cell/jupyter-output";
import { replaceNotebookCells, updateCellById } from "../../notebook/src/lib/notebook-cells";
import {
  setCellExecutionPointer,
  setExecution,
  setNotebookQueueProjection,
} from "../../notebook/src/lib/notebook-executions";
import { setOutput } from "../../notebook/src/lib/notebook-outputs";
import type { JupyterOutput, NotebookCell } from "../../notebook/src/types";
import type { ResolvedCell } from "./render-resolution";

export function projectCloudCellsIntoNotebookViewStores(cells: readonly ResolvedCell[]): void {
  replaceNotebookCells(cells.map(resolvedCellToNotebookCell));
  setNotebookQueueProjection({
    executing_cell_id: null,
    queued_cell_ids: [],
  });

  for (const cell of cells) {
    if (cell.cellType !== "code") {
      setCellExecutionPointer(cell.id, null);
      continue;
    }

    const outputs = cell.outputs.map((output, index) =>
      normalizeOutputForNotebookView(output, cell.id, index),
    );
    for (const output of outputs) {
      if (output.output_id) {
        setOutput(output.output_id, output);
      }
    }

    const outputIds = outputs
      .map((output) => output.output_id)
      .filter((outputId): outputId is string => typeof outputId === "string");
    const executionId =
      cell.executionId ?? (outputIds.length > 0 ? `cloud-execution:${cell.id}` : null);
    setCellExecutionPointer(cell.id, executionId);
    if (executionId) {
      setExecution(executionId, {
        execution_count: cell.executionCount,
        status: "done",
        success: null,
        output_ids: outputIds,
      });
    }
  }
}

export function updateCloudCellSourceInNotebookViewStore(cellId: string, source: string): void {
  updateCellById(cellId, (cell) => ({ ...cell, source }));
}

function resolvedCellToNotebookCell(cell: ResolvedCell): NotebookCell {
  const metadata = cell.metadata ?? {};
  if (cell.cellType === "code") {
    return {
      cell_type: "code",
      id: cell.id,
      source: cell.source,
      execution_count: cell.executionCount,
      outputs: cell.outputs.map((output, index) =>
        normalizeOutputForNotebookView(output, cell.id, index),
      ),
      metadata,
    };
  }

  if (cell.cellType === "markdown") {
    return {
      cell_type: "markdown",
      id: cell.id,
      source: cell.source,
      metadata,
    };
  }

  return {
    cell_type: "raw",
    id: cell.id,
    source: cell.source,
    metadata,
  };
}

function normalizeOutputForNotebookView(
  output: SharedJupyterOutput,
  cellId: string,
  index: number,
): JupyterOutput {
  const output_id = output.output_id ?? `cloud-output:${cellId}:${index}`;
  if (output.output_type === "stream") {
    return {
      ...output,
      output_id,
      text: Array.isArray(output.text) ? output.text.join("") : output.text,
    };
  }
  return {
    ...output,
    output_id,
  } as JupyterOutput;
}

import type { JupyterOutput as SharedJupyterOutput } from "@/components/cell/jupyter-output";
import {
  replaceNotebookCells,
  type NotebookStoreCell,
  type NotebookStoreOutput,
} from "@/components/notebook/state/cell-store";
import {
  deleteExecutions,
  setCellExecutionPointer,
  setExecution,
  setNotebookQueueProjection,
} from "@/components/notebook/state/execution-store";
import { deleteOutputs, setOutput } from "@/components/notebook/state/output-store";
import type { ResolvedCell } from "./render-resolution";

let cloudOwnedExecutionIds = new Set<string>();
let cloudOwnedOutputIds = new Set<string>();

export function projectCloudCellsIntoNotebookViewStores(cells: readonly ResolvedCell[]): void {
  const projectedCells = cells.map((cell) => {
    const outputs =
      cell.cellType === "code"
        ? cell.outputs.map((output, index) =>
            normalizeOutputForNotebookView(output, cell.id, index),
          )
        : [];
    return { cell, notebookCell: resolvedCellToNotebookCell(cell, outputs), outputs };
  });

  replaceNotebookCells(projectedCells.map(({ notebookCell }) => notebookCell));
  setNotebookQueueProjection({
    executing_cell_id: null,
    queued_cell_ids: [],
  });

  const nextCloudOwnedExecutionIds = new Set<string>();
  const nextCloudOwnedOutputIds = new Set<string>();

  for (const { cell, outputs } of projectedCells) {
    if (cell.cellType !== "code") {
      setCellExecutionPointer(cell.id, null);
      continue;
    }

    for (const output of outputs) {
      if (output.output_id) {
        nextCloudOwnedOutputIds.add(output.output_id);
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
      nextCloudOwnedExecutionIds.add(executionId);
      setExecution(executionId, {
        execution_count: cell.executionCount,
        status: "done",
        success: null,
        output_ids: outputIds,
      });
    }
  }

  deleteOutputs(difference(cloudOwnedOutputIds, nextCloudOwnedOutputIds));
  deleteExecutions(difference(cloudOwnedExecutionIds, nextCloudOwnedExecutionIds));
  cloudOwnedOutputIds = nextCloudOwnedOutputIds;
  cloudOwnedExecutionIds = nextCloudOwnedExecutionIds;
}

export function resetCloudViewStoreProjection(): void {
  replaceNotebookCells([]);
  setNotebookQueueProjection({
    executing_cell_id: null,
    queued_cell_ids: [],
  });
  deleteOutputs([...cloudOwnedOutputIds]);
  deleteExecutions([...cloudOwnedExecutionIds]);
  cloudOwnedOutputIds = new Set<string>();
  cloudOwnedExecutionIds = new Set<string>();
}

function resolvedCellToNotebookCell(
  cell: ResolvedCell,
  outputs: readonly NotebookStoreOutput[],
): NotebookStoreCell {
  const metadata = cell.metadata ?? {};
  if (cell.cellType === "code") {
    return {
      cell_type: "code",
      id: cell.id,
      source: cell.source,
      execution_count: cell.executionCount,
      outputs: [...outputs],
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
): NotebookStoreOutput {
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
  } as NotebookStoreOutput;
}

function difference(previous: ReadonlySet<string>, next: ReadonlySet<string>): string[] {
  const removed: string[] = [];
  for (const id of previous) {
    if (!next.has(id)) {
      removed.push(id);
    }
  }
  return removed;
}

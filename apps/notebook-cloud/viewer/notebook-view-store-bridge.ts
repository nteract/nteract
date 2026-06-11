import type { JupyterOutput as SharedJupyterOutput } from "@/components/cell/jupyter-output";
import {
  replaceNotebookCells,
  type NotebookStoreCell,
  type NotebookStoreOutput,
} from "@/components/notebook/state/cell-store";
import { projectMarkdownPlan } from "@/lib/markdown-projection";
import {
  deleteExecutions,
  getExecutionById,
  setCellExecutionPointer,
  setExecution,
  setNotebookQueueProjection,
} from "@/components/notebook/state/execution-store";
import { deleteOutputs, setOutput } from "@/components/notebook/state/output-store";
import {
  getCellIdsSnapshot,
  resetRuntimeState,
  resetRuntimeStoresProjection,
  shouldPreserveBootstrapProjection,
} from "../../notebook/src/notebook-surface-stores";
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
    const syntheticExecutionId = outputIds.length > 0 ? `cloud-execution:${cell.id}` : null;
    const executionId = cell.executionId ?? syntheticExecutionId;
    setCellExecutionPointer(cell.id, executionId);
    if (executionId && !getExecutionById(executionId)) {
      if (executionId === syntheticExecutionId) {
        nextCloudOwnedExecutionIds.add(executionId);
      }
      // Snapshot/live cell materialization can seed a display placeholder, but
      // it must never downgrade a real RuntimeStateDoc execution snapshot.
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

/**
 * Bootstrap-preservation gate over EVERY store the cloud projection paints
 * (desktop pattern: useAutomergeNotebook's beforeBootstrap). CodeCell renders
 * outputs exclusively through the execution/output stores — preserving the
 * cell store while wiping those still blanks every output and execution
 * count, which is the dominant visual mass of a painted notebook. So the
 * gate keeps or clears them together; `resetPoolState` stays with the
 * caller, unconditional, matching desktop.
 *
 * Stale-data safety on preserve: the next materialization replaces cells
 * wholesale and `projectCloudCellsIntoNotebookViewStores` sweeps stale
 * cloud-owned output/execution ids via the `cloudOwned*` difference sets,
 * which this function leaves intact.
 *
 * Returns true when the painted projection was preserved.
 */
export function resetCloudProjectionUnlessPreserved(options: {
  /** `id:`-prefixed identity of the notebook whose cells are painted, or null. */
  paintedNotebookIdentity: string | null;
  /** `id:`-prefixed identity of the notebook this session targets. */
  nextNotebookIdentity: string;
}): boolean {
  const preserve = shouldPreserveBootstrapProjection({
    previousIdentity: options.paintedNotebookIdentity,
    nextIdentity: options.nextNotebookIdentity,
    visibleCellCount: getCellIdsSnapshot().length,
  });
  if (!preserve) {
    resetCloudViewStoreProjection();
    resetRuntimeState();
    resetRuntimeStoresProjection();
  }
  return preserve;
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
      markdownProjection: projectMarkdownPlan(cell.source) ?? undefined,
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

import type { JupyterOutput } from "../../cell/jupyter-output";
import { projectMarkdownPlan } from "../../../lib/markdown-projection";
import {
  replaceNotebookCells,
  type NotebookCellMetadata,
  type NotebookStoreCell,
  type NotebookStoreOutput,
} from "./cell-store";
import {
  deleteExecutions,
  getCellExecutionId,
  getExecutionById,
  setCellExecutionPointer,
  setExecution,
  setNotebookQueueProjection,
} from "./execution-store";
import { deleteOutputs, getOutputById, setOutput } from "./output-store";

export interface NotebookViewStoreProjectionCell {
  id: string;
  cellType: "code" | "markdown" | "raw";
  source: string;
  executionId: string | null;
  executionCount: number | null;
  outputs: readonly JupyterOutput[];
  metadata?: NotebookCellMetadata | null;
}

export interface NotebookViewStoreProjectorOptions {
  syntheticExecutionId?: (cellId: string) => string;
  syntheticOutputId?: (cellId: string, outputIndex: number) => string;
  syntheticOutputPrefix?: (cellId: string) => string;
}

export interface ResetNotebookViewStoreProjectionOptions {
  resetQueue?: boolean;
}

const RUNT_OUTPUT_CACHE_KEY = "_runt_output_cache_key";

/**
 * Host-neutral projector from materialized notebook cells into the shared
 * NotebookView stores.
 *
 * Hosts still own transport, authority, and source facts. This class owns the
 * common projection mechanics: cell-store replacement, per-output/execution
 * store seeding, synthetic display placeholders, and cleanup of entries this
 * projector created.
 */
export class NotebookViewStoreProjector {
  private ownedExecutionIds = new Set<string>();
  private ownedOutputIds = new Set<string>();
  private readonly outputCacheKeys = new WeakMap<NotebookStoreOutput, string>();
  private readonly syntheticExecutionId: (cellId: string) => string;
  private readonly syntheticOutputId: (cellId: string, outputIndex: number) => string;
  private readonly syntheticOutputPrefix: (cellId: string) => string | null;

  constructor({
    syntheticExecutionId = (cellId) => `notebook-view-execution:${cellId}`,
    syntheticOutputId = (cellId, outputIndex) => `notebook-view-output:${cellId}:${outputIndex}`,
    syntheticOutputPrefix,
  }: NotebookViewStoreProjectorOptions = {}) {
    this.syntheticExecutionId = syntheticExecutionId;
    this.syntheticOutputId = syntheticOutputId;
    this.syntheticOutputPrefix = syntheticOutputPrefix ?? (() => null);
  }

  projectCells(cells: readonly NotebookViewStoreProjectionCell[]): void {
    const projectedCells = cells.map((cell) => {
      const outputs =
        cell.cellType === "code"
          ? cell.outputs.map((output, index) =>
              this.normalizeOutputForNotebookView(output, cell.id, index),
            )
          : [];
      return { cell, notebookCell: this.resolvedCellToNotebookCell(cell, outputs), outputs };
    });

    replaceNotebookCells(projectedCells.map(({ notebookCell }) => notebookCell));

    const nextOwnedExecutionIds = new Set<string>();
    const nextOwnedOutputIds = new Set<string>();

    for (const { cell, outputs } of projectedCells) {
      if (cell.cellType !== "code") {
        setCellExecutionPointer(cell.id, null);
        continue;
      }

      for (const output of outputs) {
        if (output.output_id) {
          nextOwnedOutputIds.add(output.output_id);
          setOutput(output.output_id, output);
        }
      }

      const outputIds = outputs
        .map((output) => output.output_id)
        .filter((outputId): outputId is string => typeof outputId === "string");
      const syntheticExecutionId = outputIds.length > 0 ? this.syntheticExecutionId(cell.id) : null;
      const executionId = cell.executionId ?? syntheticExecutionId;
      const existingExecution = executionId ? getExecutionById(executionId) : undefined;
      const projectorOwnsExecution =
        executionId !== null && (this.ownedExecutionIds.has(executionId) || !existingExecution);
      setCellExecutionPointer(cell.id, executionId);
      if (executionId && projectorOwnsExecution) {
        nextOwnedExecutionIds.add(executionId);
      }
      if (executionId && !existingExecution) {
        // Snapshot/live cell materialization can seed a display placeholder,
        // but it must never downgrade a real RuntimeStateDoc execution snapshot.
        setExecution(executionId, {
          execution_count: cell.executionCount,
          status: "done",
          success: null,
          output_ids: outputIds,
        });
      }
    }

    deleteOutputs(difference(this.ownedOutputIds, nextOwnedOutputIds));
    deleteExecutions(difference(this.ownedExecutionIds, nextOwnedExecutionIds));
    this.ownedOutputIds = nextOwnedOutputIds;
    this.ownedExecutionIds = nextOwnedExecutionIds;
  }

  cleanupRemovedCells(removedCellIds: readonly string[]): void {
    const outputIdsToDelete = new Set<string>();
    const executionIdsToDelete = new Set<string>();

    for (const cellId of removedCellIds) {
      const syntheticExecutionId = this.syntheticExecutionId(cellId);
      const executionId =
        getCellExecutionId(cellId) ??
        (getExecutionById(syntheticExecutionId) ? syntheticExecutionId : null);

      if (executionId) {
        const execution = getExecutionById(executionId);
        if (execution) {
          for (const outputId of execution.output_ids) {
            if (this.ownedOutputIds.has(outputId)) {
              outputIdsToDelete.add(outputId);
            }
          }
        }
        if (this.ownedExecutionIds.has(executionId)) {
          executionIdsToDelete.add(executionId);
        }
      }

      const syntheticOutputPrefix = this.syntheticOutputPrefix(cellId);
      if (syntheticOutputPrefix) {
        for (const outputId of this.ownedOutputIds) {
          if (outputId.startsWith(syntheticOutputPrefix)) {
            outputIdsToDelete.add(outputId);
          }
        }
      }

      setCellExecutionPointer(cellId, null);
    }

    if (outputIdsToDelete.size > 0) {
      deleteOutputs(outputIdsToDelete);
      for (const outputId of outputIdsToDelete) {
        this.ownedOutputIds.delete(outputId);
      }
    }

    if (executionIdsToDelete.size > 0) {
      deleteExecutions(executionIdsToDelete);
      for (const executionId of executionIdsToDelete) {
        this.ownedExecutionIds.delete(executionId);
      }
    }
  }

  reset({ resetQueue = false }: ResetNotebookViewStoreProjectionOptions = {}): void {
    replaceNotebookCells([]);
    if (resetQueue) {
      setNotebookQueueProjection({
        executing_cell_id: null,
        queued_cell_ids: [],
      });
    }
    deleteOutputs([...this.ownedOutputIds]);
    deleteExecutions([...this.ownedExecutionIds]);
    this.ownedOutputIds = new Set<string>();
    this.ownedExecutionIds = new Set<string>();
  }

  private resolvedCellToNotebookCell(
    cell: NotebookViewStoreProjectionCell,
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

  private normalizeOutputForNotebookView(
    output: JupyterOutput,
    cellId: string,
    index: number,
  ): NotebookStoreOutput {
    const output_id = output.output_id ?? this.syntheticOutputId(cellId, index);
    const previous = getOutputById(output_id);
    let normalized: NotebookStoreOutput;

    if (output.output_type === "stream") {
      const text = Array.isArray(output.text) ? output.text.join("") : output.text;
      normalized =
        output.output_id === output_id && output.text === text
          ? (output as NotebookStoreOutput)
          : {
              ...output,
              output_id,
              text,
            };
      return this.finalizeOutputForNotebookView(
        this.reusePreviousOutputIfEqual(previous, normalized),
      );
    }

    normalized =
      output.output_id === output_id
        ? (output as NotebookStoreOutput)
        : ({
            ...output,
            output_id,
          } as NotebookStoreOutput);
    return this.finalizeOutputForNotebookView(
      this.reusePreviousOutputIfEqual(previous, normalized),
    );
  }

  private reusePreviousOutputIfEqual(
    previous: NotebookStoreOutput | undefined,
    next: NotebookStoreOutput,
  ): NotebookStoreOutput {
    if (!previous || previous === next) return next;
    const previousCacheKey = this.outputCacheKeyForEquality(previous);
    const nextCacheKey = this.outputCacheKeyForEquality(next);
    if (previousCacheKey !== null && nextCacheKey !== null) {
      return previousCacheKey === nextCacheKey ? previous : next;
    }
    const previousSerialized = serializedOutput(previous);
    return previousSerialized !== null && previousSerialized === serializedOutput(next)
      ? previous
      : next;
  }

  private finalizeOutputForNotebookView(output: NotebookStoreOutput): NotebookStoreOutput {
    const cacheKey = this.outputCacheKeyForEquality(output);
    const stripped = stripOutputCacheKey(output);
    if (cacheKey !== null) {
      this.outputCacheKeys.set(stripped, cacheKey);
    }
    return stripped;
  }

  private outputCacheKeyForEquality(output: NotebookStoreOutput): string | null {
    return stampedOutputCacheKey(output) ?? this.outputCacheKeys.get(output) ?? null;
  }
}

export function createNotebookViewStoreProjector(
  options?: NotebookViewStoreProjectorOptions,
): NotebookViewStoreProjector {
  return new NotebookViewStoreProjector(options);
}

function stampedOutputCacheKey(output: unknown): string | null {
  if (typeof output !== "object" || output === null) return null;
  const key = (output as Record<string, unknown>)[RUNT_OUTPUT_CACHE_KEY];
  return typeof key === "string" ? key : null;
}

function stripOutputCacheKey(output: NotebookStoreOutput): NotebookStoreOutput {
  if (!Object.prototype.hasOwnProperty.call(output, RUNT_OUTPUT_CACHE_KEY)) {
    return output;
  }
  const { [RUNT_OUTPUT_CACHE_KEY]: _cacheKey, ...stripped } = output as NotebookStoreOutput &
    Record<string, unknown>;
  return stripped as NotebookStoreOutput;
}

function serializedOutput(output: NotebookStoreOutput): string | null {
  try {
    return JSON.stringify(output);
  } catch {
    return null;
  }
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

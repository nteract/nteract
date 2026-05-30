import type { BlobResolver } from "runtimed";
import {
  resolveCell,
  resolveCellSync,
  type OutputResolutionCache,
  type RenderCell,
  type ResolvedCell,
} from "./render-resolution";

export interface ProgressiveCellResolutionCallbacks {
  shouldContinue?: () => boolean;
  onInitialCells?: (cells: ResolvedCell[]) => void;
  onCellResolved?: (cell: ResolvedCell, index: number, cells: ResolvedCell[]) => void;
  maxConcurrentAsyncCells?: number;
}

export const DEFAULT_ASYNC_CELL_RESOLUTION_CONCURRENCY = 2;

export async function resolveCellsProgressively(
  rawCells: readonly RenderCell[],
  blobResolver: BlobResolver,
  defaultLanguage: string | null,
  cache: OutputResolutionCache | undefined,
  callbacks: ProgressiveCellResolutionCallbacks = {},
): Promise<ResolvedCell[]> {
  const shouldContinue = callbacks.shouldContinue ?? (() => true);
  const resolvedCells = rawCells.map((cell, index) =>
    resolveCellSync(cell, blobResolver, index, defaultLanguage, cache),
  );

  if (!shouldContinue()) return resolvedCells;
  callbacks.onInitialCells?.(resolvedCells.slice());

  await resolveCellsInTopDownBatches(
    rawCells,
    async (cell, index) => {
      const resolvedCell = await resolveCell(cell, blobResolver, index, defaultLanguage, cache);
      if (!shouldContinue()) return;

      resolvedCells[index] = resolvedCell;
      callbacks.onCellResolved?.(resolvedCell, index, resolvedCells.slice());
    },
    {
      maxConcurrency: callbacks.maxConcurrentAsyncCells,
      shouldContinue,
    },
  );

  return resolvedCells;
}

async function resolveCellsInTopDownBatches(
  rawCells: readonly RenderCell[],
  resolveCellAtIndex: (cell: RenderCell, index: number) => Promise<void>,
  options: {
    maxConcurrency?: number;
    shouldContinue: () => boolean;
  },
): Promise<void> {
  const maxConcurrency = normalizeAsyncResolutionConcurrency(options.maxConcurrency);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (options.shouldContinue()) {
      const index = nextIndex++;
      if (index >= rawCells.length) return;
      await resolveCellAtIndex(rawCells[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(maxConcurrency, rawCells.length) }, () => worker());
  await Promise.all(workers);
}

function normalizeAsyncResolutionConcurrency(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_ASYNC_CELL_RESOLUTION_CONCURRENCY;
  }
  return Math.max(1, Math.floor(value));
}

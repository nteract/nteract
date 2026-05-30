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
}

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

  await Promise.all(
    rawCells.map(async (cell, index) => {
      const resolvedCell = await resolveCell(cell, blobResolver, index, defaultLanguage, cache);
      if (!shouldContinue()) return;

      resolvedCells[index] = resolvedCell;
      callbacks.onCellResolved?.(resolvedCell, index, resolvedCells.slice());
    }),
  );

  return resolvedCells;
}

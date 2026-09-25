export type PromptMode = "explore" | "full";

export interface PromptCellLike {
  id: string;
  cell_type: string;
  source: string;
  metadata?: Record<string, unknown>;
}

function nteractMetadata(cell: PromptCellLike): Record<string, unknown> {
  const nteract = cell.metadata?.nteract;
  return nteract && typeof nteract === "object" ? (nteract as Record<string, unknown>) : {};
}

export function promptMode(cell: PromptCellLike): PromptMode | null {
  const prompt = nteractMetadata(cell).prompt;
  if (cell.cell_type !== "raw" || !prompt || typeof prompt !== "object") return null;
  return (prompt as { mode?: unknown }).mode === "full" ? "full" : "explore";
}

export function isContextExcluded(cell: PromptCellLike): boolean {
  return nteractMetadata(cell).context_exclude === true;
}

export function answeredPromptId(cell: PromptCellLike): string | null {
  const response = nteractMetadata(cell).prompt_response as { prompt_cell_id?: unknown } | undefined;
  return typeof response?.prompt_cell_id === "string" ? response.prompt_cell_id : null;
}

export type HeadingsByCellId = ReadonlyMap<string, readonly { level: number }[]>;

function headingLevel(headings: HeadingsByCellId | undefined, cellId: string): number | null {
  const levels = headings?.get(cellId)?.map((heading) => heading.level) ?? [];
  return levels.length > 0 ? Math.min(...levels) : null;
}

export function sectionCellIds(
  cells: readonly PromptCellLike[],
  headingCellId: string,
  headings: HeadingsByCellId | undefined,
): string[] {
  const start = cells.findIndex((cell) => cell.id === headingCellId);
  if (start < 0) return [];
  const level = headingLevel(headings, headingCellId);
  if (level === null) return [headingCellId];
  const ids = [headingCellId];
  for (const cell of cells.slice(start + 1)) {
    const nextLevel = headingLevel(headings, cell.id);
    if (nextLevel !== null && nextLevel <= level) break;
    ids.push(cell.id);
  }
  return ids;
}

export function contextToggleWrites(
  cells: readonly PromptCellLike[],
  cellId: string,
  headings: HeadingsByCellId | undefined,
): { cellId: string; exclude: boolean }[] {
  const target = cells.find((cell) => cell.id === cellId);
  if (!target) return [];
  const exclude = !isContextExcluded(target);
  return sectionCellIds(cells, cellId, headings).map((id) => ({ cellId: id, exclude }));
}

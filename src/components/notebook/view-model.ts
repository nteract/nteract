import type { JupyterOutput } from "@/components/cell/jupyter-output";
import type { ReadOnlyNotebookCellData } from "@/components/cell/ReadOnlyNotebook";
import type { SupportedLanguage } from "@/components/editor/languages";
import {
  resolveMarkdownProjection,
  type MarkdownProjectionPlan,
} from "../../lib/markdown-projection";
import {
  notebookMetadataToPackageViewModel as projectNotebookPackageViewModel,
  type NotebookPackageViewModel,
} from "@/components/environment";
import type { MarkdownHeadingAnchor } from "@/components/outputs/markdown-heading-anchors";
import { projectNotebookOutline, type NotebookOutlineItem } from "runtimed";

export {
  notebookMetadataToPackageViewModel,
  type NotebookPackageManager,
  type NotebookPackageSection,
  type NotebookPackageViewModel,
} from "@/components/environment";

export type NotebookViewCellType = "code" | "markdown" | "raw";

export interface NotebookViewCell {
  id: string;
  cellType: NotebookViewCellType;
  source: string;
  language: string | null;
  executionId: string | null;
  executionCount: number | null;
  outputs: JupyterOutput[];
  metadata: Record<string, unknown>;
  markdownProjection?: MarkdownProjectionPlan;
}

export interface NotebookTracebackCellTarget {
  cellId: string;
  label?: string;
}

export type NotebookViewLanguageResolver = (
  language: string | null | undefined,
) => SupportedLanguage | null;

export interface NotebookViewModel<TCell extends NotebookViewCell = NotebookViewCell> {
  cells: readonly TCell[];
  cellIds: string[];
  readOnlyCells: ReadOnlyNotebookCellData[];
  outlineItems: NotebookOutlineItem[];
  markdownHeadingAnchorsByCellId: ReadonlyMap<string, readonly MarkdownHeadingAnchor[]>;
  tracebackTargetsByExecutionId: ReadonlyMap<string, NotebookTracebackCellTarget>;
  packages: NotebookPackageViewModel;
  codeCellCount: number;
}

export interface CreateNotebookViewModelOptions {
  resolveLanguage?: NotebookViewLanguageResolver;
  getOutlineStatusLabel?: (cell: NotebookViewCell) => string | null;
  metadata?: unknown;
}

/**
 * Pure shell projection over already-materialized notebook cells.
 *
 * The live source of truth stays upstream: desktop feeds this from the
 * WASM/change-set materialized cell store, and hosted cloud feeds it from a
 * live/snapshot Automerge handle adapter. This function should remain free of
 * transport, WASM, blob-fetch, and host side effects.
 */
export function createNotebookViewModel<TCell extends NotebookViewCell = NotebookViewCell>(
  cells: readonly TCell[],
  options: CreateNotebookViewModelOptions = {},
): NotebookViewModel<TCell> {
  const resolveLanguage = options.resolveLanguage ?? (() => null);
  const outlineItems = notebookViewCellsToOutlineItems(cells, {
    getStatusLabel: options.getOutlineStatusLabel,
  });
  return {
    cells,
    cellIds: cells.map((cell) => cell.id),
    readOnlyCells: notebookViewCellsToReadOnlyCells(cells, resolveLanguage),
    outlineItems,
    markdownHeadingAnchorsByCellId: notebookOutlineItemsToMarkdownHeadingAnchors(outlineItems),
    tracebackTargetsByExecutionId: notebookViewCellsToTracebackTargets(cells),
    packages: projectNotebookPackageViewModel(options.metadata),
    codeCellCount: cells.filter((cell) => cell.cellType === "code").length,
  };
}

export function notebookViewCellsToReadOnlyCells(
  cells: readonly NotebookViewCell[],
  resolveLanguage: NotebookViewLanguageResolver,
): ReadOnlyNotebookCellData[] {
  return cells.map((cell) => notebookViewCellToReadOnlyCell(cell, resolveLanguage));
}

export function notebookViewCellToReadOnlyCell(
  cell: NotebookViewCell,
  resolveLanguage: NotebookViewLanguageResolver,
): ReadOnlyNotebookCellData {
  const { sourceHidden, outputsHidden } = readOnlyHiddenFlags(cell);

  return {
    id: cell.id,
    cellType: cell.cellType,
    source: cell.source,
    language: resolveLanguage(cell.language),
    outputs: cell.outputs,
    executionId: cell.executionId,
    executionCount: cell.executionCount,
    ...(sourceHidden ? { sourceHidden } : {}),
    ...(outputsHidden ? { outputsHidden } : {}),
  };
}

function readOnlyHiddenFlags(cell: NotebookViewCell): {
  sourceHidden: boolean;
  outputsHidden: boolean;
} {
  if (cell.cellType !== "code") {
    return { sourceHidden: false, outputsHidden: false };
  }

  const jupyter = cell.metadata?.jupyter as
    | { source_hidden?: boolean; outputs_hidden?: boolean }
    | undefined;

  return {
    sourceHidden: jupyter?.source_hidden === true,
    outputsHidden: jupyter?.outputs_hidden === true,
  };
}

export function notebookViewCellsToOutlineItems(
  cells: readonly NotebookViewCell[],
  options: { getStatusLabel?: (cell: NotebookViewCell) => string | null } = {},
): NotebookOutlineItem[] {
  return projectNotebookOutline(cells, {
    hrefTarget: "heading",
    getMarkdownAnchors: notebookViewCellMarkdownAnchors,
    getStatusLabel: options.getStatusLabel ?? notebookViewCellOutlineStatusLabel,
  }).items;
}

function notebookViewCellMarkdownAnchors(cell: NotebookViewCell) {
  // Blank markdown has authoritatively no headings — `[]`, not `null`, so the
  // outline does not treat the cell as "projection unavailable".
  if (!cell.source.trim()) return [];

  // resolveMarkdownProjection keys freshness on the plan's exact source: a
  // matching attached plan keeps outline projection O(cells) without cache
  // pressure, an edited cell reprojects from current source before
  // rematerialization catches up, and a stale plan survives only in hosts
  // with no registered projector.
  return resolveMarkdownProjection(cell.markdownProjection, cell.source)?.anchors ?? null;
}

export function notebookViewCellsToTracebackTargets(
  cells: readonly NotebookViewCell[],
): ReadonlyMap<string, NotebookTracebackCellTarget> {
  const targets = new Map<string, NotebookTracebackCellTarget>();
  for (const cell of cells) {
    if (!cell.executionId) continue;
    const target: NotebookTracebackCellTarget = { cellId: cell.id };
    if (typeof cell.executionCount === "number") {
      target.label = `run ${cell.executionCount}`;
    }
    targets.set(cell.executionId, target);
  }
  return targets;
}

export function notebookOutlineItemsToMarkdownHeadingAnchors(
  outlineItems: readonly NotebookOutlineItem[],
): ReadonlyMap<string, readonly MarkdownHeadingAnchor[]> {
  const map = new Map<string, MarkdownHeadingAnchor[]>();
  for (const item of outlineItems) {
    if (item.kind !== "heading" || item.headingAnchorId === null) continue;
    const anchors = map.get(item.cellId) ?? [];
    anchors.push({
      itemId: item.id,
      title: item.title,
      level: item.level,
      anchor: item.anchor ?? null,
      headingAnchorId: item.headingAnchorId,
    });
    map.set(item.cellId, anchors);
  }
  return map;
}

function notebookViewCellOutlineStatusLabel(cell: NotebookViewCell): string | null {
  if (cell.cellType === "code" && cell.executionCount !== null) {
    return `run ${cell.executionCount}`;
  }
  return null;
}

import type { JupyterOutput } from "@/components/cell/jupyter-output";
import type { SupportedLanguage } from "@/components/editor/languages";
import type { MarkdownHeadingAnchor } from "@/components/outputs/markdown-heading-anchors";
import { projectNotebookOutline, type NotebookOutlineItem } from "runtimed";
import type { ReadOnlyNotebookCellData } from "./cell-data";

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
}

export interface NotebookTracebackCellTarget {
  cellId: string;
  label?: string;
}

export type NotebookPackageManager = "uv" | "conda" | "pixi" | "deno";

export interface NotebookPackageSection {
  manager: NotebookPackageManager;
  label: string;
  dependencies: string[];
  details: Array<{
    label: string;
    values: string[];
  }>;
}

export interface NotebookPackageViewModel {
  summary: string | null;
  sections: NotebookPackageSection[];
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
    packages: notebookMetadataToPackageViewModel(options.metadata),
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
  return {
    id: cell.id,
    cellType: cell.cellType,
    source: cell.source,
    language: resolveLanguage(cell.language),
    outputs: cell.outputs,
    executionId: cell.executionId,
    executionCount: cell.executionCount,
  };
}

export function notebookViewCellsToOutlineItems(
  cells: readonly NotebookViewCell[],
  options: { getStatusLabel?: (cell: NotebookViewCell) => string | null } = {},
): NotebookOutlineItem[] {
  return projectNotebookOutline(cells, {
    hrefTarget: "heading",
    getStatusLabel: options.getStatusLabel ?? notebookViewCellOutlineStatusLabel,
  }).items;
}

export function notebookViewCellsToTracebackTargets(
  cells: readonly NotebookViewCell[],
): ReadonlyMap<string, NotebookTracebackCellTarget> {
  const targets = new Map<string, NotebookTracebackCellTarget>();
  for (const cell of cells) {
    if (!cell.executionId) continue;
    const target: NotebookTracebackCellTarget = { cellId: cell.id };
    if (typeof cell.executionCount === "number") {
      target.label = `In [${cell.executionCount}]`;
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
    return `In [${cell.executionCount}]`;
  }
  return null;
}

export function notebookMetadataToPackageViewModel(metadata: unknown): NotebookPackageViewModel {
  const runt = metadataRecord(metadata)?.runt;
  const sections: NotebookPackageSection[] = [];

  if (isRecord(runt)) {
    const uv = metadataRecord(runt.uv);
    const uvDependencies = stringArray(uv?.dependencies);
    if (uvDependencies.length > 0 || typeof uv?.["requires-python"] === "string") {
      sections.push({
        manager: "uv",
        label: "uv",
        dependencies: uvDependencies,
        details: [
          detail(
            "Python",
            typeof uv?.["requires-python"] === "string" ? [uv["requires-python"]] : [],
          ),
          detail("Prerelease", typeof uv?.prerelease === "string" ? [uv.prerelease] : []),
        ].filter(hasValues),
      });
    }

    const conda = metadataRecord(runt.conda);
    const condaDependencies = stringArray(conda?.dependencies);
    const condaChannels = stringArray(conda?.channels);
    if (
      condaDependencies.length > 0 ||
      condaChannels.length > 0 ||
      typeof conda?.python === "string"
    ) {
      sections.push({
        manager: "conda",
        label: "conda",
        dependencies: condaDependencies,
        details: [
          detail("Python", typeof conda?.python === "string" ? [conda.python] : []),
          detail("Channels", condaChannels),
        ].filter(hasValues),
      });
    }

    const pixi = metadataRecord(runt.pixi);
    const pixiDependencies = stringArray(pixi?.dependencies);
    const pixiPyPiDependencies = stringArray(pixi?.pypi_dependencies);
    const pixiChannels = stringArray(pixi?.channels);
    if (
      pixiDependencies.length > 0 ||
      pixiPyPiDependencies.length > 0 ||
      pixiChannels.length > 0 ||
      typeof pixi?.python === "string"
    ) {
      sections.push({
        manager: "pixi",
        label: "pixi",
        dependencies: pixiDependencies,
        details: [
          detail("PyPI", pixiPyPiDependencies),
          detail("Python", typeof pixi?.python === "string" ? [pixi.python] : []),
          detail("Channels", pixiChannels),
        ].filter(hasValues),
      });
    }

    const deno = metadataRecord(runt.deno);
    const denoPermissions = stringArray(deno?.permissions);
    if (
      denoPermissions.length > 0 ||
      typeof deno?.import_map === "string" ||
      typeof deno?.config === "string" ||
      typeof deno?.flexible_npm_imports === "boolean"
    ) {
      sections.push({
        manager: "deno",
        label: "Deno",
        dependencies: [],
        details: [
          detail("Permissions", denoPermissions),
          detail("Import map", typeof deno?.import_map === "string" ? [deno.import_map] : []),
          detail("Config", typeof deno?.config === "string" ? [deno.config] : []),
          detail(
            "Flexible npm imports",
            typeof deno?.flexible_npm_imports === "boolean"
              ? [deno.flexible_npm_imports ? "enabled" : "disabled"]
              : [],
          ),
        ].filter(hasValues),
      });
    }
  }

  return {
    summary: packageSummary(sections),
    sections,
  };
}

function metadataRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function detail(label: string, values: string[]): NotebookPackageSection["details"][number] {
  return { label, values };
}

function hasValues(detail: NotebookPackageSection["details"][number]): boolean {
  return detail.values.length > 0;
}

function packageSummary(sections: readonly NotebookPackageSection[]): string | null {
  if (sections.length === 0) return null;
  const dependencyCount = sections.reduce(
    (total, section) =>
      total +
      section.dependencies.length +
      section.details
        .filter((detail) => detail.label === "PyPI")
        .reduce((detailTotal, detail) => detailTotal + detail.values.length, 0),
    0,
  );
  if (dependencyCount === 0) {
    return sections.map((section) => section.label).join(" + ");
  }
  const packageLabel = dependencyCount === 1 ? "package" : "packages";
  return `${sections.map((section) => section.label).join(" + ")} · ${dependencyCount} ${packageLabel}`;
}

import type { BlobResolver } from "runtimed";
import { snapshotWidgetCommsFromRuntimeState, type SnapshotWidgetComm } from "../src/widget-comms";
import {
  resolveCellsProgressively,
  type ProgressiveCellResolutionCallbacks,
} from "./progressive-cell-resolution";
import type { NotebookHandle } from "./runtimed-wasm-client";
import type { OutputResolutionCache, RenderCell, ResolvedCell } from "./render-resolution";

export interface CloudNotebookViewMaterialization {
  cells: ResolvedCell[];
  widgetComms: SnapshotWidgetComm[];
  notebookLanguage: string;
  rawCellCount: number;
}

export interface MaterializeCloudNotebookViewOptions {
  blobResolver: BlobResolver;
  defaultNotebookLanguage: string;
  outputResolutionCache?: OutputResolutionCache;
  callbacks?: ProgressiveCellResolutionCallbacks;
}

export async function materializeCloudNotebookView(
  handle: NotebookHandle,
  options: MaterializeCloudNotebookViewOptions,
): Promise<CloudNotebookViewMaterialization> {
  const rawCells = JSON.parse(handle.get_cells_json()) as RenderCell[];
  const notebookLanguage = cloudNotebookLanguageFromHandle(handle, options.defaultNotebookLanguage);
  const widgetComms = snapshotWidgetCommsFromRuntimeState(
    handle.get_runtime_state(),
    options.blobResolver,
  );
  const cells = await resolveCellsProgressively(
    rawCells,
    options.blobResolver,
    notebookLanguage,
    options.outputResolutionCache,
    options.callbacks,
  );

  return {
    cells,
    widgetComms,
    notebookLanguage,
    rawCellCount: rawCells.length,
  };
}

export function cloudNotebookLanguageFromHandle(
  handle: Pick<NotebookHandle, "get_metadata_snapshot_json">,
  fallback: string,
): string {
  return (
    languageFromNotebookMetadata(parseJsonOrNull(handle.get_metadata_snapshot_json?.())) ?? fallback
  );
}

function languageFromNotebookMetadata(metadata: unknown): string | null {
  if (typeof metadata !== "object" || metadata === null) return null;
  const languageInfo = (metadata as Record<string, unknown>).language_info;
  if (typeof languageInfo !== "object" || languageInfo === null) return null;
  const name = (languageInfo as Record<string, unknown>).name;
  return typeof name === "string" ? name : null;
}

function parseJsonOrNull(value: string | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

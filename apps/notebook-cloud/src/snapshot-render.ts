import type { BlobResolver } from "runtimed";
import {
  resolveSnapshotWidgetComms,
  snapshotWidgetCommsFromRuntimeAndCommsState,
  type SnapshotWidgetComm,
} from "runtimed";
import { collectBlobUrls } from "./blob-refs.ts";
import { loadSnapshotPair } from "./runtimed-wasm.ts";

export interface SnapshotRender {
  schema_version: 1;
  generated_from: "runtimed-wasm:load_snapshot";
  generated_at: string;
  notebook_id: string;
  heads_hash: string;
  runtime_state_doc_id: string | null;
  comms_doc_id: string | null;
  runtime_heads_hash: string | null;
  metadata: unknown;
  source: "snapshot-pair";
  cells: unknown;
  blob_urls: Record<string, string>;
  widget_comms: SnapshotWidgetComm[];
}

export interface SnapshotCellComposition {
  code: number;
  markdown: number;
  raw: number;
}

export interface SnapshotNotebookSummary {
  cellComposition: SnapshotCellComposition;
  cover: SnapshotNotebookCover | null;
  language: string | null;
}

export interface SnapshotNotebookCover {
  blobHash: string;
  mime: "image/png" | "image/jpeg" | "image/svg+xml";
}

export interface MaterializedSnapshotPairRender {
  render: SnapshotRender;
  summary: SnapshotNotebookSummary;
}

interface MaterializeSnapshotPairRenderInput {
  notebookId: string;
  notebookHeadsHash: string;
  runtimeHeadsHash: string | null;
  notebookBytes: Uint8Array;
  runtimeStateBytes: Uint8Array;
  commsDocBytes?: Uint8Array;
  blobResolver?: BlobResolver;
  generatedAt?: string;
}

export async function materializeSnapshotPairRender(
  input: MaterializeSnapshotPairRenderInput,
): Promise<SnapshotRender> {
  return (await materializeSnapshotPairRenderWithSummary(input)).render;
}

export async function materializeSnapshotPairRenderWithSummary(
  input: MaterializeSnapshotPairRenderInput,
): Promise<MaterializedSnapshotPairRender> {
  const handle = await loadSnapshotPair(
    input.notebookBytes,
    input.runtimeStateBytes,
    input.commsDocBytes,
  );
  try {
    const cells = JSON.parse(handle.get_cells_json()) as unknown;
    const runtimeState = handle.get_runtime_state();
    const commsState = handle.get_comms_state();
    const metadata = parseJsonOrNull(handle.get_metadata_snapshot_json());
    const summary = {
      cellComposition: countCellComposition(cells),
      cover: selectNotebookCoverFromCells(cells),
      language: readDetectedRuntime(handle, metadata),
    };
    const commsDocId = readOptionalCommsDocId(handle);
    const rawWidgetComms = snapshotWidgetCommsFromRuntimeAndCommsState(runtimeState, commsState);
    const widgetComms = input.blobResolver
      ? resolveSnapshotWidgetComms(rawWidgetComms, input.blobResolver)
      : rawWidgetComms;
    return {
      render: {
        schema_version: 1,
        generated_from: "runtimed-wasm:load_snapshot",
        generated_at: input.generatedAt ?? new Date().toISOString(),
        notebook_id: input.notebookId,
        heads_hash: input.notebookHeadsHash,
        runtime_state_doc_id: handle.get_runtime_state_doc_id() ?? null,
        comms_doc_id: commsDocId,
        runtime_heads_hash: input.runtimeHeadsHash,
        metadata,
        source: "snapshot-pair",
        cells,
        blob_urls: input.blobResolver
          ? collectBlobUrls({ cells, widget_comms: rawWidgetComms }, input.blobResolver)
          : {},
        widget_comms: widgetComms,
      },
      summary,
    };
  } finally {
    handle.free();
  }
}

function parseJsonOrNull(value: string | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function readOptionalCommsDocId(handle: {
  get_comms_doc_id?: () => string | undefined;
}): string | null {
  return typeof handle.get_comms_doc_id === "function" ? (handle.get_comms_doc_id() ?? null) : null;
}

function readDetectedRuntime(
  handle: { detect_runtime?: () => string | undefined },
  metadata: unknown,
): string | null {
  try {
    if (typeof handle.detect_runtime === "function") {
      return handle.detect_runtime() ?? detectRuntimeFromMetadata(metadata);
    }
  } catch {
    return detectRuntimeFromMetadata(metadata);
  }
  return detectRuntimeFromMetadata(metadata);
}

export function detectRuntimeFromMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }
  const record = metadata as Record<string, unknown>;
  const kernelspec = objectRecord(record.kernelspec);
  if (kernelspec) {
    const name = stringLower(kernelspec.name);
    if (name?.includes("deno")) return "deno";
    if (name?.includes("python")) return "python";

    const language = stringLower(kernelspec.language);
    if (language === "typescript" || language === "javascript") return "deno";
    if (language === "python") return "python";
  }

  const languageInfo = objectRecord(record.language_info);
  if (languageInfo) {
    const name = stringLower(languageInfo.name);
    if (name === "deno" || name === "typescript" || name === "javascript") return "deno";
    if (name === "python") return "python";
  }

  const runt = objectRecord(record.runt);
  if (runt) {
    if (objectRecord(runt.deno)) return "deno";
    if (objectRecord(runt.uv) || objectRecord(runt.conda)) return "python";
  }
  return null;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringLower(value: unknown): string | null {
  return typeof value === "string" ? value.toLowerCase() : null;
}

const COVER_MIME_PRIORITY = ["image/png", "image/jpeg", "image/svg+xml"] as const;

export function selectNotebookCoverFromCells(cells: unknown): SnapshotNotebookCover | null {
  try {
    if (!Array.isArray(cells)) {
      return null;
    }
    let selected: SnapshotNotebookCover | null = null;
    for (const cell of cells) {
      const cellRecord = objectRecord(cell);
      const outputs = Array.isArray(cellRecord?.outputs) ? cellRecord.outputs : [];
      for (const output of outputs) {
        const cover = selectOutputCover(output);
        if (cover) {
          selected = cover;
        }
      }
    }
    return selected;
  } catch {
    return null;
  }
}

function selectOutputCover(output: unknown): SnapshotNotebookCover | null {
  const outputRecord = objectRecord(output);
  const data = objectRecord(outputRecord?.data);
  if (!data) {
    return null;
  }

  for (const mime of COVER_MIME_PRIORITY) {
    const ref = objectRecord(data[mime]);
    const blobHash = readBlobHash(ref);
    if (blobHash) {
      return { blobHash, mime };
    }
  }
  return null;
}

function readBlobHash(value: Record<string, unknown> | null): string | null {
  if (!value) {
    return null;
  }
  const blob = value.blob ?? value.hash;
  return typeof blob === "string" && blob.trim() ? blob : null;
}

export function countCellComposition(cells: unknown): SnapshotCellComposition {
  const composition: SnapshotCellComposition = { code: 0, markdown: 0, raw: 0 };
  if (!Array.isArray(cells)) {
    return composition;
  }
  for (const cell of cells) {
    if (!cell || typeof cell !== "object") {
      continue;
    }
    const cellType = (cell as { cell_type?: unknown }).cell_type;
    if (cellType === "code" || cellType === "markdown" || cellType === "raw") {
      composition[cellType] += 1;
    }
  }
  return composition;
}

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

export async function materializeSnapshotPairRender(input: {
  notebookId: string;
  notebookHeadsHash: string;
  runtimeHeadsHash: string | null;
  notebookBytes: Uint8Array;
  runtimeStateBytes: Uint8Array;
  commsDocBytes?: Uint8Array;
  blobResolver?: BlobResolver;
  generatedAt?: string;
}): Promise<SnapshotRender> {
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
    const commsDocId = readOptionalCommsDocId(handle);
    const rawWidgetComms = snapshotWidgetCommsFromRuntimeAndCommsState(runtimeState, commsState);
    const widgetComms = input.blobResolver
      ? resolveSnapshotWidgetComms(rawWidgetComms, input.blobResolver)
      : rawWidgetComms;
    return {
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

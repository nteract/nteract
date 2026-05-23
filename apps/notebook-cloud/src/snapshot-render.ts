import type { BlobResolver } from "runtimed";
import { collectBlobUrls } from "./blob-refs.ts";
import { loadSnapshotPair } from "./runtimed-wasm.ts";

export interface SnapshotRender {
  schema_version: 1;
  generated_from: "runtimed-wasm:load_snapshot";
  generated_at: string;
  notebook_id: string;
  heads_hash: string;
  runtime_heads_hash: string | null;
  metadata: unknown;
  source: "snapshot-pair";
  cells: unknown;
  blob_urls: Record<string, string>;
}

export async function materializeSnapshotPairRender(input: {
  notebookId: string;
  notebookHeadsHash: string;
  runtimeHeadsHash: string | null;
  notebookBytes: Uint8Array;
  runtimeStateBytes: Uint8Array;
  blobResolver?: BlobResolver;
  generatedAt?: string;
}): Promise<SnapshotRender> {
  const handle = await loadSnapshotPair(input.notebookBytes, input.runtimeStateBytes);
  try {
    const cells = JSON.parse(handle.get_cells_json()) as unknown;
    const metadata = parseJsonOrNull(handle.get_metadata_snapshot_json());
    return {
      schema_version: 1,
      generated_from: "runtimed-wasm:load_snapshot",
      generated_at: input.generatedAt ?? new Date().toISOString(),
      notebook_id: input.notebookId,
      heads_hash: input.notebookHeadsHash,
      runtime_heads_hash: input.runtimeHeadsHash,
      metadata,
      source: "snapshot-pair",
      cells,
      blob_urls: input.blobResolver ? collectBlobUrls(cells, input.blobResolver) : {},
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

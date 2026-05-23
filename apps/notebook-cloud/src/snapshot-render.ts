import type { BlobResolver } from "runtimed";
import { loadSnapshotPair } from "./runtimed-wasm.ts";

export interface SnapshotRender {
  schema_version: 1;
  generated_from: "runtimed-wasm:load_snapshot";
  generated_at: string;
  notebook_id: string;
  heads_hash: string;
  runtime_heads_hash: string | null;
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
    return {
      schema_version: 1,
      generated_from: "runtimed-wasm:load_snapshot",
      generated_at: input.generatedAt ?? new Date().toISOString(),
      notebook_id: input.notebookId,
      heads_hash: input.notebookHeadsHash,
      runtime_heads_hash: input.runtimeHeadsHash,
      source: "snapshot-pair",
      cells,
      blob_urls: input.blobResolver ? collectBlobUrls(cells, input.blobResolver) : {},
    };
  } finally {
    handle.free();
  }
}

function collectBlobUrls(value: unknown, resolver: BlobResolver): Record<string, string> {
  const urls: Record<string, string> = {};
  visitBlobRefs(value, resolver, urls);
  return urls;
}

function visitBlobRefs(value: unknown, resolver: BlobResolver, urls: Record<string, string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      visitBlobRefs(item, resolver, urls);
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.blob === "string") {
    urls[record.blob] = resolver.url({
      blob: record.blob,
      size: typeof record.size === "number" ? record.size : undefined,
      media_type: typeof record.media_type === "string" ? record.media_type : undefined,
    });
  }

  for (const item of Object.values(record)) {
    visitBlobRefs(item, resolver, urls);
  }
}

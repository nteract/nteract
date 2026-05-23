import type { BlobResolver } from "runtimed";
import { loadSnapshotPair } from "./runtimed-wasm.ts";

const ARROW_STREAM_MANIFEST_MIME = "application/vnd.nteract.arrow-stream-manifest+json";

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
    addBlobUrl(record, resolver, urls);
  }

  const arrowManifestRef = record[ARROW_STREAM_MANIFEST_MIME];
  if (isInlineContentRef(arrowManifestRef)) {
    visitArrowStreamManifest(arrowManifestRef.inline, resolver, urls);
  }

  for (const item of Object.values(record)) {
    visitBlobRefs(item, resolver, urls);
  }
}

function addBlobUrl(
  record: Record<string, unknown>,
  resolver: BlobResolver,
  urls: Record<string, string>,
): void {
  if (typeof record.blob !== "string") return;
  urls[record.blob] = resolver.url({
    blob: record.blob,
    size: typeof record.size === "number" ? record.size : undefined,
    media_type: typeof record.media_type === "string" ? record.media_type : undefined,
  });
}

function isInlineContentRef(value: unknown): value is { inline: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).inline === "string"
  );
}

function visitArrowStreamManifest(
  content: string,
  resolver: BlobResolver,
  urls: Record<string, string>,
): void {
  let manifest: unknown;
  try {
    manifest = JSON.parse(content);
  } catch {
    return;
  }
  if (typeof manifest !== "object" || manifest === null) return;
  const chunks = (manifest as Record<string, unknown>).chunks;
  if (!Array.isArray(chunks)) return;

  for (const chunk of chunks) {
    if (typeof chunk !== "object" || chunk === null) continue;
    const record = chunk as Record<string, unknown>;
    if (typeof record.hash !== "string") continue;
    urls[record.hash] = resolver.url({
      blob: record.hash,
      size: typeof record.size === "number" ? record.size : undefined,
      media_type: typeof record.media_type === "string" ? record.media_type : undefined,
    });
  }
}

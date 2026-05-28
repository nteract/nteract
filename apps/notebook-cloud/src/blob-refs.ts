import type { BlobRef, BlobResolver } from "runtimed";

const ARROW_STREAM_MANIFEST_MIME = "application/vnd.nteract.arrow-stream-manifest+json";

export function collectBlobRefs(value: unknown): Record<string, BlobRef> {
  const refs: Record<string, BlobRef> = {};
  visitBlobRefs(value, refs);
  return refs;
}

export function collectBlobUrls(value: unknown, resolver: BlobResolver): Record<string, string> {
  return Object.fromEntries(
    Object.entries(collectBlobRefs(value)).map(([hash, ref]) => [hash, resolver.url(ref)]),
  );
}

function visitBlobRefs(value: unknown, refs: Record<string, BlobRef>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      visitBlobRefs(item, refs);
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.blob === "string") {
    addBlobRef(record, refs);
  }
  addNotebookCellBlobRefs(record, refs);

  const arrowManifestRef = record[ARROW_STREAM_MANIFEST_MIME];
  if (isInlineContentRef(arrowManifestRef)) {
    visitArrowStreamManifest(arrowManifestRef.inline, refs);
  }

  for (const item of Object.values(record)) {
    visitBlobRefs(item, refs);
  }
}

function addNotebookCellBlobRefs(
  record: Record<string, unknown>,
  refs: Record<string, BlobRef>,
): void {
  const resolvedAssets = record.resolved_assets;
  if (isRecord(resolvedAssets)) {
    for (const hash of Object.values(resolvedAssets)) {
      if (typeof hash === "string") {
        mergeBlobRef(refs, { blob: hash });
      }
    }
  }

  const attachments = record.attachments;
  if (!isRecord(attachments)) return;
  for (const bundle of Object.values(attachments)) {
    if (!isRecord(bundle)) continue;
    for (const [mediaType, ref] of Object.entries(bundle)) {
      if (!isRecord(ref) || typeof ref.blob_hash !== "string") continue;
      mergeBlobRef(refs, { blob: ref.blob_hash, media_type: mediaType });
    }
  }
}

function addBlobRef(record: Record<string, unknown>, refs: Record<string, BlobRef>): void {
  if (typeof record.blob !== "string") return;
  mergeBlobRef(refs, {
    blob: record.blob,
    size: typeof record.size === "number" ? record.size : undefined,
    media_type: typeof record.media_type === "string" ? record.media_type : undefined,
  });
}

function mergeBlobRef(refs: Record<string, BlobRef>, ref: BlobRef): void {
  const existing = refs[ref.blob];
  refs[ref.blob] = {
    blob: ref.blob,
    size: existing?.size ?? ref.size,
    media_type: existing?.media_type ?? ref.media_type,
  };
}

function isInlineContentRef(value: unknown): value is { inline: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).inline === "string"
  );
}

function visitArrowStreamManifest(content: string, refs: Record<string, BlobRef>): void {
  let manifest: unknown;
  try {
    manifest = JSON.parse(content);
  } catch {
    return;
  }
  if (typeof manifest !== "object" || manifest === null) return;
  const record = manifest as Record<string, unknown>;
  const chunks = record.chunks;

  if (Array.isArray(chunks)) {
    for (const chunk of chunks) {
      addManifestBlobRef(chunk, refs);
    }
  }

  const blobs = record.blobs;
  if (Array.isArray(blobs)) {
    for (const blob of blobs) {
      addManifestBlobRef(blob, refs);
    }
  }

  addManifestBlobRef(record.coalesced, refs);
  const segments = isRecord(record.coalesced) ? record.coalesced.segments : undefined;
  if (Array.isArray(segments)) {
    for (const segment of segments) {
      addManifestBlobRef(segment, refs);
    }
  }
}

function addManifestBlobRef(value: unknown, refs: Record<string, BlobRef>): void {
  if (!isRecord(value)) return;
  const hash = typeof value.blob === "string" ? value.blob : value.hash;
  if (typeof hash !== "string") return;
  mergeBlobRef(refs, {
    blob: hash,
    size: typeof value.size === "number" ? value.size : undefined,
    media_type: typeof value.media_type === "string" ? value.media_type : undefined,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

  const arrowManifestRef = record[ARROW_STREAM_MANIFEST_MIME];
  if (isInlineContentRef(arrowManifestRef)) {
    visitArrowStreamManifest(arrowManifestRef.inline, refs);
  }

  for (const item of Object.values(record)) {
    visitBlobRefs(item, refs);
  }
}

function addBlobRef(record: Record<string, unknown>, refs: Record<string, BlobRef>): void {
  if (typeof record.blob !== "string") return;
  refs[record.blob] = {
    blob: record.blob,
    size: typeof record.size === "number" ? record.size : undefined,
    media_type: typeof record.media_type === "string" ? record.media_type : undefined,
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
  const chunks = (manifest as Record<string, unknown>).chunks;
  if (!Array.isArray(chunks)) return;

  for (const chunk of chunks) {
    if (typeof chunk !== "object" || chunk === null) continue;
    const record = chunk as Record<string, unknown>;
    if (typeof record.hash !== "string") continue;
    refs[record.hash] = {
      blob: record.hash,
      size: typeof record.size === "number" ? record.size : undefined,
      media_type: typeof record.media_type === "string" ? record.media_type : undefined,
    };
  }
}

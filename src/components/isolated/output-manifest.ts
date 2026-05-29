import {
  normalizeBlobResolver,
  type BlobRef as OutputBlobRef,
  type BlobResolver as OutputBlobResolver,
  type BlobResolverInput,
} from "runtimed";

export const ARROW_STREAM_MANIFEST_MIME = "application/vnd.nteract.arrow-stream-manifest+json";

export { createBlobResolver, createHttpBlobResolver, normalizeBlobResolver } from "runtimed";
export type { BlobResolverInput, OutputBlobRef, OutputBlobResolver };

export type ContentRef =
  | { inline: string }
  | { url: string }
  | { blob: string; size?: number; media_type?: string };

interface ManifestCommon {
  output_id: string;
}

export type OutputManifest =
  | (ManifestCommon & {
      output_type: "display_data";
      data: Record<string, ContentRef>;
      metadata?: Record<string, unknown>;
      transient?: { display_id?: string };
    })
  | (ManifestCommon & {
      output_type: "execute_result";
      data: Record<string, ContentRef>;
      metadata?: Record<string, unknown>;
      execution_count?: number | null;
      transient?: { display_id?: string };
    })
  | (ManifestCommon & {
      output_type: "stream";
      name: string;
      text: ContentRef;
    })
  | (ManifestCommon & {
      output_type: "error";
      ename: string;
      evalue: string;
      traceback: ContentRef;
      rich?: ContentRef;
    });

export type ResolvedJupyterOutput =
  | {
      output_id: string;
      output_type: "display_data";
      data: Record<string, unknown>;
      metadata: Record<string, unknown>;
      display_id?: string;
    }
  | {
      output_id: string;
      output_type: "execute_result";
      data: Record<string, unknown>;
      metadata: Record<string, unknown>;
      execution_count: number | null;
      display_id?: string;
    }
  | {
      output_id: string;
      output_type: "stream";
      name: "stdout" | "stderr";
      text: string;
    }
  | {
      output_id: string;
      output_type: "error";
      ename: string;
      evalue: string;
      traceback: string[];
      rich?: unknown;
    };

const URL_BACKED_BINARY_MIME_TYPES = new Set([
  "application/octet-stream",
  "application/pdf",
  "application/vnd.apache.arrow.stream",
  "application/vnd.apache.parquet",
]);

function looksLikeBinaryMime(mime: string): boolean {
  if (mime.startsWith("image/") && !mime.endsWith("+xml")) return true;
  if (mime.startsWith("audio/") || mime.startsWith("video/")) return true;
  return URL_BACKED_BINARY_MIME_TYPES.has(mime);
}

function isContentRef(value: unknown): value is ContentRef {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    ("inline" in obj && typeof obj.inline === "string") ||
    ("url" in obj && typeof obj.url === "string") ||
    ("blob" in obj && typeof obj.blob === "string")
  );
}

export function isOutputManifest(value: unknown): value is OutputManifest {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (!("output_type" in obj)) return false;
  if (typeof obj.output_id !== "string" || obj.output_id.length === 0) return false;

  switch (obj.output_type) {
    case "stream":
      return isContentRef(obj.text);
    case "error":
      return isContentRef(obj.traceback);
    case "display_data":
    case "execute_result": {
      if (typeof obj.data !== "object" || obj.data === null) return false;
      const entries = Object.values(obj.data as Record<string, unknown>);
      return entries.length > 0 && entries.every(isContentRef);
    }
    default:
      return false;
  }
}

export async function resolveContentRef(
  ref: ContentRef,
  blobResolverInput: BlobResolverInput,
  mimeType?: string,
): Promise<string> {
  const blobResolver = normalizeBlobResolver(blobResolverInput);
  if ("inline" in ref) return ref.inline;
  if ("url" in ref) return ref.url;
  if (mimeType && looksLikeBinaryMime(mimeType)) return blobResolver.url(ref);

  const response = await blobResolver.fetch(ref);
  if (!response.ok) {
    throw new Error(`Failed to fetch blob ${ref.blob}: ${response.status}`);
  }
  return response.text();
}

function resolveContentRefSync(
  ref: ContentRef,
  blobResolverInput: BlobResolverInput,
  mimeType?: string,
): string | null {
  const blobResolver = normalizeBlobResolver(blobResolverInput);
  if ("inline" in ref) return ref.inline;
  if ("url" in ref) return ref.url;
  if (mimeType && looksLikeBinaryMime(mimeType)) return blobResolver.url(ref);
  return null;
}

function attachArrowManifestChunkUrls(
  value: unknown,
  blobResolverInput: BlobResolverInput,
): unknown {
  if (typeof value !== "object" || value === null) return value;
  const manifest = value as Record<string, unknown>;
  const blobResolver = normalizeBlobResolver(blobResolverInput);

  if (!Array.isArray(manifest.chunks)) {
    return value;
  }

  let changed = false;
  const chunks = manifest.chunks.map((chunk) => {
    if (typeof chunk !== "object" || chunk === null) return chunk;
    const record = chunk as Record<string, unknown>;
    if (typeof record.url === "string") return chunk;
    const hash = manifestBlobHash(record);
    if (!hash) return chunk;
    changed = true;
    return { ...record, url: blobResolver.url({ blob: hash }) };
  });

  return changed ? { ...manifest, chunks } : value;
}

function manifestBlobHash(record: Record<string, unknown>): string | null {
  if (typeof record.blob === "string") return record.blob;
  if (typeof record.hash === "string") return record.hash;
  return null;
}

function parseMimeContent(mimeType: string, content: string, blobResolver: BlobResolverInput) {
  if (!mimeType.includes("json")) return content;
  try {
    const parsed = JSON.parse(content);
    return mimeType === ARROW_STREAM_MANIFEST_MIME
      ? attachArrowManifestChunkUrls(parsed, blobResolver)
      : parsed;
  } catch {
    return content;
  }
}

async function parseMimeContentAsync(
  mimeType: string,
  content: string,
  blobResolver: BlobResolverInput,
) {
  if (!mimeType.includes("json")) return content;
  try {
    const parsed = JSON.parse(content);
    if (mimeType !== ARROW_STREAM_MANIFEST_MIME) return parsed;
    if (isArrowManifestPointer(parsed)) {
      const manifestContent = await resolveContentRef(parsed, blobResolver);
      return parseMimeContent(mimeType, manifestContent, blobResolver);
    }
    return attachArrowManifestChunkUrls(parsed, blobResolver);
  } catch {
    return content;
  }
}

function needsAsyncMimeResolution(mimeType: string, content: string): boolean {
  if (mimeType !== ARROW_STREAM_MANIFEST_MIME) return false;
  try {
    return isArrowManifestPointer(JSON.parse(content));
  } catch {
    return false;
  }
}

function isArrowManifestPointer(value: unknown): value is ContentRef {
  if (!isContentRef(value)) return false;
  if ("inline" in value) return false;
  const record = value as Record<string, unknown>;
  return !Array.isArray(record.chunks);
}

export async function resolveDataBundle(
  data: Record<string, ContentRef>,
  blobResolver: BlobResolverInput,
): Promise<Record<string, unknown>> {
  const entries = Object.entries(data);
  const contents = await Promise.all(
    entries.map(([mimeType, ref]) => resolveContentRef(ref, blobResolver, mimeType)),
  );
  const resolved = await Promise.all(
    entries.map(async ([mimeType], index) => [
      mimeType,
      await parseMimeContentAsync(mimeType, contents[index], blobResolver),
    ]),
  );
  return Object.fromEntries(resolved);
}

function resolveDataBundleSync(
  data: Record<string, ContentRef>,
  blobResolver: BlobResolverInput,
): Record<string, unknown> | null {
  const resolved: Record<string, unknown> = {};
  for (const [mimeType, ref] of Object.entries(data)) {
    const content = resolveContentRefSync(ref, blobResolver, mimeType);
    if (content === null) return null;
    if (needsAsyncMimeResolution(mimeType, content)) return null;
    resolved[mimeType] = parseMimeContent(mimeType, content, blobResolver);
  }
  return resolved;
}

async function resolveRich(
  ref: ContentRef | undefined,
  blobResolver: BlobResolverInput,
): Promise<Record<string, unknown> | undefined> {
  if (!ref) return undefined;
  try {
    return JSON.parse(await resolveContentRef(ref, blobResolver)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

type RichSyncResult = "absent" | "async" | Record<string, unknown>;

function resolveRichSync(
  ref: ContentRef | undefined,
  blobResolver: BlobResolverInput,
): RichSyncResult {
  if (!ref) return "absent";
  const json = resolveContentRefSync(ref, blobResolver);
  if (json === null) return "async";
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function resolveManifest(
  manifest: OutputManifest,
  blobResolver: BlobResolverInput,
): Promise<ResolvedJupyterOutput> {
  const output_id = manifest.output_id;
  switch (manifest.output_type) {
    case "display_data":
      return {
        output_id,
        output_type: "display_data",
        data: await resolveDataBundle(manifest.data, blobResolver),
        metadata: manifest.metadata ?? {},
        display_id: manifest.transient?.display_id,
      };
    case "execute_result":
      return {
        output_id,
        output_type: "execute_result",
        data: await resolveDataBundle(manifest.data, blobResolver),
        metadata: manifest.metadata ?? {},
        execution_count: manifest.execution_count ?? null,
        display_id: manifest.transient?.display_id,
      };
    case "stream":
      return {
        output_id,
        output_type: "stream",
        name: manifest.name as "stdout" | "stderr",
        text: await resolveContentRef(manifest.text, blobResolver),
      };
    case "error": {
      const traceback = JSON.parse(await resolveContentRef(manifest.traceback, blobResolver));
      return {
        output_id,
        output_type: "error",
        ename: manifest.ename,
        evalue: manifest.evalue,
        traceback: traceback as string[],
        rich: await resolveRich(manifest.rich, blobResolver),
      };
    }
  }
}

export function resolveManifestSync(
  manifest: OutputManifest,
  blobResolver: BlobResolverInput,
): ResolvedJupyterOutput | null {
  const output_id = manifest.output_id;
  switch (manifest.output_type) {
    case "display_data": {
      const data = resolveDataBundleSync(manifest.data, blobResolver);
      return data
        ? {
            output_id,
            output_type: "display_data",
            data,
            metadata: manifest.metadata ?? {},
            display_id: manifest.transient?.display_id,
          }
        : null;
    }
    case "execute_result": {
      const data = resolveDataBundleSync(manifest.data, blobResolver);
      return data
        ? {
            output_id,
            output_type: "execute_result",
            data,
            metadata: manifest.metadata ?? {},
            execution_count: manifest.execution_count ?? null,
            display_id: manifest.transient?.display_id,
          }
        : null;
    }
    case "stream": {
      const text = resolveContentRefSync(manifest.text, blobResolver);
      return text !== null
        ? {
            output_id,
            output_type: "stream",
            name: manifest.name as "stdout" | "stderr",
            text,
          }
        : null;
    }
    case "error": {
      const tracebackJson = resolveContentRefSync(manifest.traceback, blobResolver);
      if (tracebackJson === null) return null;
      const rich = resolveRichSync(manifest.rich, blobResolver);
      if (rich === "async") return null;
      return {
        output_id,
        output_type: "error",
        ename: manifest.ename,
        evalue: manifest.evalue,
        traceback: JSON.parse(tracebackJson) as string[],
        rich: rich === "absent" ? undefined : rich,
      };
    }
  }
}

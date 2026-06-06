import type { BlobRef, BlobResolver } from "./blob-resolver";

export interface SnapshotWidgetComm {
  comm_id: string;
  target_name: string;
  model_module: string;
  model_name: string;
  state: Record<string, unknown>;
  buffer_paths?: string[][];
  text_paths?: string[][];
  seq: number;
}

export function snapshotWidgetCommsFromRuntimeState(
  runtimeState: unknown,
  blobResolver?: BlobResolver,
): SnapshotWidgetComm[] {
  return snapshotWidgetCommsFromRuntimeAndCommsState(runtimeState, null, blobResolver);
}

export function snapshotWidgetCommsFromRuntimeAndCommsState(
  runtimeState: unknown,
  commsState: unknown,
  blobResolver?: BlobResolver,
): SnapshotWidgetComm[] {
  const comms = asRecord(asRecord(runtimeState).comms);
  const splitComms = asRecord(asRecord(commsState).comms);
  const normalized = normalizeSnapshotWidgetComms(
    Object.entries(comms).map(([commId, entry]) => {
      const topology = asRecord(entry);
      return {
        ...topology,
        state: asRecord(splitComms[commId] ?? topology.state),
        comm_id: commId,
      };
    }),
  );
  return blobResolver ? resolveSnapshotWidgetComms(normalized, blobResolver) : normalized;
}

export function resolveSnapshotWidgetComms(
  comms: readonly SnapshotWidgetComm[],
  blobResolver: BlobResolver,
): SnapshotWidgetComm[] {
  return comms.map((comm) => {
    const bufferPaths: string[][] = [];
    const textPaths: string[][] = [];
    const state = resolveCommStateValue(comm.state, blobResolver, [], bufferPaths, textPaths);
    const mergedBufferPaths = [...(comm.buffer_paths ?? []), ...bufferPaths];
    const mergedTextPaths = [...(comm.text_paths ?? []), ...textPaths];
    return {
      ...comm,
      state: asRecord(state),
      ...(mergedBufferPaths.length > 0 ? { buffer_paths: mergedBufferPaths } : {}),
      ...(mergedTextPaths.length > 0 ? { text_paths: mergedTextPaths } : {}),
    };
  });
}

export function normalizeSnapshotWidgetComms(value: unknown): SnapshotWidgetComm[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => normalizeSnapshotWidgetComm(entry))
    .filter((entry): entry is SnapshotWidgetComm => entry !== null)
    .sort((a, b) => a.seq - b.seq);
}

export function widgetCommStoreState(comm: SnapshotWidgetComm): Record<string, unknown> {
  return {
    ...comm.state,
    _model_module: stringValue(comm.state._model_module) ?? optionalString(comm.model_module),
    _model_name: stringValue(comm.state._model_name) ?? optionalString(comm.model_name),
  };
}

function normalizeSnapshotWidgetComm(value: unknown): SnapshotWidgetComm | null {
  const entry = asRecord(value);
  const commId = stringValue(entry.comm_id) ?? stringValue(entry.commId);
  if (!commId) return null;

  const modelModule = stringValue(entry.model_module) ?? stringValue(entry.modelModule) ?? "";
  const modelName = stringValue(entry.model_name) ?? stringValue(entry.modelName) ?? "UnknownModel";
  const state = asRecord(entry.state);

  const bufferPaths = normalizeBufferPaths(entry.buffer_paths ?? entry.bufferPaths);
  const textPaths = normalizeBufferPaths(entry.text_paths ?? entry.textPaths);

  return {
    comm_id: commId,
    target_name:
      stringValue(entry.target_name) ?? stringValue(entry.targetName) ?? "jupyter.widget",
    model_module: modelModule,
    model_name: modelName,
    state,
    ...(bufferPaths ? { buffer_paths: bufferPaths } : {}),
    ...(textPaths ? { text_paths: textPaths } : {}),
    seq: numberValue(entry.seq) ?? 0,
  };
}

function resolveCommStateValue(
  value: unknown,
  blobResolver: BlobResolver,
  path: string[],
  bufferPaths: string[][],
  textPaths: string[][],
): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      resolveCommStateValue(item, blobResolver, [...path, String(index)], bufferPaths, textPaths),
    );
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  // Runtime ContentRef inline wrappers are exclusive: `{ inline: value }`.
  // Require the exact wrapper shape so ordinary widget state objects that use
  // an `inline` property are preserved.
  if (isInlineContentRef(record)) {
    return record.inline;
  }

  const blobRef = blobRefFromRecord(record);
  if (blobRef) {
    const lastKey = path[path.length - 1];
    const url = blobResolver.url(blobRef);
    if (lastKey !== "_esm" && lastKey !== "_css") {
      if (isTextMediaType(blobRef.media_type)) {
        textPaths.push(path);
      } else {
        bufferPaths.push(path);
      }
    }
    return url;
  }

  const resolved: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    resolved[key] = resolveCommStateValue(
      child,
      blobResolver,
      [...path, key],
      bufferPaths,
      textPaths,
    );
  }
  return resolved;
}

function isInlineContentRef(value: Record<string, unknown>): boolean {
  return hasOwn(value, "inline") && Object.keys(value).length === 1;
}

function blobRefFromRecord(value: Record<string, unknown>): BlobRef | null {
  if (!isBlobContentRef(value)) return null;
  return {
    blob: value.blob,
    size: value.size,
    media_type: typeof value.media_type === "string" ? value.media_type : undefined,
  };
}

function isBlobContentRef(
  value: Record<string, unknown>,
): value is { blob: string; size: number; media_type?: unknown } {
  if (!hasOwn(value, "blob") || !hasOwn(value, "size")) return false;
  if (typeof value.blob !== "string" || typeof value.size !== "number") return false;
  return Object.keys(value).every(
    (key) => key === "blob" || key === "size" || key === "media_type",
  );
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isTextMediaType(mediaType: unknown): boolean {
  // Match runtimed-wasm's resolver: missing or unknown media_type stays on the
  // binary path so legacy refs remain URL/DataView-compatible.
  return typeof mediaType === "string" && !isBinaryMimeType(mediaType);
}

function isBinaryMimeType(mediaType: string): boolean {
  const normalized = mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    normalized === "application/octet-stream" ||
    normalized.startsWith("image/") ||
    normalized.startsWith("audio/") ||
    normalized.startsWith("video/") ||
    normalized === "application/pdf" ||
    normalized === "application/zip" ||
    normalized === "application/gzip" ||
    normalized === "application/x-gzip" ||
    normalized === "application/vnd.apache.arrow.file" ||
    normalized === "application/vnd.apache.arrow.stream"
  );
}

function normalizeBufferPaths(value: unknown): string[][] | undefined {
  if (!Array.isArray(value)) return undefined;
  const paths = value.filter(
    (path): path is string[] =>
      Array.isArray(path) && path.every((part) => typeof part === "string"),
  );
  return paths.length > 0 ? paths : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalString(value: string): string | undefined {
  return value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

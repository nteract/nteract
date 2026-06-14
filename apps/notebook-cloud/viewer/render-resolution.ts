import type { JupyterOutput } from "@/components/cell/jupyter-output";
import type { NotebookViewCell } from "@/components/notebook";
import {
  isOutputManifest,
  resolveContentRef,
  resolveManifest,
  resolveManifestSync,
  type ContentRef,
  type OutputManifest,
} from "@/components/isolated/output-manifest";
import type { BlobResolver } from "runtimed";

export interface RenderCell {
  id?: unknown;
  cell_type?: unknown;
  source?: unknown;
  execution_id?: unknown;
  execution_count?: unknown;
  outputs?: unknown;
  metadata?: unknown;
}

export interface ResolvedCell extends NotebookViewCell {
  id: string;
  cellType: "code" | "markdown" | "raw";
  source: string;
  language: string | null;
  executionId: string | null;
  executionCount: number | null;
  outputs: JupyterOutput[];
  metadata: Record<string, unknown>;
}

type OutputResolutionCacheEntry = JupyterOutput | Promise<JupyterOutput | null>;

export type OutputResolutionCache = Map<string, OutputResolutionCacheEntry>;

export const OUTPUT_RESOLUTION_CACHE_MAX_ENTRIES = 1024;

const ASYNC_OUTPUT_REQUIRED = Symbol("async-output-required");
const RUNT_OUTPUT_CACHE_KEY = "_runt_output_cache_key";

type SyncOutputResolution = JupyterOutput | null | typeof ASYNC_OUTPUT_REQUIRED;

export function createOutputResolutionCache(): OutputResolutionCache {
  return new Map();
}

export async function resolveCell(
  cell: RenderCell,
  blobResolver: BlobResolver,
  index: number,
  defaultLanguage: string | null = null,
  cache?: OutputResolutionCache,
): Promise<ResolvedCell> {
  const cellType = normalizeCellType(cell.cell_type);
  const metadata = normalizeMetadata(cell.metadata);
  const cellId = typeof cell.id === "string" ? cell.id : `cell-${index + 1}`;
  const outputs = Array.isArray(cell.outputs)
    ? await resolveOutputs(cell.outputs, blobResolver, cellId, cache)
    : [];
  const executionCount =
    normalizeExecutionCount(cell.execution_count) ?? executionCountFromOutputs(outputs);
  return {
    id: cellId,
    cellType,
    source: typeof cell.source === "string" ? cell.source : "",
    language: cellType === "code" ? (normalizeCellLanguage(metadata) ?? defaultLanguage) : null,
    executionId: normalizeExecutionId(cell.execution_id),
    executionCount,
    outputs,
    metadata,
  };
}

export function resolveCellSync(
  cell: RenderCell,
  blobResolver: BlobResolver,
  index: number,
  defaultLanguage: string | null = null,
  cache?: OutputResolutionCache,
): ResolvedCell {
  const cellType = normalizeCellType(cell.cell_type);
  const metadata = normalizeMetadata(cell.metadata);
  const cellId = typeof cell.id === "string" ? cell.id : `cell-${index + 1}`;
  const outputs = Array.isArray(cell.outputs)
    ? resolveOutputsSync(cell.outputs, blobResolver, cellId, cache)
    : [];
  const executionCount =
    normalizeExecutionCount(cell.execution_count) ?? executionCountFromOutputs(outputs);
  return {
    id: cellId,
    cellType,
    source: typeof cell.source === "string" ? cell.source : "",
    language: cellType === "code" ? (normalizeCellLanguage(metadata) ?? defaultLanguage) : null,
    executionId: normalizeExecutionId(cell.execution_id),
    executionCount,
    outputs,
    metadata,
  };
}

export async function resolveOutputs(
  outputs: unknown[],
  blobResolver: BlobResolver,
  cellId: string = "output",
  cache?: OutputResolutionCache,
): Promise<JupyterOutput[]> {
  const resolved = await Promise.all(
    outputs.map(async (output, index) => {
      const fallbackErrorId = missingOutputIdFallback(cellId, index);
      try {
        return await resolveOutput(output, blobResolver, cache);
      } catch (error) {
        return outputResolutionError(error, output, fallbackErrorId);
      }
    }),
  );
  return resolved.filter((output): output is JupyterOutput => output !== null);
}

export function resolveOutputsSync(
  outputs: unknown[],
  blobResolver: BlobResolver,
  cellId: string = "output",
  cache?: OutputResolutionCache,
): JupyterOutput[] {
  return outputs
    .map((output, index) => {
      const fallbackErrorId = missingOutputIdFallback(cellId, index);
      try {
        const resolved = resolveOutputSync(output, blobResolver, cache);
        return resolved === ASYNC_OUTPUT_REQUIRED ? null : resolved;
      } catch (error) {
        return outputResolutionError(error, output, fallbackErrorId);
      }
    })
    .filter((output): output is JupyterOutput => output !== null);
}

async function resolveOutput(
  output: unknown,
  blobResolver: BlobResolver,
  cache?: OutputResolutionCache,
): Promise<JupyterOutput | null> {
  const cacheKey = cache ? outputResolutionCacheKey(output) : null;
  const cached = cache && cacheKey ? cache.get(cacheKey) : undefined;
  if (cached) {
    return isPromiseLike(cached) ? await cached : cached;
  }

  const syncResolved = resolveOutputSync(output, blobResolver, cache);
  if (syncResolved !== ASYNC_OUTPUT_REQUIRED) {
    return syncResolved;
  }

  const resolution = resolveOutputAsyncUncached(output, blobResolver)
    .then((resolved) => {
      if (cacheKey) {
        if (resolved) {
          setOutputResolutionCacheEntry(cache, cacheKey, resolved);
        } else {
          cache?.delete(cacheKey);
        }
      }
      return resolved;
    })
    .catch((error) => {
      if (cacheKey) cache?.delete(cacheKey);
      throw error;
    });
  if (cacheKey) setOutputResolutionCacheEntry(cache, cacheKey, resolution);
  return resolution;
}

function resolveOutputSync(
  output: unknown,
  blobResolver: BlobResolver,
  cache?: OutputResolutionCache,
): SyncOutputResolution {
  const cacheKey = cache ? outputResolutionCacheKey(output) : null;
  const cached = cache && cacheKey ? cache.get(cacheKey) : undefined;
  if (cached) {
    return isPromiseLike(cached) ? ASYNC_OUTPUT_REQUIRED : cached;
  }

  if (typeof output === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(output) as unknown;
    } catch {
      return null;
    }
    return resolveOutputSync(parsed, blobResolver, cache);
  }

  if (isOutputManifest(output)) {
    const resolved = resolveManifestSync(output as OutputManifest, blobResolver) as JupyterOutput;
    if (!resolved) return ASYNC_OUTPUT_REQUIRED;
    if (cacheKey) setOutputResolutionCacheEntry(cache, cacheKey, resolved);
    return resolved;
  }

  if (isJupyterOutput(output)) {
    assertIdentifiedJupyterOutput(output);
    if (jupyterOutputNeedsAsyncResolution(output)) return ASYNC_OUTPUT_REQUIRED;
    if (cacheKey) setOutputResolutionCacheEntry(cache, cacheKey, output);
    return output;
  }

  return null;
}

async function resolveOutputAsyncUncached(
  output: unknown,
  blobResolver: BlobResolver,
): Promise<JupyterOutput | null> {
  if (typeof output === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(output) as unknown;
    } catch {
      return null;
    }
    return resolveOutputAsyncUncached(parsed, blobResolver);
  }

  if (isOutputManifest(output)) {
    const resolved = (await resolveManifest(
      output as OutputManifest,
      blobResolver,
    )) as JupyterOutput;
    return resolved;
  }

  if (isJupyterOutput(output)) {
    return resolveJupyterOutput(output, blobResolver);
  }

  return null;
}

async function resolveJupyterOutput(
  output: JupyterOutput,
  blobResolver: BlobResolver,
): Promise<JupyterOutput> {
  assertIdentifiedJupyterOutput(output);
  const identified = output;

  if (identified.output_type === "display_data" || identified.output_type === "execute_result") {
    const data = { ...identified.data };
    let changed = false;
    for (const [mimeType, value] of Object.entries(data)) {
      if (!isContentRefLike(value, mimeType)) continue;
      data[mimeType] = await resolveContentRef(value as ContentRef, blobResolver, mimeType);
      changed = true;
    }
    return changed ? { ...identified, data } : identified;
  }

  if (identified.output_type === "stream" && isContentRefLike(identified.text)) {
    return {
      ...identified,
      text: await resolveContentRef(identified.text as ContentRef, blobResolver),
    };
  }

  return identified;
}

function jupyterOutputNeedsAsyncResolution(output: JupyterOutput): boolean {
  if (output.output_type === "display_data" || output.output_type === "execute_result") {
    return Object.entries(output.data).some(([mimeType, value]) =>
      isContentRefLike(value, mimeType),
    );
  }
  if (output.output_type === "stream") {
    return isContentRefLike(output.text);
  }
  return false;
}

function outputResolutionCacheKey(output: unknown): string | null {
  const cacheSubject = outputCacheKeySubject(output);
  const serialized = serializedOutputCacheKey(output, cacheSubject.value);
  if (serialized === null) return null;
  return outputMissingOutputId(cacheSubject.value) ? null : serialized;
}

function serializedOutputCacheKey(output: unknown, cacheSubject: unknown = output): string | null {
  const stamped = stampedOutputCacheKey(cacheSubject);
  if (stamped !== null) return stamped;
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return null;
  }
}

function outputCacheKeySubject(output: unknown): { value: unknown; parsedString: boolean } {
  if (typeof output !== "string") return { value: output, parsedString: false };
  try {
    return { value: JSON.parse(output) as unknown, parsedString: true };
  } catch {
    return { value: output, parsedString: false };
  }
}

function stampedOutputCacheKey(output: unknown): string | null {
  if (typeof output !== "object" || output === null) return null;
  const key = (output as Record<string, unknown>)[RUNT_OUTPUT_CACHE_KEY];
  return typeof key === "string" ? key : null;
}

function outputMissingOutputId(output: unknown): boolean {
  if (typeof output === "string") {
    try {
      return outputMissingOutputId(JSON.parse(output) as unknown);
    } catch {
      return false;
    }
  }
  if (!isJupyterOutput(output)) {
    return false;
  }
  return !hasOutputId(output);
}

function isPromiseLike(value: OutputResolutionCacheEntry): value is Promise<JupyterOutput | null> {
  return typeof (value as Promise<JupyterOutput | null>).then === "function";
}

function setOutputResolutionCacheEntry(
  cache: OutputResolutionCache | undefined,
  key: string,
  value: OutputResolutionCacheEntry,
): void {
  if (!cache) return;
  if (!cache.has(key) && cache.size >= OUTPUT_RESOLUTION_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (typeof oldestKey === "string") {
      cache.delete(oldestKey);
    }
  }
  cache.set(key, value);
}

function assertIdentifiedJupyterOutput(output: JupyterOutput): asserts output is JupyterOutput & {
  output_id: string;
} {
  if (!hasOutputId(output)) {
    throw new Error("Cannot render output without output_id");
  }
}

function outputResolutionError(
  error: unknown,
  output: unknown,
  fallbackOutputId: string,
): JupyterOutput {
  const message = error instanceof Error ? error.message : String(error);
  return {
    output_id: resolutionErrorOutputId(output, fallbackOutputId),
    output_type: "error",
    ename: "OutputResolutionError",
    evalue: `Unable to resolve output: ${message}`,
    traceback: [message],
  };
}

function resolutionErrorOutputId(output: unknown, fallbackOutputId: string): string {
  if (typeof output === "object" && output !== null) {
    const outputId = (output as { output_id?: unknown }).output_id;
    if (typeof outputId === "string" && outputId.length > 0) {
      return `resolution-error:${outputId}`;
    }
  }
  return `resolution-error:${fallbackOutputId}`;
}

function isJupyterOutput(value: unknown): value is JupyterOutput {
  return typeof value === "object" && value !== null && "output_type" in value;
}

function hasOutputId(output: JupyterOutput): output is JupyterOutput & { output_id: string } {
  return typeof output.output_id === "string" && output.output_id.length > 0;
}

function missingOutputIdFallback(cellId: string, index: number): string {
  return `missing-output-id:${cellId}:${index}`;
}

function isContentRefLike(value: unknown, mimeType?: string): value is ContentRef {
  if (typeof value !== "object" || value === null) return false;
  const ref = value as Record<string, unknown>;
  if ("inline" in ref) return typeof ref.inline === "string";
  if ("blob" in ref) return typeof ref.blob === "string";
  if ("url" in ref) {
    return typeof ref.url === "string" && !isJsonMimeType(mimeType);
  }
  return false;
}

function isJsonMimeType(mimeType: string | undefined): boolean {
  return mimeType === "application/json" || mimeType?.endsWith("+json") === true;
}

function normalizeCellType(value: unknown): ResolvedCell["cellType"] {
  return value === "markdown" || value === "raw" ? value : "code";
}

function normalizeExecutionCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value === "null") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeExecutionId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function executionCountFromOutputs(outputs: JupyterOutput[]): number | null {
  for (const output of outputs) {
    if (
      output.output_type === "execute_result" &&
      typeof output.execution_count === "number" &&
      Number.isFinite(output.execution_count)
    ) {
      return output.execution_count;
    }
  }
  return null;
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function normalizeCellLanguage(metadata: Record<string, unknown>): string | null {
  const direct = metadata.language;
  if (typeof direct === "string") return direct;

  const runt = metadata.runt;
  if (typeof runt === "object" && runt !== null) {
    const language = (runt as Record<string, unknown>).language;
    if (typeof language === "string") return language;
  }

  return null;
}

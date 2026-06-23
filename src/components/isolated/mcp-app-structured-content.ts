import type { NteractEmbeddableOutput, ResolveEmbeddableOutputsOptions } from "./embeddable-output";
import type { ContentRef, OutputBlobResolver, OutputManifest } from "./output-manifest";
import { selectMimeType } from "@/components/outputs/mime-priority";
import { parseWidgetViewModelId, WIDGET_VIEW_MIME } from "@/components/widgets/widget-state";

export interface McpAppCellOutput {
  output_type: "stream" | "error" | "display_data" | "execute_result";
  output_id?: string;
  name?: string;
  text?: unknown;
  ename?: string;
  evalue?: string;
  traceback?: string[] | string;
  data?: Record<string, unknown>;
  execution_count?: number | null;
  llm_preview?: unknown;
}

export interface McpAppCellData {
  cell_id: string;
  cell_type: string;
  source: string;
  outputs: McpAppCellOutput[];
  execution_count: number | null;
  status: string;
}

export interface McpAppStructuredContent {
  cell?: McpAppCellData;
  cells?: McpAppCellData[];
  blob_base_url?: string;
}

export interface McpSharedOutputInputs {
  outputs: NteractEmbeddableOutput[];
  resolveOptions: ResolveEmbeddableOutputsOptions;
}

export const MCP_APP_INLINE_RASTER_IMAGE_MAX_BYTES = 256 * 1024;

const COLLAPSED_PREVIEW_MIME_TYPES = new Set(["text/plain", "text/llm+plain", "application/json"]);
const INLINE_RASTER_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function blobHashFromUrl(value: string, blobBaseUrl: string | undefined): string | null {
  if (!blobBaseUrl) return null;

  const prefix = `${trimTrailingSlash(blobBaseUrl)}/blob/`;
  if (!value.startsWith(prefix)) return null;

  const hash = value.slice(prefix.length).split(/[?#]/, 1)[0];
  return hash ? decodeURIComponent(hash) : null;
}

function contentRefFromValue(value: unknown, blobBaseUrl: string | undefined): ContentRef {
  if (typeof value === "string") {
    const blob = blobHashFromUrl(value, blobBaseUrl);
    if (blob) return { blob };
    return { inline: value };
  }

  return { inline: JSON.stringify(value) };
}

function fallbackOutputId(cell: McpAppCellData, outputIndex: number): string {
  return `${cell.cell_id}:output:${outputIndex}`;
}

function widgetViewMetadata(data: Record<string, unknown>): Record<string, unknown> {
  if (selectMimeType(data) !== WIDGET_VIEW_MIME) return {};
  if (!parseWidgetViewModelId(data[WIDGET_VIEW_MIME])) return {};

  const summary = typeof data["text/llm+plain"] === "string" ? data["text/llm+plain"] : undefined;
  return {
    [WIDGET_VIEW_MIME]: {
      nteractWidgetMissingState: "stale",
      ...(summary ? { nteractWidgetSummary: summary } : {}),
    },
  };
}

function cellOutputToManifest(
  cell: McpAppCellData,
  output: McpAppCellOutput,
  outputIndex: number,
  blobBaseUrl: string | undefined,
): OutputManifest | null {
  const output_id = output.output_id ?? fallbackOutputId(cell, outputIndex);

  switch (output.output_type) {
    case "display_data":
    case "execute_result": {
      if (!output.data) return null;
      const data = Object.fromEntries(
        Object.entries(output.data).map(([mime, value]) => [
          mime,
          contentRefFromValue(value, blobBaseUrl),
        ]),
      );
      if (output.output_type === "execute_result") {
        return {
          output_id,
          output_type: "execute_result",
          data,
          metadata: widgetViewMetadata(output.data),
          execution_count: output.execution_count ?? null,
        };
      }
      return {
        output_id,
        output_type: "display_data",
        data,
        metadata: widgetViewMetadata(output.data),
      };
    }
    case "stream":
      return {
        output_id,
        output_type: "stream",
        name: output.name ?? "stdout",
        text: contentRefFromValue(output.text ?? "", blobBaseUrl),
      };
    case "error":
      return {
        output_id,
        output_type: "error",
        ename: output.ename ?? "Error",
        evalue: output.evalue ?? "",
        traceback: Array.isArray(output.traceback)
          ? { inline: JSON.stringify(output.traceback) }
          : contentRefFromValue(output.traceback ?? "[]", blobBaseUrl),
      };
    default:
      return null;
  }
}

export function mcpAppCellsToSharedOutputs(
  cells: readonly McpAppCellData[],
  blobBaseUrl: string | undefined,
): NteractEmbeddableOutput[] {
  return cells.flatMap((cell) =>
    (cell.outputs ?? []).flatMap((output, index) => {
      const manifest = cellOutputToManifest(cell, output, index, blobBaseUrl);
      return manifest ? [manifest] : [];
    }),
  );
}

export function mcpAppCellHasRichOutput(cell: McpAppCellData): boolean {
  return (cell.outputs ?? []).some((output) => {
    if (output.output_type !== "display_data" && output.output_type !== "execute_result") {
      return false;
    }
    if (!output.data) return false;

    const selectedMime = selectMimeType(output.data);
    return selectedMime != null && !COLLAPSED_PREVIEW_MIME_TYPES.has(selectedMime);
  });
}

function firstPreviewLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? "";
}

function stringFromRecord(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function previewFromLlmPreview(preview: unknown): string {
  if (typeof preview === "string") return firstPreviewLine(preview);
  if (typeof preview !== "object" || preview === null) return "";

  const record = preview as Record<string, unknown>;
  return firstPreviewLine(
    stringFromRecord(record, "last_frame") ??
      stringFromRecord(record, "head") ??
      stringFromRecord(record, "tail") ??
      "",
  );
}

export function mcpAppCellPreviewText(cell: McpAppCellData): string {
  for (const output of cell.outputs ?? []) {
    if (output.data?.["text/llm+plain"]) {
      return firstPreviewLine(String(output.data["text/llm+plain"]));
    }
  }

  for (const output of cell.outputs ?? []) {
    const preview = previewFromLlmPreview(output.llm_preview);
    if (preview) return preview;
  }

  for (const output of cell.outputs ?? []) {
    if (
      (output.output_type === "display_data" || output.output_type === "execute_result") &&
      output.data?.["text/plain"]
    ) {
      return firstPreviewLine(String(output.data["text/plain"]));
    }
  }

  for (const output of cell.outputs ?? []) {
    if (output.output_type === "stream" && output.text) {
      return firstPreviewLine(String(output.text));
    }
  }

  for (const output of cell.outputs ?? []) {
    if (output.output_type === "error") {
      const name = output.ename || "Error";
      const value = output.evalue || "";
      return value ? `${name}: ${value}` : name;
    }
  }

  return cell.status || "";
}

interface McpAppBlobResolverOptions {
  inlineRasterImageBlobs?: boolean;
  maxInlineImageBytes?: number;
}

function parseContentLength(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function createMcpAppBlobResolver(
  blobBaseUrl: string,
  options: McpAppBlobResolverOptions = {},
): OutputBlobResolver {
  const base = trimTrailingSlash(blobBaseUrl);
  const url = (ref: { blob: string }) => `${base}/blob/${encodeURIComponent(ref.blob)}`;
  const maxInlineImageBytes = options.maxInlineImageBytes ?? MCP_APP_INLINE_RASTER_IMAGE_MAX_BYTES;
  const displayUrlCache = new Map<string, Promise<string>>();

  async function inlineRasterImageDisplayUrl(
    ref: { blob: string; size?: number; media_type?: string },
    mediaType?: string,
  ): Promise<string> {
    const resolvedUrl = url(ref);
    const imageMimeType = mediaType ?? ref.media_type;
    if (!imageMimeType || !INLINE_RASTER_IMAGE_MIME_TYPES.has(imageMimeType)) {
      return resolvedUrl;
    }
    if (ref.size != null && ref.size > maxInlineImageBytes) {
      return resolvedUrl;
    }

    const cacheKey = `${ref.blob}:${imageMimeType}`;
    const cached = displayUrlCache.get(cacheKey);
    if (cached) return cached;

    const promise = (async () => {
      try {
        const response = await fetch(resolvedUrl);
        if (!response.ok) return resolvedUrl;

        const declaredBytes =
          parseContentLength(response.headers.get("content-length")) ?? ref.size;
        if (declaredBytes == null || declaredBytes > maxInlineImageBytes) {
          void response.body?.cancel().catch(() => {});
          return resolvedUrl;
        }

        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > maxInlineImageBytes) {
          return resolvedUrl;
        }

        return `data:${imageMimeType};base64,${bytesToBase64(bytes)}`;
      } catch {
        return resolvedUrl;
      }
    })();

    displayUrlCache.set(cacheKey, promise);
    return promise;
  }

  return {
    url,
    ...(options.inlineRasterImageBlobs
      ? {
          displayUrl: inlineRasterImageDisplayUrl,
          resolvesBinaryUrlsSynchronously: false,
        }
      : { resolvesBinaryUrlsSynchronously: true }),
    fetch(ref) {
      return fetch(url(ref));
    },
  };
}

export function createInlineOnlyBlobResolver(): OutputBlobResolver {
  return {
    url(ref) {
      throw new Error(`Cannot construct blob URL without blob_base_url: ${ref.blob}`);
    },
    fetch(ref) {
      return Promise.reject(new Error(`Cannot fetch blob without blob_base_url: ${ref.blob}`));
    },
  };
}

export function mcpAppStructuredContentToSharedOutputInputs(
  content: McpAppStructuredContent,
): McpSharedOutputInputs {
  const cells = content.cells ?? (content.cell ? [content.cell] : []);
  const outputs = mcpAppCellsToSharedOutputs(cells, content.blob_base_url);
  return {
    outputs,
    resolveOptions: {
      blobResolver: content.blob_base_url
        ? createMcpAppBlobResolver(content.blob_base_url)
        : createInlineOnlyBlobResolver(),
    },
  };
}

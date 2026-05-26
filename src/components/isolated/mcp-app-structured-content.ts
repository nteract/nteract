import type { NteractEmbeddableOutput, ResolveEmbeddableOutputsOptions } from "./embeddable-output";
import type { ContentRef, OutputBlobResolver, OutputManifest } from "./output-manifest";
import { selectMimeType } from "@/components/outputs/mime-priority";

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

const COLLAPSED_PREVIEW_MIME_TYPES = new Set(["text/plain", "text/llm+plain", "application/json"]);

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
          metadata: {},
          execution_count: output.execution_count ?? null,
        };
      }
      return {
        output_id,
        output_type: "display_data",
        data,
        metadata: {},
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

export function createMcpAppBlobResolver(blobBaseUrl: string): OutputBlobResolver {
  const base = trimTrailingSlash(blobBaseUrl);
  const url = (ref: { blob: string }) => `${base}/blob/${encodeURIComponent(ref.blob)}`;
  return {
    url,
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

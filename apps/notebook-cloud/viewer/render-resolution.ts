import type { JupyterOutput } from "@/components/cell/jupyter-output";
import {
  isOutputManifest,
  resolveManifest,
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

export interface ResolvedCell {
  id: string;
  cellType: "code" | "markdown" | "raw";
  source: string;
  language: string | null;
  executionId: string | null;
  executionCount: number | null;
  outputs: JupyterOutput[];
  metadata: Record<string, unknown>;
}

export async function resolveCell(
  cell: RenderCell,
  blobResolver: BlobResolver,
  index: number,
  defaultLanguage: string | null = null,
): Promise<ResolvedCell> {
  const cellType = normalizeCellType(cell.cell_type);
  const metadata = normalizeMetadata(cell.metadata);
  const cellId = typeof cell.id === "string" ? cell.id : `cell-${index + 1}`;
  const outputs = Array.isArray(cell.outputs)
    ? await resolveOutputs(cell.outputs, blobResolver, cellId)
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
): Promise<JupyterOutput[]> {
  const resolved = await Promise.all(
    outputs.map(async (output, index) => {
      const syntheticOutputId = `cloud-output:${cellId}:${index}`;
      try {
        return await resolveOutput(output, blobResolver, syntheticOutputId);
      } catch (error) {
        return outputResolutionError(error, output, syntheticOutputId);
      }
    }),
  );
  return resolved.filter((output): output is JupyterOutput => output !== null);
}

async function resolveOutput(
  output: unknown,
  blobResolver: BlobResolver,
  syntheticOutputId: string,
): Promise<JupyterOutput | null> {
  if (typeof output === "string") {
    try {
      return resolveOutput(JSON.parse(output) as unknown, blobResolver, syntheticOutputId);
    } catch {
      return null;
    }
  }

  if (isOutputManifest(output)) {
    return resolveManifest(output as OutputManifest, blobResolver) as Promise<JupyterOutput>;
  }

  if (isManifestWithMissingOutputId(output)) {
    throw new Error("Cannot resolve output manifest without output_id");
  }

  if (isJupyterOutput(output)) {
    return identifyJupyterOutput(output, syntheticOutputId);
  }

  return null;
}

function identifyJupyterOutput(output: JupyterOutput, outputId: string): JupyterOutput {
  if (output.output_id) return output;
  return { ...output, output_id: outputId };
}

function outputResolutionError(
  error: unknown,
  output: unknown,
  syntheticOutputId: string,
): JupyterOutput {
  const message = error instanceof Error ? error.message : String(error);
  return {
    output_id: resolutionErrorOutputId(output, syntheticOutputId),
    output_type: "error",
    ename: "OutputResolutionError",
    evalue: `Unable to resolve output: ${message}`,
    traceback: [message],
  };
}

function resolutionErrorOutputId(output: unknown, syntheticOutputId: string): string {
  if (typeof output === "object" && output !== null) {
    const outputId = (output as { output_id?: unknown }).output_id;
    if (typeof outputId === "string" && outputId.length > 0) {
      return `resolution-error:${outputId}`;
    }
  }
  return `resolution-error:${syntheticOutputId}`;
}

function isJupyterOutput(value: unknown): value is JupyterOutput {
  return typeof value === "object" && value !== null && "output_type" in value;
}

function isManifestWithMissingOutputId(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const output = value as Record<string, unknown>;
  if (typeof output.output_id === "string" && output.output_id.length > 0) return false;

  if (output.output_type === "stream") {
    return isContentRefLike(output.text);
  }

  if (output.output_type === "display_data" || output.output_type === "execute_result") {
    const dataEntries = Object.entries(asRecord(output.data));
    return (
      dataEntries.length > 0 &&
      dataEntries.every(([mimeType, ref]) => isContentRefLike(ref, mimeType))
    );
  }

  if (output.output_type === "error") {
    return isContentRefLike(output.traceback) || isContentRefLike(output.rich);
  }

  return false;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function isContentRefLike(value: unknown, mimeType?: string): boolean {
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

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
  execution_count?: unknown;
  outputs?: unknown;
  metadata?: unknown;
}

export interface ResolvedCell {
  id: string;
  cellType: "code" | "markdown" | "raw";
  source: string;
  language: string | null;
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
  const outputs = Array.isArray(cell.outputs)
    ? await resolveOutputs(cell.outputs, blobResolver)
    : [];
  const executionCount =
    normalizeExecutionCount(cell.execution_count) ?? executionCountFromOutputs(outputs);
  return {
    id: typeof cell.id === "string" ? cell.id : `cell-${index + 1}`,
    cellType,
    source: typeof cell.source === "string" ? cell.source : "",
    language: cellType === "code" ? (normalizeCellLanguage(metadata) ?? defaultLanguage) : null,
    executionCount,
    outputs,
    metadata,
  };
}

export async function resolveOutputs(
  outputs: unknown[],
  blobResolver: BlobResolver,
): Promise<JupyterOutput[]> {
  const resolved = await Promise.all(
    outputs.map(async (output) => {
      try {
        return await resolveOutput(output, blobResolver);
      } catch (error) {
        return outputResolutionError(error);
      }
    }),
  );
  return resolved.filter((output): output is JupyterOutput => output !== null);
}

async function resolveOutput(
  output: unknown,
  blobResolver: BlobResolver,
): Promise<JupyterOutput | null> {
  if (typeof output === "string") {
    try {
      return resolveOutput(JSON.parse(output) as unknown, blobResolver);
    } catch {
      return null;
    }
  }

  if (isOutputManifest(output)) {
    return resolveManifest(output as OutputManifest, blobResolver) as Promise<JupyterOutput>;
  }

  if (isJupyterOutput(output)) {
    return output;
  }

  return null;
}

function outputResolutionError(error: unknown): JupyterOutput {
  const message = error instanceof Error ? error.message : String(error);
  return {
    output_type: "error",
    ename: "OutputResolutionError",
    evalue: `Unable to resolve output: ${message}`,
    traceback: [message],
  };
}

function isJupyterOutput(value: unknown): value is JupyterOutput {
  return typeof value === "object" && value !== null && "output_type" in value;
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

function executionCountFromOutputs(outputs: JupyterOutput[]): number | null {
  let count: number | null = null;
  for (const output of outputs) {
    if (
      (output.output_type === "execute_result" || output.output_type === "display_data") &&
      typeof output.execution_count === "number" &&
      Number.isFinite(output.execution_count)
    ) {
      count = output.execution_count;
    }
  }
  return count;
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

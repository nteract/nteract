/**
 * Prompt cell readers. Mirror `runtimed::prompt_cells` (cells.rs): a prompt cell is a raw
 * cell with an object at `metadata.nteract.prompt`; an answer cell carries
 * `metadata.nteract.prompt_response`. The daemon owns the semantics.
 */

interface PromptCellLike {
  cell_type: string;
  metadata?: Record<string, unknown>;
}

interface PromptResponseInfo {
  promptCellId: string | null;
  executionId: string | null;
  /** The placeholder cell is still filled live from the execution output. */
  streaming: boolean;
  /** The run was stopped; the answer holds only the partial text. */
  stopped: boolean;
}

function nteractMetadata(cell: PromptCellLike): Record<string, unknown> {
  const nteract = cell.metadata?.nteract;
  return nteract && typeof nteract === "object" ? (nteract as Record<string, unknown>) : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Raw cell with an object at `metadata.nteract.prompt`. */
export function isPromptCell(cell: PromptCellLike): boolean {
  return cell.cell_type === "raw" && isRecord(nteractMetadata(cell).prompt);
}

/** `metadata.nteract.prompt_response`, normalized; null for ordinary cells. */
export function promptResponse(cell: PromptCellLike): PromptResponseInfo | null {
  const response = nteractMetadata(cell).prompt_response;
  if (!isRecord(response)) return null;
  return {
    promptCellId: typeof response.prompt_cell_id === "string" ? response.prompt_cell_id : null,
    executionId: typeof response.execution_id === "string" ? response.execution_id : null,
    streaming: response.streaming === true,
    stopped: response.stopped === true,
  };
}

export type PromptRunStatus =
  /** Never run, or the last run finished. */
  | "idle"
  /** Accepted, but cells above are still running; the context is not built yet. */
  | "waiting"
  /** Context built, waiting for the prompt agent. */
  | "queued"
  | "running";

export interface PromptRunView {
  status: PromptRunStatus;
  /** Last run ended with an error (no answer text). */
  failed: boolean;
}

/** `queued` but not yet `dispatched` means the context is not built yet: still waiting. */
export function derivePromptRunView(
  execution: { status: string; dispatched?: boolean } | null | undefined,
): PromptRunView {
  switch (execution?.status) {
    case "queued":
      return { status: execution.dispatched ? "queued" : "waiting", failed: false };
    case "running":
      return { status: "running", failed: false };
    case "error":
      return { status: "idle", failed: true };
    default:
      return { status: "idle", failed: false };
  }
}

/** Error message of a failed prompt run (its `PromptError` output), if any. */
export function promptErrorMessage(
  outputs: readonly { output_type: string; ename?: string; evalue?: string }[],
): string | null {
  for (const output of outputs) {
    if (output.output_type === "error") {
      return output.evalue?.trim() || output.ename || "The prompt failed.";
    }
  }
  return null;
}

/** `text/markdown` payload of the live answer output (display_data), as one string. */
export function promptMarkdownText(
  outputs: readonly { output_type: string; data?: Record<string, unknown> }[],
): string {
  for (const output of outputs) {
    if (output.output_type !== "display_data" || !output.data) continue;
    const markdown = output.data["text/markdown"];
    if (typeof markdown === "string") return markdown;
    if (Array.isArray(markdown) && markdown.every((part) => typeof part === "string")) {
      return markdown.join("");
    }
  }
  return "";
}

/** True when an output carries the `nteract.prompt_stopped` marker of a user-stopped run. */
export function promptStoppedMarker(
  outputs: readonly { output_type: string; metadata?: Record<string, unknown> }[],
): boolean {
  for (const output of outputs) {
    const nteract = output.metadata?.nteract;
    if (isRecord(nteract) && nteract.prompt_stopped === true) return true;
  }
  return false;
}

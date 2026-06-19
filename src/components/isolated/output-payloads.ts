import type { RenderPayload } from "./frame-bridge";
import type { JupyterOutput } from "@/components/cell/jupyter-output";
import { isBokehMimeType } from "@/components/outputs/bokeh-mime";
import { isPanelMimeType } from "@/components/outputs/panel-mime";
import { DEFAULT_PRIORITY, selectMimeType } from "@/components/outputs/mime-priority";

export type IdentifiedJupyterOutput = JupyterOutput & { output_id: string };
type DataJupyterOutput = Extract<
  IdentifiedJupyterOutput,
  { output_type: "execute_result" | "display_data" }
>;

export interface RenderPayloadOptions {
  cellId?: string;
  priority?: readonly string[];
}

export function isRenderPayload(value: unknown): value is RenderPayload {
  if (typeof value !== "object" || value === null) return false;
  const payload = value as Record<string, unknown>;
  return (
    typeof payload.mimeType === "string" &&
    "data" in payload &&
    typeof payload.outputId === "string" &&
    payload.outputId.length > 0
  );
}

function normalizeText(text: string | string[]): string {
  return Array.isArray(text) ? text.join("") : text;
}

function requireOutputId(output: IdentifiedJupyterOutput): string {
  if (!output.output_id) {
    throw new Error("Cannot render isolated output without output_id");
  }
  return output.output_id;
}

function isJavascriptBundleMimeType(mimeType: string): boolean {
  return isBokehMimeType(mimeType) || isPanelMimeType(mimeType);
}

function dataForSelectedMime(output: DataJupyterOutput, mimeType: string): unknown {
  if (!isJavascriptBundleMimeType(mimeType)) {
    return output.data[mimeType];
  }

  return {
    [mimeType]: output.data[mimeType],
    "application/javascript": output.data["application/javascript"],
    "text/html": output.data["text/html"],
  };
}

export function jupyterOutputToRenderPayload(
  output: IdentifiedJupyterOutput,
  outputIndex: number,
  options: RenderPayloadOptions = {},
): RenderPayload | null {
  const { cellId, priority = DEFAULT_PRIORITY } = options;
  const outputId = requireOutputId(output);

  if (output.output_type === "execute_result" || output.output_type === "display_data") {
    const mimeType = selectMimeType(output.data, priority);
    if (!mimeType) return null;
    return {
      mimeType,
      data: dataForSelectedMime(output, mimeType),
      metadata: output.metadata?.[mimeType] as Record<string, unknown> | undefined,
      outputId,
      cellId,
      outputIndex,
    };
  }

  if (output.output_type === "stream") {
    return {
      mimeType: "text/plain",
      data: normalizeText(output.text),
      metadata: { streamName: output.name },
      outputId,
      cellId,
      outputIndex,
    };
  }

  if (output.output_type === "error") {
    if (output.rich != null && typeof output.rich === "object") {
      return {
        mimeType: "application/vnd.nteract.traceback+json",
        data: output.rich,
        metadata: { isError: true },
        outputId,
        cellId,
        outputIndex,
      };
    }

    return {
      mimeType: "text/plain",
      data: output.traceback.join("\n"),
      metadata: {
        isError: true,
        ename: output.ename,
        evalue: output.evalue,
        traceback: output.traceback,
      },
      outputId,
      cellId,
      outputIndex,
    };
  }

  return null;
}

export function jupyterOutputsToRenderPayloads(
  outputs: readonly IdentifiedJupyterOutput[],
  options: RenderPayloadOptions = {},
): RenderPayload[] {
  return outputs.flatMap((output, index) => {
    const payload = jupyterOutputToRenderPayload(output, index, options);
    return payload ? [payload] : [];
  });
}

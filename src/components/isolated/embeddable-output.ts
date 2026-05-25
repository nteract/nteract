import type { RenderPayload } from "./frame-bridge";
import {
  isOutputManifest,
  resolveManifest,
  type OutputBlobResolver,
  type OutputManifest,
} from "./output-manifest";
import {
  isRenderPayload,
  jupyterOutputToRenderPayload,
  type IdentifiedJupyterOutput,
  type RenderPayloadOptions,
} from "./output-payloads";

export type NteractEmbeddableOutput =
  | RenderPayload
  | IdentifiedJupyterOutput
  | OutputManifest
  | string;

export interface ResolveEmbeddableOutputsOptions extends RenderPayloadOptions {
  blobResolver?: OutputBlobResolver;
}

function isIdentifiedJupyterOutput(value: unknown): value is IdentifiedJupyterOutput {
  if (typeof value !== "object" || value === null) return false;
  const output = value as Record<string, unknown>;
  return (
    "output_type" in output && typeof output.output_id === "string" && output.output_id.length > 0
  );
}

async function resolveOneEmbeddableOutput(
  output: NteractEmbeddableOutput,
  outputIndex: number,
  options: ResolveEmbeddableOutputsOptions,
): Promise<RenderPayload[]> {
  if (isRenderPayload(output)) {
    return [{ ...output, outputIndex: output.outputIndex ?? outputIndex }];
  }

  if (typeof output === "string") {
    try {
      return resolveOneEmbeddableOutput(
        JSON.parse(output) as NteractEmbeddableOutput,
        outputIndex,
        options,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse embeddable output JSON: ${message}`);
    }
  }

  if (isOutputManifest(output)) {
    if (!options.blobResolver) {
      throw new Error("A blobResolver is required to resolve output manifests");
    }
    const resolved = await resolveManifest(output, options.blobResolver);
    const payload = jupyterOutputToRenderPayload(
      resolved as IdentifiedJupyterOutput,
      outputIndex,
      options,
    );
    return payload ? [payload] : [];
  }

  if (isIdentifiedJupyterOutput(output)) {
    const payload = jupyterOutputToRenderPayload(output, outputIndex, options);
    return payload ? [payload] : [];
  }

  throw new Error("Unsupported embeddable output value");
}

export async function resolveEmbeddableOutputs(
  output: NteractEmbeddableOutput | readonly NteractEmbeddableOutput[],
  options: ResolveEmbeddableOutputsOptions = {},
): Promise<RenderPayload[]> {
  const outputs = Array.isArray(output) ? output : [output];
  const resolved = await Promise.all(
    outputs.map((entry, index) => resolveOneEmbeddableOutput(entry, index, options)),
  );
  return resolved.flat();
}

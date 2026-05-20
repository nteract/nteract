import type { JupyterOutput } from "@/components/cell/jupyter-output";
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
  type RenderPayloadOptions,
} from "./output-payloads";

export type NteractEmbeddableOutput = RenderPayload | JupyterOutput | OutputManifest | string;

export interface ResolveEmbeddableOutputsOptions extends RenderPayloadOptions {
  blobResolver?: OutputBlobResolver;
}

function isJupyterOutput(value: unknown): value is JupyterOutput {
  return typeof value === "object" && value !== null && "output_type" in value;
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
    return resolveOneEmbeddableOutput(
      JSON.parse(output) as NteractEmbeddableOutput,
      outputIndex,
      options,
    );
  }

  if (isOutputManifest(output)) {
    if (!options.blobResolver) {
      throw new Error("A blobResolver is required to resolve output manifests");
    }
    const resolved = await resolveManifest(output, options.blobResolver);
    const payload = jupyterOutputToRenderPayload(resolved as JupyterOutput, outputIndex, options);
    return payload ? [payload] : [];
  }

  if (isJupyterOutput(output)) {
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

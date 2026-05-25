import { describe, expect, it, vi } from "vite-plus/test";
import { resolveEmbeddableOutputs } from "../embeddable-output";
import type { OutputBlobResolver, OutputManifest } from "../output-manifest";

function fakeBlobResolver(blobs: Record<string, string>): OutputBlobResolver {
  return {
    url(ref: { blob: string }) {
      return `https://outputs.example.test/blob/${ref.blob}`;
    },
    fetch: vi.fn(async (ref) => {
      const body = blobs[ref.blob];
      return new Response(body ?? "", {
        status: body == null ? 404 : 200,
      });
    }),
  };
}

describe("resolveEmbeddableOutputs", () => {
  it("passes through render payloads", async () => {
    const [payload] = await resolveEmbeddableOutputs({
      mimeType: "text/plain",
      data: "hello",
      outputId: "direct-output",
    });

    expect(payload).toMatchObject({
      mimeType: "text/plain",
      data: "hello",
      outputId: "direct-output",
      outputIndex: 0,
    });
  });

  it("converts Jupyter outputs to renderer payloads", async () => {
    const [payload] = await resolveEmbeddableOutputs(
      {
        output_id: "out-1",
        output_type: "display_data",
        data: {
          "text/plain": "plain fallback",
          "text/html": "<table><tr><td>cell</td></tr></table>",
        },
        metadata: {
          "text/html": { isolated: true },
        },
      },
      { cellId: "cell-1" },
    );

    expect(payload).toMatchObject({
      mimeType: "text/html",
      data: "<table><tr><td>cell</td></tr></table>",
      metadata: { isolated: true },
      outputId: "out-1",
      cellId: "cell-1",
      outputIndex: 0,
    });
  });

  it("rejects Jupyter outputs without explicit output identity", async () => {
    await expect(
      resolveEmbeddableOutputs(
        JSON.stringify({
          output_type: "display_data",
          data: {
            "text/plain": "plain fallback",
          },
          metadata: {},
        }),
      ),
    ).rejects.toThrow("Unsupported embeddable output value");
  });

  it("resolves blob-backed manifests through HostBlobResolver", async () => {
    const blobResolver = fakeBlobResolver({
      html: "<strong>from blob</strong>",
    });
    const manifest: OutputManifest = {
      output_id: "out-2",
      output_type: "display_data",
      data: {
        "text/html": { blob: "html", size: 26 },
      },
      metadata: {
        "text/html": { source: "blob" },
      },
    };

    const [payload] = await resolveEmbeddableOutputs(manifest, {
      blobResolver,
      cellId: "cell-2",
    });

    expect(payload).toMatchObject({
      mimeType: "text/html",
      data: "<strong>from blob</strong>",
      metadata: { source: "blob" },
      outputId: "out-2",
      cellId: "cell-2",
    });
    expect(blobResolver.fetch).toHaveBeenCalledWith({ blob: "html", size: 26 });
  });

  it("requires a blob resolver for manifests", async () => {
    const manifest: OutputManifest = {
      output_id: "missing-blob-resolver",
      output_type: "stream",
      name: "stdout",
      text: { blob: "stdout", size: 5 },
    };

    await expect(resolveEmbeddableOutputs(manifest)).rejects.toThrow("A blobResolver is required");
  });

  it("reports invalid stringified output with an embeddable-output error", async () => {
    await expect(resolveEmbeddableOutputs("not json")).rejects.toThrow(
      "Failed to parse embeddable output JSON",
    );
  });
});

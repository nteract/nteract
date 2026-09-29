import { describe, it, expect, vi } from "vite-plus/test";
import { createMcpOutputTransport, createOutputResourceReader } from "../output-resources";
import { resolveDataBundle } from "@/components/isolated/output-manifest";

const hash = "a".repeat(64);
const base = "nteract://sessions/attachment/executions/run/blobs/";

describe("MCP output resource transport", () => {
  it("resolves Arrow bytes and manifest chunks without browser HTTP requests", async () => {
    const read = vi.fn(async (uri: string) => ({ contents: [{ uri, blob: btoa("ARROW"), mimeType: "application/octet-stream" }] }));
    const transport = createMcpOutputTransport(createOutputResourceReader(read), base);
    const data = await resolveDataBundle({
      "application/vnd.apache.arrow.stream": { blob: hash },
      "application/vnd.nteract.arrow-stream-manifest+json": { inline: JSON.stringify({ chunks: [{ hash, row_count: 3 }] }) },
    }, transport.blobResolver);
    const url = `data:application/vnd.apache.arrow.stream;base64,${btoa("ARROW")}`;
    expect(data["application/vnd.apache.arrow.stream"]).toBe(url);
    expect(data["application/vnd.nteract.arrow-stream-manifest+json"]).toEqual({ chunks: [{ hash, row_count: 3, url }] });
    expect(read).toHaveBeenCalledExactlyOnceWith(base + hash);
  });

  it("loads all plugin families through the shared loader and sidecars through resources", async () => {
    const read = vi.fn(async (uri: string) => ({ contents: [{ uri, text: uri, mimeType: "text/plain" }] }));
    const transport = createMcpOutputTransport(createOutputResourceReader(read), base);
    for (const mime of ["text/markdown", "application/vnd.plotly.v1+json", "application/vnd.vegalite.v5+json", "application/geo+json", "application/vnd.apache.arrow.stream"]) {
      const plugin = await transport.rendererPluginLoader(mime);
      expect(plugin?.code).toMatch(/^nteract:\/\/renderer-assets\//);
    }
    expect((await transport.rendererAssetUrls())["sift_wasm.wasm"]).toMatch(/^data:application\/wasm;base64,/);
    expect(read.mock.calls.flat().every(uri => uri.startsWith("nteract://renderer-assets/"))).toBe(true);
  });

  it("rejects unrelated response URIs and retries a failed resource", async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error("temporarily unavailable"))
      .mockResolvedValueOnce({ contents: [{ uri: base + hash, blob: btoa("ok") }] })
      .mockResolvedValueOnce({ contents: [{ uri: "file:///other", text: "secret" }] });
    const reader = createOutputResourceReader(read);
    await expect(reader(base + hash)).rejects.toThrow("temporarily unavailable");
    expect((await reader(base + hash)).bytes.length).toBe(2);
    await expect(reader("nteract://renderer-assets/sift.js")).rejects.toThrow("requested output");
    await expect(createMcpOutputTransport(reader, base).blobResolver.fetch({ blob: "../secret" })).rejects.toThrow("Invalid output blob hash");
  });
});

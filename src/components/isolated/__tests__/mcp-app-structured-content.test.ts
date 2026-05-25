import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { resolveEmbeddableOutputs } from "../embeddable-output";
import {
  createMcpAppBlobResolver,
  mcpAppCellHasRichOutput,
  mcpAppCellPreviewText,
  mcpAppCellsToSharedOutputs,
  mcpAppStructuredContentToSharedOutputInputs,
  type McpAppCellData,
  type McpAppStructuredContent,
} from "../mcp-app-structured-content";

function cellWithOutputs(outputs: McpAppCellData["outputs"]): McpAppCellData {
  return {
    cell_id: "cell-1",
    cell_type: "code",
    source: "display(value)",
    outputs,
    execution_count: 1,
    status: "done",
  };
}

describe("MCP App structured content adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("converts blob-backed HTML into shared manifests resolved by the isolated renderer path", async () => {
    const fetchImpl = vi.fn(async () => new Response("<strong>from blob</strong>"));
    vi.stubGlobal("fetch", fetchImpl);

    const content: McpAppStructuredContent = {
      blob_base_url: "http://localhost:47830",
      cell: cellWithOutputs([
        {
          output_id: "html-output",
          output_type: "display_data",
          data: {
            "text/html": "http://localhost:47830/blob/html-hash",
            "text/plain": "fallback",
          },
        },
      ]),
    };

    const { outputs, resolveOptions } = mcpAppStructuredContentToSharedOutputInputs(content);
    const [payload] = await resolveEmbeddableOutputs(outputs, resolveOptions);

    expect(fetchImpl).toHaveBeenCalledWith("http://localhost:47830/blob/html-hash");
    expect(payload).toMatchObject({
      mimeType: "text/html",
      data: "<strong>from blob</strong>",
      outputId: "html-output",
      outputIndex: 0,
    });
  });

  it("keeps raster image blobs as URLs for shared image rendering", async () => {
    const outputs = mcpAppCellsToSharedOutputs(
      [
        cellWithOutputs([
          {
            output_id: "image-output",
            output_type: "display_data",
            data: {
              "image/png": "http://localhost:47830/blob/image-hash",
              "text/plain": "<Figure size 1100x520 with 1 Axes>",
            },
          },
        ]),
      ],
      "http://localhost:47830",
    );

    const [payload] = await resolveEmbeddableOutputs(outputs, {
      blobResolver: createMcpAppBlobResolver("http://localhost:47830"),
    });

    expect(payload).toMatchObject({
      mimeType: "image/png",
      data: "http://localhost:47830/blob/image-hash",
      outputId: "image-output",
    });
  });

  it("synthesizes stable output ids for legacy MCP structured content", () => {
    const [output] = mcpAppCellsToSharedOutputs(
      [
        cellWithOutputs([
          {
            output_type: "stream",
            name: "stdout",
            text: "hello",
          },
        ]),
      ],
      undefined,
    );

    expect(output).toMatchObject({
      output_id: "cell-1:output:0",
      output_type: "stream",
      text: { inline: "hello" },
    });
  });

  it("preserves stream and error payloads as shared manifests", async () => {
    const { outputs, resolveOptions } = mcpAppStructuredContentToSharedOutputInputs({
      cell: cellWithOutputs([
        {
          output_id: "stream-output",
          output_type: "stream",
          name: "stderr",
          text: "warn\n",
        },
        {
          output_id: "error-output",
          output_type: "error",
          ename: "ValueError",
          evalue: "bad",
          traceback: ["Traceback line", "ValueError: bad"],
        },
      ]),
    });

    const payloads = await resolveEmbeddableOutputs(outputs, resolveOptions);

    expect(payloads[0]).toMatchObject({
      mimeType: "text/plain",
      data: "warn\n",
      metadata: { streamName: "stderr" },
      outputId: "stream-output",
    });
    expect(payloads[1]).toMatchObject({
      mimeType: "text/plain",
      data: "Traceback line\nValueError: bad",
      metadata: {
        isError: true,
        ename: "ValueError",
        evalue: "bad",
        traceback: ["Traceback line", "ValueError: bad"],
      },
      outputId: "error-output",
    });
  });

  it("uses shared MIME priority when deciding whether MCP App cells should expand", () => {
    expect(
      mcpAppCellHasRichOutput(
        cellWithOutputs([
          {
            output_type: "display_data",
            data: {
              "text/plain": "Widget view",
              "application/vnd.jupyter.widget-view+json": JSON.stringify({ model_id: "abc" }),
            },
          },
        ]),
      ),
    ).toBe(true);

    expect(
      mcpAppCellHasRichOutput(
        cellWithOutputs([
          {
            output_type: "display_data",
            data: {
              "text/html": "<table></table>",
              "application/vnd.apache.parquet": "http://localhost:47830/blob/table",
              "text/plain": "table fallback",
            },
          },
        ]),
      ),
    ).toBe(true);
  });

  it("keeps plain and JSON-only MCP App cells collapsed by default", () => {
    expect(
      mcpAppCellHasRichOutput(
        cellWithOutputs([
          {
            output_type: "execute_result",
            data: {
              "text/plain": "42",
              "application/json": JSON.stringify({ value: 42 }),
            },
          },
        ]),
      ),
    ).toBe(false);
  });

  it("selects collapsed MCP App previews from shared structured content policy", () => {
    expect(
      mcpAppCellPreviewText(
        cellWithOutputs([
          {
            output_type: "stream",
            name: "stdout",
            text: "raw stream\nsecond line",
          },
          {
            output_type: "display_data",
            data: {
              "text/plain": "plain display\nsecond line",
              "text/llm+plain": "assistant summary\nsecond line",
            },
          },
        ]),
      ),
    ).toBe("assistant summary");

    expect(
      mcpAppCellPreviewText(
        cellWithOutputs([
          {
            output_type: "error",
            ename: "ValueError",
            evalue: "bad value",
          },
        ]),
      ),
    ).toBe("ValueError: bad value");

    expect(mcpAppCellPreviewText({ ...cellWithOutputs([]), status: "queued" })).toBe("queued");
  });
});

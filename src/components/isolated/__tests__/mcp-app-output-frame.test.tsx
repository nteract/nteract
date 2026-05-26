import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createNteractOutputEmbed } from "../output-embed";
import { McpAppOutputFrame, type McpAppCellData } from "../mcp-app-output-frame";

const mockHandle = {
  iframe: document.createElement("iframe"),
  render: vi.fn(async () => {}),
  renderBatch: vi.fn(async () => {}),
  renderResolved: vi.fn(async () => {}),
  setHostContext: vi.fn(),
  setRendererBundle: vi.fn(),
  dispose: vi.fn(),
};

vi.mock("../output-embed", () => ({
  createNteractOutputEmbed: vi.fn(() => mockHandle),
}));

function cellWithHtmlOutput(): McpAppCellData {
  return {
    cell_id: "cell-1",
    cell_type: "code",
    source: "display(table)",
    execution_count: 1,
    status: "done",
    outputs: [
      {
        output_id: "output-1",
        output_type: "display_data",
        data: {
          "text/html": "<table></table>",
          "text/plain": "fallback",
        },
      },
    ],
  };
}

describe("McpAppOutputFrame", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("adapts MCP App cell outputs into the shared isolated output embed", async () => {
    const rendererBundle = { rendererCode: "renderer", rendererCss: "css" };
    const rendererPluginLoader = vi.fn(async () => undefined);

    render(
      <McpAppOutputFrame
        cell={cellWithHtmlOutput()}
        blobBaseUrl="http://localhost:47830"
        hostContext={{ theme: "dark", containerDimensions: { width: 640 } }}
        rendererBundle={rendererBundle}
        rendererPluginLoader={rendererPluginLoader}
        rendererAssetsBaseUrl="http://localhost:47830/plugins/"
        outputDocumentUrl="http://localhost:47830/output-frame"
      />,
    );

    await waitFor(() => expect(mockHandle.renderBatch).toHaveBeenCalled());

    expect(createNteractOutputEmbed).toHaveBeenCalledWith(
      expect.objectContaining({
        rendererBundle,
        rendererPluginLoader,
        outputDocumentUrl: "http://localhost:47830/output-frame",
        hostContext: expect.objectContaining({
          theme: "dark",
          containerDimensions: undefined,
          nteract: {
            rendererAssetsBaseUrl: "http://localhost:47830/plugins/",
            outputDocumentUrl: "http://localhost:47830/output-frame",
          },
        }),
      }),
    );
    const options = vi.mocked(createNteractOutputEmbed).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(options).not.toHaveProperty("autoHeight");
    expect(options).not.toHaveProperty("maxHeight");
    expect(mockHandle.renderBatch).toHaveBeenCalledWith([
      expect.objectContaining({
        output_id: "output-1",
        output_type: "display_data",
        data: {
          "text/html": { inline: "<table></table>" },
          "text/plain": { inline: "fallback" },
        },
      }),
    ]);
  });

  it("preserves explicit capped sizing for callers that opt into it", async () => {
    const rendererBundle = { rendererCode: "renderer", rendererCss: "css" };

    render(
      <McpAppOutputFrame
        cell={cellWithHtmlOutput()}
        rendererBundle={rendererBundle}
        autoHeight={false}
        maxHeight={480}
      />,
    );

    await waitFor(() => expect(mockHandle.renderBatch).toHaveBeenCalled());

    expect(createNteractOutputEmbed).toHaveBeenCalledWith(
      expect.objectContaining({
        rendererBundle,
        autoHeight: false,
        maxHeight: 480,
      }),
    );
  });
});

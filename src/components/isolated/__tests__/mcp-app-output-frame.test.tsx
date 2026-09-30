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

  it("forwards output links to the latest host callback without rebuilding the frame", async () => {
    const rendererBundle = { rendererCode: "renderer", rendererCss: "css" };
    const cell = cellWithHtmlOutput();
    const first = vi.fn();
    const latest = vi.fn();
    const { rerender } = render(
      <McpAppOutputFrame cell={cell} rendererBundle={rendererBundle} onLinkClick={first} />,
    );
    await waitFor(() => expect(mockHandle.renderBatch).toHaveBeenCalled());
    const options = vi.mocked(createNteractOutputEmbed).mock.calls[0][0];
    options.onLinkClick?.("https://nteract.io", false);
    expect(first).toHaveBeenCalledWith("https://nteract.io");

    rerender(
      <McpAppOutputFrame cell={cell} rendererBundle={rendererBundle} onLinkClick={latest} />,
    );
    options.onLinkClick?.("https://nteract.io/docs", false);
    expect(latest).toHaveBeenCalledExactlyOnceWith("https://nteract.io/docs");
    expect(first).toHaveBeenCalledTimes(1);
    expect(createNteractOutputEmbed).toHaveBeenCalledTimes(1);
  });

  it("drops unsafe schemes and malformed URLs before reaching the host", async () => {
    const onLinkClick = vi.fn();
    render(
      <McpAppOutputFrame
        cell={cellWithHtmlOutput()}
        rendererBundle={{ rendererCode: "renderer", rendererCss: "css" }}
        onLinkClick={onLinkClick}
      />,
    );
    await waitFor(() => expect(mockHandle.renderBatch).toHaveBeenCalled());
    const options = vi.mocked(createNteractOutputEmbed).mock.calls[0][0];
    for (const url of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "about:srcdoc#heading",
      "#heading",
      "invalid",
      null,
      123,
    ]) {
      Reflect.apply(options.onLinkClick!, undefined, [url, false]);
    }
    expect(onLinkClick).not.toHaveBeenCalled();

    options.onLinkClick?.("\u00a0 https://nteract.io/ \ufeff", false);
    expect(onLinkClick).toHaveBeenCalledExactlyOnceWith("https://nteract.io/");
  });

  it("keeps daemon-relative and fragment links out of the external browser", async () => {
    const onLinkClick = vi.fn();
    render(
      <McpAppOutputFrame
        cell={cellWithHtmlOutput()}
        rendererBundle={{ rendererCode: "renderer", rendererCss: "css" }}
        outputDocumentUrl="http://localhost:47830/output-frame"
        onLinkClick={onLinkClick}
      />,
    );
    await waitFor(() => expect(mockHandle.renderBatch).toHaveBeenCalled());
    const options = vi.mocked(createNteractOutputEmbed).mock.calls[0][0];
    options.onLinkClick?.("http://localhost:47830/output-frame#heading", false);
    options.onLinkClick?.("http://localhost:47830/relative", false);
    expect(onLinkClick).not.toHaveBeenCalled();
    options.onLinkClick?.("https://nteract.io/", false);
    expect(onLinkClick).toHaveBeenCalledExactlyOnceWith("https://nteract.io/");
  });

  it("keeps srcdoc links resolved against the widget base out of the external browser", async () => {
    const onLinkClick = vi.fn();
    render(
      <McpAppOutputFrame
        cell={cellWithHtmlOutput()}
        rendererBundle={{ rendererCode: "renderer", rendererCss: "css" }}
        outputDocumentUrl={null}
        onLinkClick={onLinkClick}
      />,
    );
    await waitFor(() => expect(mockHandle.renderBatch).toHaveBeenCalled());
    const options = vi.mocked(createNteractOutputEmbed).mock.calls[0][0];
    options.onLinkClick?.(new URL("#heading", document.baseURI).href, false);
    options.onLinkClick?.(new URL("./relative", document.baseURI).href, false);
    expect(onLinkClick).not.toHaveBeenCalled();
    options.onLinkClick?.("https://nteract.io/", false);
    expect(onLinkClick).toHaveBeenCalledExactlyOnceWith("https://nteract.io/");
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

  it("replays outputs when the output frame URL changes", async () => {
    const rendererBundle = { rendererCode: "renderer", rendererCss: "css" };
    const cell = cellWithHtmlOutput();

    const { rerender } = render(
      <McpAppOutputFrame
        cell={cell}
        blobBaseUrl="http://localhost:47830"
        rendererBundle={rendererBundle}
        outputDocumentUrl="http://localhost:47830/output-frame"
      />,
    );

    await waitFor(() => expect(mockHandle.renderBatch).toHaveBeenCalledTimes(1));

    rerender(
      <McpAppOutputFrame
        cell={cell}
        blobBaseUrl="http://localhost:47830"
        rendererBundle={rendererBundle}
        outputDocumentUrl={null}
      />,
    );

    await waitFor(() => expect(createNteractOutputEmbed).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mockHandle.renderBatch).toHaveBeenCalledTimes(2));
    expect(mockHandle.dispose).toHaveBeenCalled();
  });
});

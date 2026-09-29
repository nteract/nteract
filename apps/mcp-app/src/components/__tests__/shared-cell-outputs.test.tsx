import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { setHostLogSink } from "../../lib/host-log";
import { SharedCellOutputs } from "../shared-cell-outputs";

vi.mock("virtual:isolated-renderer", () => ({
  rendererCode: "renderer",
  rendererCss: "css",
}));

const mcpAppOutputFrameSpy = vi.fn((_props: unknown) => null);

vi.mock("@/components/isolated/mcp-app-output-frame", () => ({
  McpAppOutputFrame: (props: unknown) => {
    mcpAppOutputFrameSpy(props);
    return null;
  },
}));

describe("SharedCellOutputs", () => {
  afterEach(() => {
    vi.clearAllMocks();
    setHostLogSink(null);
  });

  it("uses MCP resources when localhost is forbidden and reports resource failures", async () => {
    const resourceReader = vi.fn().mockRejectedValue(new Error("Attachment was released"));
    const { findByRole } = render(
      <SharedCellOutputs
        cell={{
          cell_id: "table",
          cell_type: "code",
          source: "df",
          status: "done",
          execution_count: 1,
          output_resource_base: "nteract://sessions/attachment/executions/run/blobs/",
          outputs: [
            {
              output_type: "display_data",
              data: { "application/vnd.apache.arrow.stream": "bytes" },
            },
          ],
        }}
        blobBaseUrl="http://localhost:47830/"
        hostCapabilities={{
          serverResources: {},
          sandbox: { csp: { connectDomains: [], frameDomains: [] } },
        }}
        resourceReader={resourceReader}
      />,
    );
    expect(await findByRole("alert")).toHaveTextContent("Attachment was released");
    expect(mcpAppOutputFrameSpy).not.toHaveBeenCalled();
  });

  it("uses the daemon output document only when host frameDomains allow it", () => {
    render(
      <SharedCellOutputs
        cell={{
          cell_id: "cell-1",
          cell_type: "code",
          source: "display('hi')",
          execution_count: 1,
          status: "done",
          outputs: [
            {
              output_id: "output-1",
              output_type: "display_data",
              data: {
                "text/html": "<div>hi</div>",
              },
            },
          ],
        }}
        blobBaseUrl="http://localhost:47830/"
        hostCapabilities={{
          sandbox: {
            csp: {
              frameDomains: ["http://localhost:47830"],
            },
          },
        }}
      />,
    );

    expect(mcpAppOutputFrameSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        outputDocumentUrl: "http://localhost:47830/output-frame",
        inlineRasterBlobImages: false,
        rendererAssetsBaseUrl: "http://localhost:47830/plugins/",
      }),
    );
  });

  it("falls back to srcdoc when the host does not allow the daemon frame origin", () => {
    render(
      <SharedCellOutputs
        cell={{
          cell_id: "cell-1",
          cell_type: "code",
          source: "display('hi')",
          execution_count: 1,
          status: "done",
          outputs: [
            {
              output_id: "output-1",
              output_type: "display_data",
              data: {
                "text/html": "<div>hi</div>",
              },
            },
          ],
        }}
        blobBaseUrl="http://localhost:47830/"
        hostCapabilities={{
          sandbox: {
            csp: {
              frameDomains: ["https://outputs.example.test"],
            },
          },
        }}
      />,
    );

    expect(mcpAppOutputFrameSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        outputDocumentUrl: null,
        inlineRasterBlobImages: true,
      }),
    );
  });

  it("waits for host CSP before enabling the raster image inline fallback", () => {
    render(
      <SharedCellOutputs
        cell={{
          cell_id: "cell-1",
          cell_type: "code",
          source: "display('hi')",
          execution_count: 1,
          status: "done",
          outputs: [
            {
              output_id: "output-1",
              output_type: "display_data",
              data: {
                "image/png": "http://localhost:47830/blob/image-hash",
              },
            },
          ],
        }}
        blobBaseUrl="http://localhost:47830/"
        hostCapabilities={null}
      />,
    );

    expect(mcpAppOutputFrameSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        outputDocumentUrl: null,
        inlineRasterBlobImages: false,
      }),
    );
  });

  it("warns the host when daemon output frames are blocked by frameDomains", async () => {
    const sendLog = vi.fn();
    setHostLogSink({ sendLog });

    render(
      <SharedCellOutputs
        cell={{
          cell_id: "cell-1",
          cell_type: "code",
          source: "display('hi')",
          execution_count: 1,
          status: "done",
          outputs: [
            {
              output_id: "output-1",
              output_type: "display_data",
              data: {
                "image/png": "http://localhost:47830/blob/image-hash",
              },
            },
          ],
        }}
        blobBaseUrl="http://localhost:47830/"
        hostCapabilities={{
          sandbox: {
            csp: {
              frameDomains: ["https://outputs.example.test"],
            },
          },
        }}
      />,
    );

    await waitFor(() => expect(sendLog).toHaveBeenCalledTimes(1));
    expect(sendLog).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warning",
        data: expect.objectContaining({
          event: "shared-output-daemon-frame-blocked",
          outputFrameOrigin: "http://localhost:47830",
          frameDomains: ["https://outputs.example.test"],
          fallback: "srcdoc-raster-image-data-uri",
          maxInlineImageBytes: expect.any(Number),
        }),
      }),
    );
  });
});

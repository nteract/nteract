// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { SharedCellOutputs } from "../shared-cell-outputs";
import type { CellData } from "../../types";

const mocks = vi.hoisted(() => ({
  mcpAppOutputFrame: vi.fn(() => null),
}));

vi.mock("virtual:isolated-renderer", () => ({
  rendererCode: "renderer-code",
  rendererCss: "renderer-css",
}));

vi.mock("@/components/isolated/mcp-app-output-frame", () => ({
  McpAppOutputFrame: (props: unknown) => mocks.mcpAppOutputFrame(props),
}));

function cellWithHtmlOutput(): CellData {
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
        },
      },
    ],
  };
}

describe("SharedCellOutputs", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("leaves output sizing policy to the shared MCP App output adapter", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      flushSync(() => {
        root.render(
          <SharedCellOutputs
            cell={cellWithHtmlOutput()}
            blobBaseUrl="http://localhost:47830"
            hostContext={{ theme: "dark" }}
          />,
        );
      });

      expect(mocks.mcpAppOutputFrame).toHaveBeenCalledTimes(1);
      const props = mocks.mcpAppOutputFrame.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(props).not.toHaveProperty("autoHeight");
      expect(props).not.toHaveProperty("maxHeight");
      expect(props).toMatchObject({
        blobBaseUrl: "http://localhost:47830",
        className: "shared-output-frame",
        hostContext: { theme: "dark" },
        rendererBundle: {
          rendererCode: "renderer-code",
          rendererCss: "renderer-css",
        },
        rendererAssetsBaseUrl: "http://localhost:47830/plugins/",
        outputDocumentUrl: "http://localhost:47830/output-frame",
      });
    } finally {
      flushSync(() => root.unmount());
      container.remove();
    }
  });
});

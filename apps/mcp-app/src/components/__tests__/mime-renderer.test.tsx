// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { loadPluginForMime } from "../../lib/plugin-loader";
import { setHostLogSink, type HostLogParams } from "../../lib/host-log";
import { MimeRenderer } from "../mime-renderer";

vi.mock("../../lib/plugin-loader", () => ({
  needsDaemonPlugin: () => true,
  loadPluginForMime: vi.fn(),
}));

const ARROW_STREAM_MANIFEST_MIME = "application/vnd.nteract.arrow-stream-manifest+json";

describe("MimeRenderer", () => {
  let logs: HostLogParams[];

  beforeEach(() => {
    logs = [];
    setHostLogSink({
      sendLog: (params) => {
        logs.push(params);
      },
    });
  });

  afterEach(() => {
    setHostLogSink(null);
    vi.restoreAllMocks();
  });

  it("renders raster images directly", () => {
    render(
      <MimeRenderer
        blobBaseUrl="http://localhost:47830"
        data={{
          "image/png": "http://localhost:47830/blob/f00f3d991a8191036",
          "text/plain": "<Figure size 1100x520 with 1 Axes>",
        }}
      />,
    );

    const image = screen.getByRole("img", {
      name: "<Figure size 1100x520 with 1 Axes>",
    });
    expect(image.getAttribute("src")).toBe("http://localhost:47830/blob/f00f3d991a8191036");
    expect(image.classList.contains("image-output")).toBe(true);
    expect(loadPluginForMime).not.toHaveBeenCalled();
  });

  it("sends host-facing logs when plugin rendering fails", async () => {
    vi.mocked(loadPluginForMime).mockReturnValue(Promise.reject(new Error("blocked by CSP")));

    render(
      <MimeRenderer
        blobBaseUrl="http://localhost:47830"
        data={{
          [ARROW_STREAM_MANIFEST_MIME]: JSON.stringify({ chunks: [] }),
          "text/plain": "shape: (3, 2)\ncolumn_1  column_2",
        }}
      />,
    );

    expect(await screen.findByText(/shape: \(3, 2\)/)).toBeTruthy();
    await waitFor(() => {
      expect(
        logs.some((log) => (log.data as { event?: string }).event === "plugin-render-failed"),
      ).toBe(true);
    });
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "error",
        logger: "nteract.mcp-app",
        data: expect.objectContaining({
          event: "plugin-render-failed",
          mime: ARROW_STREAM_MANIFEST_MIME,
          hasPlainFallback: true,
          error: expect.objectContaining({
            message: "blocked by CSP",
          }),
        }),
      }),
    );
  });
});

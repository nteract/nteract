// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { loadPluginForMime } from "../../lib/plugin-loader";
import { MimeRenderer } from "../mime-renderer";

vi.mock("../../lib/plugin-loader", () => ({
  needsDaemonPlugin: () => true,
  loadPluginForMime: vi.fn(),
}));

const ARROW_STREAM_MANIFEST_MIME = "application/vnd.nteract.arrow-stream-manifest+json";

describe("MimeRenderer", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        text: async () => "shape: (3, 2)\ncolumn_1  column_2",
      })),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("fetches blob-backed text/plain before rendering plugin fallback text", async () => {
    vi.mocked(loadPluginForMime).mockReturnValue(Promise.reject(new Error("blocked by CSP")));

    render(
      <MimeRenderer
        blobBaseUrl="http://localhost:47830"
        data={{
          [ARROW_STREAM_MANIFEST_MIME]: JSON.stringify({ chunks: [] }),
          "text/plain": "http://localhost:47830/blob/plain-fallback",
        }}
      />,
    );

    expect(await screen.findByText(/shape: \(3, 2\)/)).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("http://localhost:47830/blob/plain-fallback");
  });
});

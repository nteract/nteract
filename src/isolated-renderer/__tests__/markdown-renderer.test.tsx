import { render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { install } from "../markdown-renderer";
import { MARKDOWN_PROJECTION_MIME_TYPE } from "@/lib/markdown-projection";

function projectedRenderer() {
  let Renderer:
    | ComponentType<{
        data: unknown;
        mimeType: string;
        metadata?: Record<string, unknown>;
      }>
    | undefined;
  install({
    register: (mimes, component) => {
      if (mimes.includes(MARKDOWN_PROJECTION_MIME_TYPE)) Renderer = component;
    },
  });
  if (!Renderer) throw new Error("Projected Markdown renderer missing");
  return Renderer;
}

describe("Markdown renderer plugin", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("renders kernel-enriched Markdown with the shared view and heading anchors", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
    const Renderer = projectedRenderer();
    const span = [0, 18];
    const measurement = { estimatedHeight: 32, confidence: "high", width: 720 };
    render(
      <Renderer
        mimeType={MARKDOWN_PROJECTION_MIME_TYPE}
        metadata={{
          nteractMarkdownHeadingAnchors: [
            {
              itemId: "outline-heading",
              title: "Renderer check",
              level: 3,
              headingAnchorId: "renderer-check",
            },
          ],
        }}
        data={{
          version: 1,
          engine: "rust-wasm",
          byteLength: 18,
          utf16Length: 18,
          measurement,
          anchors: [],
          blocks: [
            {
              blockId: "heading",
              blockIndex: 0,
              kind: "heading",
              element: "h3",
              text: "Renderer check",
              measurement,
              syntaxSpans: [],
              sourceSpanByte: span,
              sourceSpanUtf16: span,
            },
          ],
          runs: [
            {
              blockId: "heading",
              inlineId: "text",
              listItemIndex: null,
              semantic: "text",
              renderedText: "Renderer check",
              renderedTextUtf16: span,
              sourceSpanByte: span,
              sourceSpanUtf16: span,
            },
          ],
        }}
      />,
    );
    expect(screen.getByRole("heading", { name: /^Renderer check/, level: 3 })).toBeVisible();
    expect(screen.getByRole("heading", { name: /^Renderer check/, level: 3 })).toHaveAttribute(
      "id",
      "renderer-check",
    );
    expect(screen.getByRole("link", { name: "Link to Renderer check" })).toHaveAttribute(
      "href",
      "#renderer-check",
    );
    expect(screen.queryByText("rust-wasm")).not.toBeInTheDocument();
  });

  it.each([null, "not a projection", {}, { version: 2, blocks: [], runs: [] }])(
    "shows a visible error for an invalid or unsupported projection: %j",
    (data) => {
      const Renderer = projectedRenderer();
      render(<Renderer mimeType={MARKDOWN_PROJECTION_MIME_TYPE} data={data} />);
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Unable to render invalid Markdown output.",
      );
    },
  );
});

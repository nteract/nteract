import { describe, expect, it } from "vite-plus/test";
import {
  normalizeMarkdownDocumentAccess,
  projectMarkdownDocument,
  type MarkdownDocumentProjectionInput,
} from "../markdown-document";
import { setMarkdownProjectionProjector } from "../markdown-projection";

function withMarkdownProjector<T>(fn: () => T): T {
  const restore = setMarkdownProjectionProjector((source) => {
    const anchors = source
      .split("\n")
      .map((line, lineIndex) => ({ line, lineIndex }))
      .filter(({ line }) => line.startsWith("#"))
      .map(({ line, lineIndex }, index) => {
        const title = line.replace(/^#+\s*/, "");
        const level = line.match(/^#+/)?.[0]?.length ?? 1;
        const start = source.split("\n").slice(0, lineIndex).join("\n").length + (lineIndex === 0 ? 0 : 1);
        const end = start + line.length;
        return {
          anchorId: `anchor:${index}`,
          blockId: `block:${index}`,
          level,
          slug: title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
          sourceSpanByte: [start, end],
          sourceSpanUtf16: [start, end],
          title,
        };
      });
    return JSON.stringify({
      version: 1,
      engine: "test",
      byteLength: source.length,
      utf16Length: source.length,
      source,
      measurement: { estimatedHeight: 24, confidence: "high", width: 720 },
      anchors,
      blocks: anchors.map((anchor, index) => ({
        anchorSlug: anchor.slug,
        blockId: anchor.blockId,
        blockIndex: index,
        element: `h${anchor.level}`,
        kind: "heading",
        measurement: { estimatedHeight: 24, confidence: "high", width: 720 },
        sourceSpanByte: anchor.sourceSpanByte,
        sourceSpanUtf16: anchor.sourceSpanUtf16,
        syntaxSpans: [],
        text: anchor.title,
      })),
      runs: [],
    });
  });
  try {
    return fn();
  } finally {
    restore();
  }
}

describe("markdown document projection", () => {
  it("derives editable capabilities from access without runtime concepts", () => {
    const projection = projectDoc({
      id: "01KTMD",
      title: "Research note",
      body: "# Research\n\nBody",
      access: "editor",
      requestedMode: "source",
    });

    expect(projection).toMatchObject({
      id: "01KTMD",
      title: "Research note",
      access: "editor",
      mode: "source",
      canEdit: true,
      canShare: false,
      canPublish: false,
    });
    expect(projection).not.toHaveProperty("runtime");
    expect(projection).not.toHaveProperty("workstation");
    expect(projection.outlineItems).toEqual([
      expect.objectContaining({
        title: "Research",
        level: 1,
        href: "#research",
      }),
    ]);
  });

  it("forces read mode for viewers", () => {
    const projection = projectDoc({
      id: "viewer-doc",
      title: "Shared",
      body: "# Shared",
      access: "viewer",
      requestedMode: "source",
    });

    expect(projection.mode).toBe("read");
    expect(projection.canEdit).toBe(false);
    expect(projection.canShare).toBe(false);
    expect(projection.canPublish).toBe(false);
  });

  it("normalizes absent title and access", () => {
    const projection = projectDoc({
      id: "01KTMARKDOWNDOC",
      title: "  ",
      body: "",
      access: null,
    });

    expect(projection.title).toBe("Markdown 01KTMARK");
    expect(projection.access).toBe("none");
    expect(projection.markdownPlan).toBeNull();
    expect(projection.outlineItems).toEqual([]);
  });

  it("treats invalid access as none", () => {
    expect(normalizeMarkdownDocumentAccess("owner")).toBe("owner");
    expect(normalizeMarkdownDocumentAccess("editor")).toBe("editor");
    expect(normalizeMarkdownDocumentAccess("viewer")).toBe("viewer");
    expect(normalizeMarkdownDocumentAccess("runtime_peer" as never)).toBe("none");
  });
});

function projectDoc(input: MarkdownDocumentProjectionInput) {
  return withMarkdownProjector(() => projectMarkdownDocument(input));
}

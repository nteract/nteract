import { describe, expect, it, vi } from "vite-plus/test";
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
      requestedMode: "edit",
    });

    expect(projection).toMatchObject({
      id: "01KTMD",
      title: "Research note",
      access: "editor",
      mode: "edit",
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
    expect(projection.headingAnchors).toEqual([
      {
        itemId: "anchor:0",
        title: "Research",
        level: 1,
        anchor: "research",
        headingAnchorId: "research",
      },
    ]);
  });

  it("forces view mode for viewers", () => {
    const projection = projectDoc({
      id: "viewer-doc",
      title: "Shared",
      body: "# Shared",
      access: "viewer",
      requestedMode: "edit",
    });

    expect(projection.mode).toBe("view");
    expect(projection.canEdit).toBe(false);
    expect(projection.canShare).toBe(false);
    expect(projection.canPublish).toBe(false);
  });

  it("defaults editors to source representation in edit mode", () => {
    const projection = projectDoc({
      id: "editable-doc",
      title: "Editable",
      body: "# Editable",
      access: "owner",
      requestedMode: "edit",
    });

    expect(projection.representation).toMatchObject({
      active: "source",
      sourceEditable: true,
    });
    expect(projection.representation.options).toEqual([
      expect.objectContaining({ id: "rendered", disabled: false }),
      expect.objectContaining({ id: "source", disabled: false, title: "Edit Markdown source" }),
      expect.objectContaining({ id: "split", disabled: true }),
    ]);
  });

  it("allows read-only source inspection without edit authority", () => {
    const projection = projectDoc({
      id: "viewer-source-doc",
      title: "Shared",
      body: "# Shared",
      access: "viewer",
      requestedRepresentation: "source",
    });

    expect(projection.mode).toBe("view");
    expect(projection.representation).toMatchObject({
      active: "source",
      sourceEditable: false,
    });
    expect(projection.representation.options.find((option) => option.id === "source")).toEqual(
      expect.objectContaining({ title: "Inspect Markdown source", disabled: false }),
    );
  });

  it("keeps split visible but inactive until side-by-side editing is implemented", () => {
    const projection = projectDoc({
      id: "split-doc",
      title: "Split",
      body: "# Split",
      access: "editor",
      requestedMode: "edit",
      requestedRepresentation: "split",
    });

    expect(projection.representation.active).toBe("source");
    expect(projection.representation.options.find((option) => option.id === "split")).toEqual(
      expect.objectContaining({
        disabled: true,
        title: "Side-by-side source and rendered Markdown is planned",
      }),
    );
  });

  it("keeps rendered representation available for empty documents", () => {
    const projection = projectDoc({
      id: "empty-doc",
      title: "Empty",
      body: "",
      access: "owner",
      requestedMode: "edit",
      requestedRepresentation: "rendered",
    });

    expect(projection.markdownPlan).toBeNull();
    expect(projection.representation.active).toBe("rendered");
    expect(projection.representation.options.find((option) => option.id === "rendered")).toEqual(
      expect.objectContaining({ disabled: false, title: "Show rendered Markdown" }),
    );
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
    expect(projection.headingAnchors).toEqual([]);
  });

  it("uses a matching attached Markdown plan before the projector is initialized", () => {
    const source = "# Seeded\n\nRendered from a persisted snapshot.";
    const attachedPlan = projectDoc({
      id: "seeded-doc",
      title: "Seeded",
      body: source,
      access: "viewer",
    }).markdownPlan;
    expect(attachedPlan).not.toBeNull();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const projection = projectMarkdownDocument({
        id: "seeded-doc",
        title: "Seeded",
        body: source,
        markdownPlan: attachedPlan,
        access: "viewer",
      });

      expect(projection.markdownPlan).toBe(attachedPlan);
      expect(projection.outlineItems).toEqual([
        expect.objectContaining({
          title: "Seeded",
          href: "#seeded",
        }),
      ]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
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

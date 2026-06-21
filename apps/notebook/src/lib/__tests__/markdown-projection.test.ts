import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MarkdownProjectionPlan,
  MarkdownProjectionRun,
} from "../markdown-projection";

vi.mock("../../wasm/runtimed-wasm/runtimed_wasm.js", () => ({
  project_markdown_json: vi.fn(() => {
    throw new Error("runtimed WASM is not initialized");
  }),
}));

describe("markdown projection", () => {
  let module: typeof import("../markdown-projection");

  beforeEach(async () => {
    vi.resetModules();
    module = await import("../markdown-projection");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("can use a host-initialized markdown projector", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(module.projectMarkdownPlan("# Title")).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain(
      "markdown projector is not initialized",
    );

    const restore = module.setMarkdownProjectionProjector((source) =>
      JSON.stringify({
        version: 1,
        engine: "test",
        byteLength: source.length,
        utf16Length: source.length,
        measurement: {
          estimatedHeight: 32,
          confidence: "high",
          width: 720,
        },
        blocks: [
          {
            anchorSlug: "title",
            blockId: "b0",
            blockIndex: 0,
            element: "h1",
            kind: "heading",
            measurement: {
              estimatedHeight: 32,
              confidence: "high",
              width: 720,
            },
            sourceSpanByte: [0, source.length],
            sourceSpanUtf16: [0, source.length],
            syntaxSpans: [],
            text: "Title",
          },
        ],
        runs: [
          {
            blockId: "b0",
            inlineId: "r0",
            listItemIndex: null,
            renderedText: "Title",
            renderedTextUtf16: [2, 7],
            semantic: "text",
            sourceSpanByte: [2, 7],
            sourceSpanUtf16: [2, 7],
          },
        ],
      }),
    );

    const projected = module.projectMarkdownPlan("# Title");
    expect(projected?.blocks[0]?.element).toBe("h1");
    expect(module.canRenderMarkdownProjectionInHost(projected)).toBe(true);

    restore();
    expect(module.projectMarkdownPlan("# Title")).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps the missing-projector fallback safe without a process global", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("process", undefined);

    expect(module.projectMarkdownPlan("# Title")).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  describe("renderedTextForSourceRange", () => {
    it("slices transparent runs by source offsets", () => {
      const source = "abcdef";
      const plan = testPlan(source, [
        testRun({ inlineId: "r0", renderedText: "abcdef", sourceSpanUtf16: [0, 6] }),
      ]);

      expect(module.renderedTextForSourceRange(plan, 2, 5)).toBe("cde");
    });

    it("skips markdown delimiters between transparent runs", () => {
      const source = "some markdown text it is **good**";
      const plan = testPlan(source, [
        testRun({
          inlineId: "plain",
          renderedText: "some markdown text it is ",
          sourceSpanUtf16: [0, 25],
        }),
        testRun({
          inlineId: "strong",
          renderedText: "good",
          semantic: "strong",
          sourceSpanUtf16: [27, 31],
        }),
      ]);

      expect(module.renderedTextForSourceRange(plan, 2, 31)).toBe(
        "me markdown text it is good",
      );
    });

    it("uses the whole rendered text for opaque runs", () => {
      const source = "![kitten](cat.png)";
      const plan = testPlan(source, [
        testRun({
          inlineId: "image",
          renderedText: "kitten",
          semantic: "image",
          sourceSpanUtf16: [0, source.length],
        }),
      ]);

      expect(module.renderedTextForSourceRange(plan, 0, source.length)).toBe("kitten");
    });

    it("normalizes whitespace across runs", () => {
      const source = "alpha \n\t beta";
      const plan = testPlan(source, [
        testRun({ inlineId: "r0", renderedText: "alpha \n", sourceSpanUtf16: [0, 7] }),
        testRun({ inlineId: "r1", renderedText: "\t beta", sourceSpanUtf16: [7, 13] }),
      ]);

      expect(module.renderedTextForSourceRange(plan, 0, source.length)).toBe("alpha beta");
    });

    it("returns null for null plans and empty rendered ranges", () => {
      const source = "abcdef";
      const plan = testPlan(source, [
        testRun({ inlineId: "r0", renderedText: "abcdef", sourceSpanUtf16: [0, 6] }),
      ]);

      expect(module.renderedTextForSourceRange(null, 0, 3)).toBeNull();
      expect(module.renderedTextForSourceRange(plan, 2, 2)).toBeNull();
      expect(module.renderedTextForSourceRange(plan, 6, 8)).toBeNull();
    });
  });
});

function testPlan(
  source: string,
  runs: readonly MarkdownProjectionRun[],
): MarkdownProjectionPlan {
  return {
    version: 1,
    engine: "test",
    byteLength: source.length,
    utf16Length: source.length,
    measurement: {
      estimatedHeight: 32,
      confidence: "high",
      width: 720,
    },
    anchors: [],
    blocks: [],
    runs,
  };
}

function testRun({
  inlineId,
  renderedText,
  sourceSpanUtf16,
  semantic = "text",
}: {
  inlineId: string;
  renderedText: string;
  sourceSpanUtf16: readonly [number, number];
  semantic?: string;
}): MarkdownProjectionRun {
  return {
    blockId: "b0",
    inlineId,
    listItemIndex: null,
    renderedText,
    renderedTextUtf16: [0, renderedText.length],
    semantic,
    sourceSpanByte: sourceSpanUtf16,
    sourceSpanUtf16,
  };
}

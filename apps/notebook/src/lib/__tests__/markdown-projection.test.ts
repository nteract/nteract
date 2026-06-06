import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
});

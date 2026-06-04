import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ProjectedMarkdownView } from "../ProjectedMarkdownView";
import type { MarkdownProjectionPlan } from "@/lib/markdown-projection";

function plan(overrides: Partial<MarkdownProjectionPlan> = {}): MarkdownProjectionPlan {
  return {
    version: 1,
    engine: "test",
    byteLength: 0,
    utf16Length: 0,
    measurement: { estimatedHeight: 120, confidence: "high", width: 720 },
    blocks: [],
    runs: [],
    ...overrides,
  };
}

describe("ProjectedMarkdownView", () => {
  const originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");

  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
  });

  afterEach(() => {
    if (originalMatchMedia) {
      Object.defineProperty(window, "matchMedia", originalMatchMedia);
    } else {
      delete (window as Partial<Window>).matchMedia;
    }
  });

  it("renders projected inline and display math with KaTeX", () => {
    render(
      <ProjectedMarkdownView
        plan={plan({
          blocks: [
            {
              blockId: "p0",
              blockIndex: 0,
              element: "p",
              kind: "paragraph",
              measurement: { estimatedHeight: 32, confidence: "high", width: 720 },
              sourceSpanByte: [0, 16],
              sourceSpanUtf16: [0, 16],
              syntaxSpans: [],
              text: "Inline x^2",
            },
            {
              blockId: "m0",
              blockIndex: 1,
              element: "div",
              kind: "math",
              measurement: { estimatedHeight: 64, confidence: "low", width: 720 },
              sourceSpanByte: [18, 28],
              sourceSpanUtf16: [18, 28],
              syntaxSpans: [],
              text: "\\int_0^1 x dx",
            },
          ],
          runs: [
            {
              blockId: "p0",
              inlineId: "r0",
              listItemIndex: null,
              renderedText: "Inline ",
              renderedTextUtf16: [0, 7],
              semantic: "text",
              sourceSpanByte: [0, 7],
              sourceSpanUtf16: [0, 7],
            },
            {
              blockId: "p0",
              inlineId: "r1",
              listItemIndex: null,
              renderedText: "x^2",
              renderedTextUtf16: [7, 10],
              semantic: "math-source",
              sourceSpanByte: [8, 13],
              sourceSpanUtf16: [8, 13],
            },
          ],
        })}
      />,
    );

    expect(screen.getByText(/Inline/)).toBeInTheDocument();
    expect(document.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(2);
    expect(document.querySelector(".katex-display")).not.toBeNull();
    expect(document.querySelector(".katex-display")?.parentElement).toHaveClass("text-center");
  });

  it("does not trust projected math commands that can shape host DOM", () => {
    render(
      <ProjectedMarkdownView
        plan={plan({
          blocks: [
            {
              blockId: "p0",
              blockIndex: 0,
              element: "p",
              kind: "paragraph",
              measurement: { estimatedHeight: 32, confidence: "high", width: 720 },
              sourceSpanByte: [0, 26],
              sourceSpanUtf16: [0, 26],
              syntaxSpans: [],
              text: "\\htmlClass{owned}{x}",
            },
          ],
          runs: [
            {
              blockId: "p0",
              inlineId: "r0",
              listItemIndex: null,
              renderedText: "\\htmlClass{owned}{x}",
              renderedTextUtf16: [0, 20],
              semantic: "math-source",
              sourceSpanByte: [1, 25],
              sourceSpanUtf16: [1, 25],
            },
          ],
        })}
      />,
    );

    expect(document.querySelector(".katex")).not.toBeNull();
    expect(document.querySelector(".owned")).toBeNull();
  });

  it("preserves task checkboxes and inline text semantics", () => {
    render(
      <ProjectedMarkdownView
        plan={plan({
          blocks: [
            {
              blockId: "list",
              blockIndex: 0,
              element: "ul",
              kind: "list",
              measurement: { estimatedHeight: 48, confidence: "high", width: 720 },
              sourceSpanByte: [0, 40],
              sourceSpanUtf16: [0, 40],
              syntaxSpans: [],
              text: "done important removed",
            },
          ],
          runs: [
            {
              blockId: "list",
              inlineId: "done",
              listItemChecked: true,
              listItemIndex: 0,
              renderedText: "done",
              renderedTextUtf16: [0, 4],
              semantic: "list-item",
              sourceSpanByte: [0, 10],
              sourceSpanUtf16: [0, 10],
            },
            {
              blockId: "list",
              inlineId: "todo",
              listItemChecked: false,
              listItemIndex: 1,
              renderedText: "todo",
              renderedTextUtf16: [0, 4],
              semantic: "list-item",
              sourceSpanByte: [11, 21],
              sourceSpanUtf16: [11, 21],
            },
            {
              blockId: "list",
              inlineId: "em",
              listItemIndex: 2,
              renderedText: "important",
              renderedTextUtf16: [0, 9],
              semantic: "emphasis",
              sourceSpanByte: [11, 22],
              sourceSpanUtf16: [11, 22],
            },
            {
              blockId: "list",
              inlineId: "del",
              listItemIndex: 3,
              renderedText: "removed",
              renderedTextUtf16: [0, 7],
              semantic: "delete",
              sourceSpanByte: [23, 34],
              sourceSpanUtf16: [23, 34],
            },
          ],
        })}
      />,
    );

    expect(screen.getByRole("checkbox", { name: "Completed task" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Incomplete task" })).not.toBeChecked();
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    expect(screen.getByText("important").tagName).toBe("EM");
    expect(screen.getByText("removed").tagName).toBe("DEL");
  });

  it("keeps list markers available for mixed task and regular lists", () => {
    render(
      <ProjectedMarkdownView
        plan={plan({
          blocks: [
            {
              blockId: "list",
              blockIndex: 0,
              element: "ul",
              kind: "list",
              measurement: { estimatedHeight: 48, confidence: "high", width: 720 },
              sourceSpanByte: [0, 28],
              sourceSpanUtf16: [0, 28],
              syntaxSpans: [],
              text: "todo regular",
            },
          ],
          runs: [
            {
              blockId: "list",
              inlineId: "todo",
              listItemChecked: false,
              listItemIndex: 0,
              renderedText: "todo",
              renderedTextUtf16: [0, 4],
              semantic: "list-item",
              sourceSpanByte: [0, 10],
              sourceSpanUtf16: [0, 10],
            },
            {
              blockId: "list",
              inlineId: "regular",
              listItemIndex: 1,
              renderedText: "regular",
              renderedTextUtf16: [0, 7],
              semantic: "list-item",
              sourceSpanByte: [11, 20],
              sourceSpanUtf16: [11, 20],
            },
          ],
        })}
      />,
    );

    const list = screen.getByRole("list");
    expect(list).toHaveClass("list-disc");
    expect(list).not.toHaveClass("list-none");
    expect(screen.getByRole("checkbox", { name: "Incomplete task" })).not.toBeChecked();
    expect(screen.getByText("regular")).toBeInTheDocument();
  });

  it("renders projected tables as host table elements", () => {
    render(
      <ProjectedMarkdownView
        plan={plan({
          blocks: [
            {
              blockId: "table",
              blockIndex: 0,
              element: "div",
              kind: "table",
              measurement: { estimatedHeight: 96, confidence: "high", width: 720 },
              sourceSpanByte: [0, 48],
              sourceSpanUtf16: [0, 48],
              syntaxSpans: [],
              text: "metric value\nrows 128",
            },
          ],
          runs: [
            {
              blockId: "table",
              inlineId: "h0",
              listItemIndex: null,
              renderedText: "metric",
              renderedTextUtf16: [0, 6],
              semantic: "table-cell",
              sourceSpanByte: [2, 8],
              sourceSpanUtf16: [2, 8],
              tableCellHeader: true,
              tableCellIndex: 0,
              tableRowIndex: 0,
            },
            {
              blockId: "table",
              inlineId: "h1",
              listItemIndex: null,
              renderedText: "value",
              renderedTextUtf16: [7, 12],
              semantic: "table-cell",
              sourceSpanByte: [11, 16],
              sourceSpanUtf16: [11, 16],
              tableCellAlign: "right",
              tableCellHeader: true,
              tableCellIndex: 1,
              tableRowIndex: 0,
            },
            {
              blockId: "table",
              inlineId: "r0",
              listItemIndex: null,
              renderedText: "rows",
              renderedTextUtf16: [13, 17],
              semantic: "table-cell",
              sourceSpanByte: [32, 36],
              sourceSpanUtf16: [32, 36],
              tableCellHeader: false,
              tableCellIndex: 0,
              tableRowIndex: 1,
            },
            {
              blockId: "table",
              inlineId: "r1",
              listItemIndex: null,
              renderedText: "128",
              renderedTextUtf16: [18, 21],
              semantic: "table-cell",
              sourceSpanByte: [39, 42],
              sourceSpanUtf16: [39, 42],
              tableCellAlign: "right",
              tableCellHeader: false,
              tableCellIndex: 1,
              tableRowIndex: 1,
            },
          ],
        })}
      />,
    );

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "metric" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "128" })).toHaveStyle({ textAlign: "right" });
    expect(screen.getByRole("table").parentElement).toHaveClass("rounded-md");
    expect(document.querySelector("pre")).toBeNull();
  });

  it("renders inline code with the document code chip styling", () => {
    render(
      <ProjectedMarkdownView
        plan={plan({
          blocks: [
            {
              blockId: "p0",
              blockIndex: 0,
              element: "p",
              kind: "paragraph",
              measurement: { estimatedHeight: 32, confidence: "high", width: 720 },
              sourceSpanByte: [0, 20],
              sourceSpanUtf16: [0, 20],
              syntaxSpans: [],
              text: "Use value here",
            },
          ],
          runs: [
            {
              blockId: "p0",
              inlineId: "text",
              listItemIndex: null,
              renderedText: "Use ",
              renderedTextUtf16: [0, 4],
              semantic: "text",
              sourceSpanByte: [0, 4],
              sourceSpanUtf16: [0, 4],
            },
            {
              blockId: "p0",
              inlineId: "code",
              listItemIndex: null,
              renderedText: "value",
              renderedTextUtf16: [4, 9],
              semantic: "inline-code",
              sourceSpanByte: [5, 12],
              sourceSpanUtf16: [5, 12],
            },
          ],
        })}
      />,
    );

    expect(screen.getByText("value").tagName).toBe("CODE");
    expect(screen.getByText("value")).toHaveClass("bg-muted/75", "font-mono");
  });

  it("keeps projected code block copy controls reachable without hover", () => {
    render(
      <ProjectedMarkdownView
        plan={plan({
          blocks: [
            {
              blockId: "code",
              blockIndex: 0,
              element: "pre",
              kind: "code",
              measurement: { estimatedHeight: 72, confidence: "high", width: 720 },
              sourceSpanByte: [0, 20],
              sourceSpanUtf16: [0, 20],
              syntaxSpans: [],
              text: "print('hi')",
            },
          ],
        })}
      />,
    );

    expect(screen.getByRole("button", { name: "Copy code" })).toHaveClass(
      "focus-visible:opacity-100",
    );
  });

  it("passes projected code fence language to the static highlighter", () => {
    render(
      <ProjectedMarkdownView
        plan={plan({
          blocks: [
            {
              blockId: "code",
              blockIndex: 0,
              codeLanguage: "python",
              codeMeta: "editable",
              element: "pre",
              kind: "code",
              measurement: { estimatedHeight: 72, confidence: "high", width: 720 },
              sourceSpanByte: [0, 36],
              sourceSpanUtf16: [0, 36],
              syntaxSpans: [],
              text: "from datasets import load_dataset",
            },
          ],
        })}
      />,
    );

    expect(screen.getByText("datasets")).toBeInTheDocument();
    expect(document.querySelector("pre code span")).not.toBeNull();
  });

  it("renders safe projected inline HTML as document markup", () => {
    render(
      <ProjectedMarkdownView
        plan={plan({
          blocks: [
            {
              blockId: "p0",
              blockIndex: 0,
              element: "p",
              kind: "paragraph",
              measurement: { estimatedHeight: 32, confidence: "high", width: 720 },
              sourceSpanByte: [0, 42],
              sourceSpanUtf16: [0, 42],
              syntaxSpans: [],
              text: "Press K and note",
            },
          ],
          runs: [
            {
              blockId: "p0",
              inlineId: "kbd",
              listItemIndex: null,
              renderedHtml: '<kbd title="shortcut">K</kbd>',
              renderedText: "K",
              renderedTextUtf16: [0, 1],
              semantic: "html-fragment",
              sourceSpanByte: [0, 31],
              sourceSpanUtf16: [0, 31],
            },
            {
              blockId: "p0",
              inlineId: "text",
              listItemIndex: null,
              renderedText: " and note",
              renderedTextUtf16: [1, 10],
              semantic: "text",
              sourceSpanByte: [32, 42],
              sourceSpanUtf16: [32, 42],
            },
          ],
        })}
      />,
    );

    const shortcut = screen.getByText("K");
    expect(shortcut.tagName).toBe("KBD");
    expect(shortcut).toHaveAttribute("title", "shortcut");
  });

  it("falls back to text for unsafe projected inline HTML", () => {
    render(
      <ProjectedMarkdownView
        plan={plan({
          blocks: [
            {
              blockId: "p0",
              blockIndex: 0,
              element: "p",
              kind: "paragraph",
              measurement: { estimatedHeight: 32, confidence: "high", width: 720 },
              sourceSpanByte: [0, 28],
              sourceSpanUtf16: [0, 28],
              syntaxSpans: [],
              text: "unsafe",
            },
          ],
          runs: [
            {
              blockId: "p0",
              inlineId: "unsafe",
              listItemIndex: null,
              renderedHtml: '<span onclick="alert(1)">unsafe</span>',
              renderedText: "unsafe",
              renderedTextUtf16: [0, 6],
              semantic: "html-fragment",
              sourceSpanByte: [0, 28],
              sourceSpanUtf16: [0, 28],
            },
          ],
        })}
      />,
    );

    expect(screen.getByText("unsafe")).toBeInTheDocument();
    expect(document.querySelector("[onclick]")).toBeNull();
  });

  it("renders projected images in the host document", () => {
    render(
      <ProjectedMarkdownView
        plan={plan({
          blocks: [
            {
              blockId: "image",
              blockIndex: 0,
              element: "p",
              kind: "paragraph",
              measurement: { estimatedHeight: 120, confidence: "low", width: 720 },
              sourceSpanByte: [0, 42],
              sourceSpanUtf16: [0, 42],
              syntaxSpans: [],
              text: "Plot alt",
            },
          ],
          runs: [
            {
              blockId: "image",
              imageAlt: "Plot alt",
              imageSrc: "attachment:plot.png",
              imageTitle: "Daily plot",
              inlineId: "img0",
              listItemIndex: null,
              renderedText: "Plot alt",
              renderedTextUtf16: [0, 8],
              semantic: "image",
              sourceSpanByte: [0, 42],
              sourceSpanUtf16: [0, 42],
            },
          ],
        })}
      />,
    );

    const image = screen.getByRole("img", { name: "Plot alt" });
    expect(image).toHaveAttribute("src", "attachment:plot.png");
    expect(image).toHaveAttribute("title", "Daily plot");
  });

  it("does not render projected images with unsafe sources", () => {
    render(
      <ProjectedMarkdownView
        plan={plan({
          blocks: [
            {
              blockId: "image",
              blockIndex: 0,
              element: "p",
              kind: "paragraph",
              measurement: { estimatedHeight: 32, confidence: "high", width: 720 },
              sourceSpanByte: [0, 32],
              sourceSpanUtf16: [0, 32],
              syntaxSpans: [],
              text: "Bad image",
            },
          ],
          runs: [
            {
              blockId: "image",
              imageAlt: "Bad image",
              imageSrc: "javascript:alert(1)",
              inlineId: "img0",
              listItemIndex: null,
              renderedText: "Bad image",
              renderedTextUtf16: [0, 9],
              semantic: "image",
              sourceSpanByte: [0, 32],
              sourceSpanUtf16: [0, 32],
            },
          ],
        })}
      />,
    );

    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("Bad image")).toBeInTheDocument();
  });
});

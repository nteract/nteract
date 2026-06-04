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
              inlineId: "em",
              listItemIndex: 1,
              renderedText: "important",
              renderedTextUtf16: [0, 9],
              semantic: "emphasis",
              sourceSpanByte: [11, 22],
              sourceSpanUtf16: [11, 22],
            },
            {
              blockId: "list",
              inlineId: "del",
              listItemIndex: 2,
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
    expect(screen.getByText("important").tagName).toBe("EM");
    expect(screen.getByText("removed").tagName).toBe("DEL");
  });
});

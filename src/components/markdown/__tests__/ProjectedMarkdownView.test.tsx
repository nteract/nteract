import { fireEvent, render, screen } from "@testing-library/react";
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
    anchors: [],
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

  it("marks rendered runs with source spans for comment anchors", () => {
    const { container } = render(
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
              text: "alpha beta",
            },
          ],
          runs: [
            {
              blockId: "p0",
              inlineId: "r0",
              listItemIndex: null,
              renderedText: "alpha",
              renderedTextUtf16: [0, 5],
              semantic: "text",
              sourceSpanByte: [0, 5],
              sourceSpanUtf16: [0, 5],
            },
          ],
        })}
      />,
    );

    const run = container.querySelector("[data-markdown-source-run='true']");
    expect(run).not.toBeNull();
    expect(run).toHaveAttribute("data-rendered-start", "0");
    expect(run).toHaveAttribute("data-rendered-end", "5");
    expect(run).toHaveAttribute("data-source-start", "0");
    expect(run).toHaveAttribute("data-source-end", "5");
  });

  it("renders open and resolved comment highlights for overlapping source ranges", () => {
    const { container } = render(
      <ProjectedMarkdownView
        commentHighlights={[
          { from: 0, to: 20, threadId: "thread-open", color: "#d97706", resolved: false },
          { from: 6, to: 10, threadId: "thread-resolved", color: "#52525b", resolved: true },
        ]}
        plan={plan({
          blocks: [
            {
              blockId: "p0",
              blockIndex: 0,
              element: "p",
              kind: "paragraph",
              measurement: { estimatedHeight: 32, confidence: "high", width: 720 },
              sourceSpanByte: [0, 10],
              sourceSpanUtf16: [0, 10],
              syntaxSpans: [],
              text: "alpha beta",
            },
          ],
          runs: [
            {
              blockId: "p0",
              inlineId: "r0",
              listItemIndex: null,
              renderedText: "alpha",
              renderedTextUtf16: [0, 5],
              semantic: "text",
              sourceSpanByte: [0, 5],
              sourceSpanUtf16: [0, 5],
            },
            {
              blockId: "p0",
              inlineId: "r1",
              listItemIndex: null,
              renderedText: "beta",
              renderedTextUtf16: [6, 10],
              semantic: "text",
              sourceSpanByte: [6, 10],
              sourceSpanUtf16: [6, 10],
            },
          ],
        })}
      />,
    );

    const runs = container.querySelectorAll<HTMLElement>("[data-markdown-source-run='true']");
    const highlights = container.querySelectorAll<HTMLElement>(".comment-highlight");
    expect(highlights).toHaveLength(2);
    expect(runs[0]).not.toHaveClass("comment-highlight");
    expect(runs[0]).not.toHaveClass("comment-highlight-resolved");
    expect(highlights[0]).toHaveTextContent("alpha");
    expect(highlights[0]).not.toHaveClass("comment-highlight-resolved");
    expect(highlights[0]?.style.getPropertyValue("--cm-comment-color")).toBe("#d97706");
    expect(runs[1]).not.toHaveClass("comment-highlight");
    expect(runs[1]).not.toHaveClass("comment-highlight-resolved");
    expect(highlights[1]).toHaveTextContent("beta");
    expect(highlights[1]).toHaveClass("comment-highlight-resolved");
    expect(highlights[1]?.style.getPropertyValue("--cm-comment-color")).toBe("#52525b");
  });

  it("activates rendered comment highlights on click", () => {
    const onActivateCommentThread = vi.fn();
    const onOuterClick = vi.fn();
    const { container } = render(
      <div onClick={onOuterClick}>
        <ProjectedMarkdownView
          onActivateCommentThread={onActivateCommentThread}
          commentHighlights={[
            { from: 0, to: 5, threadId: "thread-alpha", color: "#d97706", resolved: false },
          ]}
          plan={plan({
            blocks: [
              {
                blockId: "p0",
                blockIndex: 0,
                element: "p",
                kind: "paragraph",
                measurement: { estimatedHeight: 32, confidence: "high", width: 720 },
                sourceSpanByte: [0, 10],
                sourceSpanUtf16: [0, 10],
                syntaxSpans: [],
                text: "alpha beta",
              },
            ],
            runs: [
              {
                blockId: "p0",
                inlineId: "r0",
                listItemIndex: null,
                renderedText: "alpha beta",
                renderedTextUtf16: [0, 10],
                semantic: "text",
                sourceSpanByte: [0, 10],
                sourceSpanUtf16: [0, 10],
              },
            ],
          })}
        />
      </div>,
    );

    const highlighted = container.querySelector<HTMLElement>(".comment-highlight");
    expect(highlighted).not.toBeNull();

    fireEvent.click(highlighted!);

    expect(onActivateCommentThread).toHaveBeenCalledTimes(1);
    expect(onActivateCommentThread).toHaveBeenCalledWith("thread-alpha");
    expect(onOuterClick).not.toHaveBeenCalled();
  });

  it("activates rendered comment highlights with Enter", () => {
    const onActivateCommentThread = vi.fn();
    render(
      <ProjectedMarkdownView
        onActivateCommentThread={onActivateCommentThread}
        commentHighlights={[
          { from: 0, to: 5, threadId: "thread-alpha", color: "#d97706", resolved: false },
        ]}
        plan={plan({
          blocks: [
            {
              blockId: "p0",
              blockIndex: 0,
              element: "p",
              kind: "paragraph",
              measurement: { estimatedHeight: 32, confidence: "high", width: 720 },
              sourceSpanByte: [0, 10],
              sourceSpanUtf16: [0, 10],
              syntaxSpans: [],
              text: "alpha beta",
            },
          ],
          runs: [
            {
              blockId: "p0",
              inlineId: "r0",
              listItemIndex: null,
              renderedText: "alpha beta",
              renderedTextUtf16: [0, 10],
              semantic: "text",
              sourceSpanByte: [0, 10],
              sourceSpanUtf16: [0, 10],
            },
          ],
        })}
      />,
    );

    fireEvent.keyDown(screen.getByRole("button", { name: "Open comment thread" }), {
      key: "Enter",
    });

    expect(onActivateCommentThread).toHaveBeenCalledTimes(1);
    expect(onActivateCommentThread).toHaveBeenCalledWith("thread-alpha");
  });

  it("wraps only the selected characters for partial paragraph highlights", () => {
    const source = "This is some markdown text it is good";
    const selected = "some markdown";
    const { container } = render(
      <ProjectedMarkdownView
        commentHighlights={[
          { from: 8, to: 21, threadId: "thread-partial", color: "#d97706", resolved: false },
        ]}
        plan={plan({
          blocks: [
            {
              blockId: "p0",
              blockIndex: 0,
              element: "p",
              kind: "paragraph",
              measurement: { estimatedHeight: 32, confidence: "high", width: 720 },
              sourceSpanByte: [0, source.length],
              sourceSpanUtf16: [0, source.length],
              syntaxSpans: [],
              text: source,
            },
          ],
          runs: [
            {
              blockId: "p0",
              inlineId: "r0",
              listItemIndex: null,
              renderedText: source,
              renderedTextUtf16: [0, source.length],
              semantic: "text",
              sourceSpanByte: [0, source.length],
              sourceSpanUtf16: [0, source.length],
            },
          ],
        })}
      />,
    );

    const paragraph = container.querySelector("p");
    const highlighted = container.querySelector<HTMLElement>(".comment-highlight");
    const run = container.querySelector<HTMLElement>("[data-markdown-source-run='true']");
    expect(paragraph).toHaveTextContent(source);
    expect(highlighted?.textContent).toBe(selected);
    expect(highlighted).not.toHaveTextContent("This is");
    expect(highlighted).not.toHaveTextContent("text it is good");
    expect(run).not.toHaveClass("comment-highlight");
  });

  it("renders two non-overlapping highlights in one transparent run", () => {
    const source = "alpha beta gamma";
    const { container } = render(
      <ProjectedMarkdownView
        commentHighlights={[
          { from: 0, to: 5, threadId: "thread-alpha", color: "#d97706", resolved: false },
          {
            from: 11,
            to: 16,
            threadId: "thread-gamma",
            color: "#2563eb",
            resolved: false,
            pending: true,
          },
        ]}
        plan={plan({
          blocks: [
            {
              blockId: "p0",
              blockIndex: 0,
              element: "p",
              kind: "paragraph",
              measurement: { estimatedHeight: 32, confidence: "high", width: 720 },
              sourceSpanByte: [0, source.length],
              sourceSpanUtf16: [0, source.length],
              syntaxSpans: [],
              text: source,
            },
          ],
          runs: [
            {
              blockId: "p0",
              inlineId: "r0",
              listItemIndex: null,
              renderedText: source,
              renderedTextUtf16: [0, source.length],
              semantic: "text",
              sourceSpanByte: [0, source.length],
              sourceSpanUtf16: [0, source.length],
            },
          ],
        })}
      />,
    );

    const run = container.querySelector<HTMLElement>("[data-markdown-source-run='true']");
    const highlights = Array.from(container.querySelectorAll<HTMLElement>(".comment-highlight"));
    const plainText = Array.from(run?.childNodes ?? [])
      .filter((node) => node.nodeType === 3)
      .map((node) => node.textContent)
      .join("");

    expect(highlights).toHaveLength(2);
    expect(highlights.map((highlight) => highlight.textContent)).toEqual(["alpha", "gamma"]);
    expect(plainText).toBe(" beta ");
    expect(highlights[0]).not.toHaveTextContent("beta");
    expect(highlights[1]).not.toHaveTextContent("beta");
    expect(highlights[1]).toHaveClass("comment-highlight-pending");
    expect(run).not.toHaveClass("comment-highlight");
  });

  it("uses the narrower highlight for overlapping segments in one transparent run", () => {
    const source = "alpha beta gamma";
    const onActivateCommentThread = vi.fn();
    const { container } = render(
      <ProjectedMarkdownView
        onActivateCommentThread={onActivateCommentThread}
        commentHighlights={[
          { from: 0, to: 16, threadId: "thread-wide", color: "#d97706", resolved: false },
          { from: 6, to: 10, threadId: "thread-beta", color: "#2563eb", resolved: false },
        ]}
        plan={plan({
          blocks: [
            {
              blockId: "p0",
              blockIndex: 0,
              element: "p",
              kind: "paragraph",
              measurement: { estimatedHeight: 32, confidence: "high", width: 720 },
              sourceSpanByte: [0, source.length],
              sourceSpanUtf16: [0, source.length],
              syntaxSpans: [],
              text: source,
            },
          ],
          runs: [
            {
              blockId: "p0",
              inlineId: "r0",
              listItemIndex: null,
              renderedText: source,
              renderedTextUtf16: [0, source.length],
              semantic: "text",
              sourceSpanByte: [0, source.length],
              sourceSpanUtf16: [0, source.length],
            },
          ],
        })}
      />,
    );

    const highlights = Array.from(container.querySelectorAll<HTMLElement>(".comment-highlight"));
    const betaHighlight = highlights.find((highlight) => highlight.textContent === "beta");

    expect(highlights).toHaveLength(3);
    expect(highlights.map((highlight) => highlight.textContent).join("")).toBe(source);
    expect(highlights[0]?.textContent).toBe("alpha ");
    expect(highlights[0]?.style.getPropertyValue("--cm-comment-color")).toBe("#d97706");
    expect(betaHighlight).not.toBeUndefined();
    expect(betaHighlight?.style.getPropertyValue("--cm-comment-color")).toBe("#2563eb");
    expect(highlights[2]?.textContent).toBe(" gamma");
    expect(highlights[2]?.style.getPropertyValue("--cm-comment-color")).toBe("#d97706");

    fireEvent.click(betaHighlight!);

    expect(onActivateCommentThread).toHaveBeenCalledTimes(1);
    expect(onActivateCommentThread).toHaveBeenCalledWith("thread-beta");
  });

  it("highlights transparent strong run characters without ballooning to siblings", () => {
    const { container } = render(
      <ProjectedMarkdownView
        commentHighlights={[
          { from: 8, to: 12, threadId: "thread-strong", color: "#d97706", resolved: false },
        ]}
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
              text: "alpha bold omega",
            },
          ],
          runs: [
            {
              blockId: "p0",
              inlineId: "before",
              listItemIndex: null,
              renderedText: "alpha ",
              renderedTextUtf16: [0, 6],
              semantic: "text",
              sourceSpanByte: [0, 6],
              sourceSpanUtf16: [0, 6],
            },
            {
              blockId: "p0",
              inlineId: "strong",
              listItemIndex: null,
              renderedText: "bold",
              renderedTextUtf16: [6, 10],
              semantic: "strong",
              sourceSpanByte: [8, 12],
              sourceSpanUtf16: [8, 12],
            },
            {
              blockId: "p0",
              inlineId: "after",
              listItemIndex: null,
              renderedText: " omega",
              renderedTextUtf16: [10, 16],
              semantic: "text",
              sourceSpanByte: [14, 20],
              sourceSpanUtf16: [14, 20],
            },
          ],
        })}
      />,
    );

    const paragraph = container.querySelector("p");
    const highlighted = container.querySelector<HTMLElement>(".comment-highlight");
    expect(paragraph).toHaveTextContent("alpha bold omega");
    expect(highlighted?.textContent).toBe("bold");
    expect(highlighted?.querySelector("strong")).toHaveTextContent("bold");
    expect(highlighted).not.toHaveTextContent("alpha");
    expect(highlighted).not.toHaveTextContent("omega");
    expect(container.querySelector("[data-source-start='0'] .comment-highlight")).toBeNull();
    expect(container.querySelector("[data-source-start='14'] .comment-highlight")).toBeNull();
  });

  it("keeps opaque image highlights scoped to the image run", () => {
    const source = "before ![Plot alt](attachment:plot.png) after";
    const { container } = render(
      <ProjectedMarkdownView
        commentHighlights={[
          { from: 10, to: 20, threadId: "thread-image", color: "#d97706", resolved: false },
        ]}
        plan={plan({
          blocks: [
            {
              blockId: "p0",
              blockIndex: 0,
              element: "p",
              kind: "paragraph",
              measurement: { estimatedHeight: 32, confidence: "high", width: 720 },
              sourceSpanByte: [0, source.length],
              sourceSpanUtf16: [0, source.length],
              syntaxSpans: [],
              text: "before  after",
            },
          ],
          runs: [
            {
              blockId: "p0",
              inlineId: "before",
              listItemIndex: null,
              renderedText: "before ",
              renderedTextUtf16: [0, 7],
              semantic: "text",
              sourceSpanByte: [0, 7],
              sourceSpanUtf16: [0, 7],
            },
            {
              blockId: "p0",
              imageAlt: "Plot alt",
              imageSrc: "attachment:plot.png",
              inlineId: "image",
              listItemIndex: null,
              renderedText: "Plot alt",
              renderedTextUtf16: [7, 15],
              semantic: "image",
              sourceSpanByte: [7, 39],
              sourceSpanUtf16: [7, 39],
            },
            {
              blockId: "p0",
              inlineId: "after",
              listItemIndex: null,
              renderedText: " after",
              renderedTextUtf16: [15, 21],
              semantic: "text",
              sourceSpanByte: [39, 45],
              sourceSpanUtf16: [39, 45],
            },
          ],
        })}
      />,
    );

    const image = screen.getByRole("img", { name: "Plot alt" });
    const highlighted = image.closest<HTMLElement>(".comment-highlight");
    const imageRun = highlighted?.parentElement;
    expect(container.querySelectorAll(".comment-highlight")).toHaveLength(1);
    expect(highlighted).not.toBeNull();
    expect(highlighted?.textContent).toBe("");
    expect(imageRun).toHaveAttribute("data-markdown-source-run", "true");
    expect(imageRun).toHaveAttribute("data-source-start", "7");
    expect(imageRun).toHaveAttribute("data-source-end", "39");
    expect(imageRun).not.toHaveClass("comment-highlight");
  });

  it("renders runs without highlights without inserting highlight wrappers", () => {
    const { container } = render(
      <ProjectedMarkdownView
        plan={plan({
          blocks: [
            {
              blockId: "p0",
              blockIndex: 0,
              element: "p",
              kind: "paragraph",
              measurement: { estimatedHeight: 32, confidence: "high", width: 720 },
              sourceSpanByte: [0, 10],
              sourceSpanUtf16: [0, 10],
              syntaxSpans: [],
              text: "alpha beta",
            },
          ],
          runs: [
            {
              blockId: "p0",
              inlineId: "r0",
              listItemIndex: null,
              renderedText: "alpha beta",
              renderedTextUtf16: [0, 10],
              semantic: "text",
              sourceSpanByte: [0, 10],
              sourceSpanUtf16: [0, 10],
            },
          ],
        })}
      />,
    );

    const run = container.querySelector<HTMLElement>("[data-markdown-source-run='true']");
    expect(container.querySelector(".comment-highlight")).toBeNull();
    expect(run).toHaveTextContent("alpha beta");
    expect(run?.children).toHaveLength(0);
  });

  it("matches the output document heading rhythm", () => {
    const { container } = render(
      <ProjectedMarkdownView
        plan={plan({
          blocks: [
            {
              blockId: "h1",
              blockIndex: 0,
              element: "h1",
              kind: "heading",
              measurement: { estimatedHeight: 48, confidence: "high", width: 720 },
              sourceSpanByte: [0, 7],
              sourceSpanUtf16: [0, 7],
              syntaxSpans: [],
              text: "Heading",
            },
            {
              blockId: "h2",
              blockIndex: 1,
              element: "h2",
              kind: "heading",
              measurement: { estimatedHeight: 40, confidence: "high", width: 720 },
              sourceSpanByte: [9, 20],
              sourceSpanUtf16: [9, 20],
              syntaxSpans: [],
              text: "Subheading",
            },
            {
              blockId: "h3",
              blockIndex: 2,
              element: "h3",
              kind: "heading",
              measurement: { estimatedHeight: 36, confidence: "high", width: 720 },
              sourceSpanByte: [22, 28],
              sourceSpanUtf16: [22, 28],
              syntaxSpans: [],
              text: "Minor",
            },
            {
              blockId: "h4",
              blockIndex: 3,
              element: "h4",
              kind: "heading",
              measurement: { estimatedHeight: 32, confidence: "high", width: 720 },
              sourceSpanByte: [30, 36],
              sourceSpanUtf16: [30, 36],
              syntaxSpans: [],
              text: "Small",
            },
          ],
        })}
      />,
    );

    expect(container.querySelector('[data-slot="projected-markdown-output"]')).toHaveClass(
      "leading-[1.68]",
      "[&>*:first-child]:mt-0",
      "[&>*:last-child]:mb-0",
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveClass("text-[2rem]", "font-semibold");
    expect(screen.getByRole("heading", { level: 2 })).toHaveClass("text-2xl", "font-semibold");
    expect(screen.getByRole("heading", { level: 2 })).not.toHaveClass("after:bg-primary/50");
    expect(screen.getByRole("heading", { level: 3 })).toHaveClass("text-xl", "font-semibold");
    expect(screen.getByRole("heading", { level: 4 })).toHaveClass("text-lg", "font-semibold");
  });

  it("renders heading anchors when outline metadata is available", () => {
    render(
      <ProjectedMarkdownView
        headingAnchors={[
          {
            itemId: "cell-a:heading:0",
            title: "Claim",
            level: 2,
            anchor: "claim",
            headingAnchorId: "notebook-cell-cell-a-heading-claim",
          },
        ]}
        plan={plan({
          blocks: [
            {
              anchorSlug: "claim",
              blockId: "claim",
              blockIndex: 0,
              element: "h2",
              kind: "heading",
              measurement: { estimatedHeight: 40, confidence: "high", width: 720 },
              sourceSpanByte: [0, 8],
              sourceSpanUtf16: [0, 8],
              syntaxSpans: [],
              text: "Claim",
            },
          ],
          runs: [
            {
              blockId: "claim",
              inlineId: "claim-text",
              listItemIndex: null,
              renderedText: "Claim",
              renderedTextUtf16: [0, 5],
              semantic: "text",
              sourceSpanByte: [0, 5],
              sourceSpanUtf16: [0, 5],
            },
          ],
        })}
      />,
    );

    const heading = screen.getByRole("heading", { level: 2 });
    const anchor = screen.getByRole("link", { name: "Link to Claim" });
    expect(heading).toHaveAttribute("id", "notebook-cell-cell-a-heading-claim");
    expect(anchor).toHaveAttribute("href", "#notebook-cell-cell-a-heading-claim");
    expect(anchor).toHaveClass("text-muted-foreground/40", "hover:text-primary");
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
    expect(document.querySelector(".katex-display")?.parentElement).toHaveClass(
      "my-5",
      "text-center",
      "overflow-x-clip",
    );
    expect(document.querySelector(".katex-display")?.parentElement).not.toHaveClass(
      "overflow-x-auto",
      "overflow-x-hidden",
    );
    expect(document.querySelector(".katex-display")?.parentElement).not.toHaveClass(
      "border-y",
      "bg-muted/[0.16]",
    );
    expect(document.querySelector(".katex-display")?.parentElement).toHaveAttribute(
      "data-display-mode",
      "true",
    );
    expect(document.querySelector(".katex-display")?.parentElement?.tagName).toBe("DIV");
  });

  it("uses the document rhythm for paragraphs, lists, and quotes", () => {
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
              text: "First paragraph",
            },
            {
              blockId: "list",
              blockIndex: 1,
              element: "ul",
              kind: "list",
              measurement: { estimatedHeight: 48, confidence: "high", width: 720 },
              sourceSpanByte: [18, 36],
              sourceSpanUtf16: [18, 36],
              syntaxSpans: [],
              text: "item",
            },
            {
              blockId: "quote",
              blockIndex: 2,
              element: "blockquote",
              kind: "blockquote",
              measurement: { estimatedHeight: 32, confidence: "high", width: 720 },
              sourceSpanByte: [38, 48],
              sourceSpanUtf16: [38, 48],
              syntaxSpans: [],
              text: "quoted",
            },
          ],
          runs: [
            {
              blockId: "p0",
              inlineId: "p0-text",
              listItemIndex: null,
              renderedText: "First paragraph",
              renderedTextUtf16: [0, 15],
              semantic: "text",
              sourceSpanByte: [0, 15],
              sourceSpanUtf16: [0, 15],
            },
            {
              blockId: "list",
              inlineId: "list-item",
              listItemIndex: 0,
              renderedText: "item",
              renderedTextUtf16: [0, 4],
              semantic: "list-item",
              sourceSpanByte: [20, 24],
              sourceSpanUtf16: [20, 24],
            },
            {
              blockId: "quote",
              inlineId: "quote-text",
              listItemIndex: null,
              renderedText: "quoted",
              renderedTextUtf16: [0, 6],
              semantic: "text",
              sourceSpanByte: [40, 46],
              sourceSpanUtf16: [40, 46],
            },
          ],
        })}
      />,
    );

    expect(screen.getByText("First paragraph").closest("p")).toHaveClass("my-3", "leading-relaxed");
    expect(screen.getByRole("list")).toHaveClass("my-3", "ml-6", "list-disc");
    expect(screen.getByText("quoted").closest("blockquote")).toHaveClass(
      "border-l-2",
      "border-foreground/35",
      "text-foreground/80",
    );
    expect(screen.getByText("quoted").closest("blockquote")).not.toHaveClass("bg-muted/[0.20]");
  });

  it("renders links with visible affordance before hover", () => {
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
              sourceSpanByte: [0, 24],
              sourceSpanUtf16: [0, 24],
              syntaxSpans: [],
              text: "Read the paper",
            },
          ],
          runs: [
            {
              blockId: "p0",
              href: "https://example.com/paper",
              inlineId: "link",
              listItemIndex: null,
              renderedText: "paper",
              renderedTextUtf16: [0, 5],
              semantic: "text",
              sourceSpanByte: [9, 14],
              sourceSpanUtf16: [9, 14],
            },
          ],
        })}
      />,
    );

    expect(screen.getByRole("link", { name: "paper" })).toHaveClass(
      "underline",
      "decoration-primary/45",
      "underline-offset-4",
    );
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

    expect(screen.getByRole("checkbox", { name: "Completed task: done" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Incomplete task: todo" })).not.toBeChecked();
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    expect(
      document.querySelectorAll('[data-slot="projected-markdown-task-checkbox"]'),
    ).toHaveLength(2);
    expect(
      document.querySelector('[data-slot="projected-markdown-task-checkbox"] span'),
    ).toHaveClass("bg-primary");
    expect(screen.getByText("important").tagName).toBe("EM");
    expect(screen.getByText("important")).toHaveClass("text-foreground");
    expect(screen.getByText("important")).not.toHaveClass("text-muted-foreground");
    expect(screen.getByText("removed").tagName).toBe("DEL");
    expect(screen.getByText("removed")).toHaveClass("decoration-destructive/55");
  });

  it("lets editable projections toggle task markers without changing output semantics", () => {
    const onTaskCheckedChange = vi.fn();
    const taskRun = {
      blockId: "list",
      inlineId: "todo",
      listItemChecked: false,
      listItemIndex: 0,
      renderedText: "todo",
      renderedTextUtf16: [0, 4] as [number, number],
      semantic: "list-item" as const,
      sourceSpanByte: [0, 10] as [number, number],
      sourceSpanUtf16: [0, 10] as [number, number],
    };

    render(
      <ProjectedMarkdownView
        onTaskCheckedChange={onTaskCheckedChange}
        plan={plan({
          blocks: [
            {
              blockId: "list",
              blockIndex: 0,
              element: "ul",
              kind: "list",
              measurement: { estimatedHeight: 24, confidence: "high", width: 720 },
              sourceSpanByte: [0, 10],
              sourceSpanUtf16: [0, 10],
              syntaxSpans: [],
              text: "todo",
            },
          ],
          runs: [taskRun],
        })}
      />,
    );

    const toggle = screen.getByRole("checkbox", { name: "Mark task complete: todo" });
    expect(toggle).not.toBeChecked();
    expect(toggle).not.toBeDisabled();

    fireEvent.click(toggle);

    expect(onTaskCheckedChange).toHaveBeenCalledWith(taskRun, true);
  });

  it("lets the visible task checkbox glyph toggle the marker", () => {
    const onTaskCheckedChange = vi.fn();
    const taskRun = {
      blockId: "list",
      inlineId: "todo",
      listItemChecked: false,
      listItemIndex: 0,
      renderedText: "todo",
      renderedTextUtf16: [0, 4] as [number, number],
      semantic: "list-item" as const,
      sourceSpanByte: [0, 10] as [number, number],
      sourceSpanUtf16: [0, 10] as [number, number],
    };

    render(
      <ProjectedMarkdownView
        onTaskCheckedChange={onTaskCheckedChange}
        plan={plan({
          blocks: [
            {
              blockId: "list",
              blockIndex: 0,
              element: "ul",
              kind: "list",
              measurement: { estimatedHeight: 24, confidence: "high", width: 720 },
              sourceSpanByte: [0, 10],
              sourceSpanUtf16: [0, 10],
              syntaxSpans: [],
              text: "todo",
            },
          ],
          runs: [taskRun],
        })}
      />,
    );

    const visualGlyph = document.querySelector(
      '[data-slot="projected-markdown-task-checkbox"] span',
    );
    expect(visualGlyph).not.toBeNull();
    expect(visualGlyph).toHaveClass("pointer-events-none");

    fireEvent.click(visualGlyph!);

    expect(onTaskCheckedChange).toHaveBeenCalledWith(taskRun, true);
  });

  it("frames all-task projected lists as lab protocols", () => {
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
              sourceSpanByte: [0, 24],
              sourceSpanUtf16: [0, 24],
              syntaxSpans: [],
              text: "done waiting",
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
              inlineId: "waiting",
              listItemChecked: false,
              listItemIndex: 1,
              renderedText: "waiting",
              renderedTextUtf16: [0, 7],
              semantic: "list-item",
              sourceSpanByte: [11, 24],
              sourceSpanUtf16: [11, 24],
            },
          ],
        })}
      />,
    );

    expect(screen.getByRole("list")).toHaveClass("rounded-md", "border", "p-2");
    expect(screen.getByRole("list")).not.toHaveClass("list-disc");
    expect(screen.getByText("waiting").closest("li")).toHaveClass(
      "grid",
      "grid-cols-[auto_minmax(0,1fr)]",
    );
    expect(
      document.querySelector('[data-slot="projected-markdown-task-checkbox"] span'),
    ).toHaveClass("size-4");
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
    expect(screen.getByRole("checkbox", { name: "Incomplete task: todo" })).not.toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "Incomplete task: todo" }).closest("li"),
    ).toHaveClass("list-none");
    expect(screen.getByText("regular").closest("li")).not.toHaveClass("list-none");
    expect(screen.getByText("regular")).toBeInTheDocument();
  });

  it("renders nested projected lists under their parent items", () => {
    render(
      <ProjectedMarkdownView
        plan={plan({
          blocks: [
            {
              blockId: "list",
              blockIndex: 0,
              element: "ul",
              kind: "list",
              measurement: { estimatedHeight: 72, confidence: "high", width: 720 },
              sourceSpanByte: [0, 48],
              sourceSpanUtf16: [0, 48],
              syntaxSpans: [],
              text: "parent child grandchild",
            },
          ],
          runs: [
            {
              blockId: "list",
              inlineId: "parent",
              listItemDepth: 0,
              listItemIndex: 0,
              listItemOrdered: false,
              listItemPath: "0",
              renderedText: "parent",
              renderedTextUtf16: [0, 6],
              semantic: "list-item",
              sourceSpanByte: [2, 8],
              sourceSpanUtf16: [2, 8],
            },
            {
              blockId: "list",
              inlineId: "child",
              listItemChecked: false,
              listItemDepth: 1,
              listItemIndex: 0,
              listItemOrdered: false,
              listItemPath: "0.0",
              renderedText: "child",
              renderedTextUtf16: [6, 11],
              semantic: "list-item",
              sourceSpanByte: [15, 20],
              sourceSpanUtf16: [15, 20],
            },
            {
              blockId: "list",
              inlineId: "grandchild",
              listItemDepth: 2,
              listItemIndex: 0,
              listItemOrdered: true,
              listItemPath: "0.0.0",
              renderedText: "grandchild",
              renderedTextUtf16: [11, 21],
              semantic: "list-item",
              sourceSpanByte: [27, 37],
              sourceSpanUtf16: [27, 37],
            },
          ],
        })}
      />,
    );

    const rootList = document.querySelector('[data-slot="projected-markdown-output"] > ul');
    const parentItem = screen.getByText("parent").closest("li");
    const childItem = screen.getByText("child").closest("li");
    const grandchildItem = screen.getByText("grandchild").closest("li");
    expect(parentItem).not.toBeNull();
    expect(childItem).not.toBeNull();
    expect(grandchildItem).not.toBeNull();
    expect(parentItem).toContainElement(childItem);
    expect(childItem).toContainElement(grandchildItem);
    expect(rootList?.tagName).toBe("UL");
    expect(grandchildItem?.parentElement?.tagName).toBe("OL");
    expect(screen.getByRole("checkbox", { name: "Incomplete task: child" })).not.toBeChecked();
  });

  it("preserves nested lists under container-only list items", () => {
    render(
      <ProjectedMarkdownView
        plan={plan({
          blocks: [
            {
              blockId: "list",
              blockIndex: 0,
              element: "ul",
              kind: "list",
              measurement: { estimatedHeight: 72, confidence: "high", width: 720 },
              sourceSpanByte: [0, 20],
              sourceSpanUtf16: [0, 20],
              syntaxSpans: [],
              text: "a nested",
            },
          ],
          runs: [
            {
              blockId: "list",
              inlineId: "a",
              listItemDepth: 0,
              listItemIndex: 0,
              listItemOrdered: false,
              listItemPath: "0",
              renderedText: "a",
              renderedTextUtf16: [0, 1],
              semantic: "list-item",
              sourceSpanByte: [2, 3],
              sourceSpanUtf16: [2, 3],
            },
            {
              blockId: "list",
              inlineId: "nested",
              listItemDepth: 2,
              listItemIndex: 0,
              listItemOrdered: false,
              listItemPath: "1.0",
              renderedText: "nested",
              renderedTextUtf16: [1, 7],
              semantic: "list-item",
              sourceSpanByte: [12, 18],
              sourceSpanUtf16: [12, 18],
            },
          ],
        })}
      />,
    );

    const firstItem = screen.getByText("a").closest("li");
    const nestedItem = screen.getByText("nested").closest("li");
    expect(firstItem).not.toContainElement(nestedItem);
    expect(nestedItem).not.toBeNull();
    expect(
      document.querySelector('[data-slot="projected-markdown-output"] > ul')?.children,
    ).toHaveLength(2);
    expect(nestedItem?.parentElement?.parentElement?.tagName).toBe("LI");
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
    expect(screen.getByRole("columnheader", { name: "value" })).toHaveStyle({
      textAlign: "right",
    });
    expect(screen.getByRole("cell", { name: "128" })).toHaveStyle({ textAlign: "right" });
    expect(screen.getByRole("table").parentElement).toHaveClass(
      "rounded-sm",
      "border",
      "shadow-sm",
    );
    expect(screen.getByRole("row", { name: "rows 128" })).toHaveClass("odd:bg-muted/[0.05]");
    expect(screen.getByRole("table").parentElement).toHaveAttribute(
      "data-slot",
      "projected-markdown-table",
    );
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
    expect(screen.getByText("value")).toHaveClass(
      "border",
      "bg-muted/70",
      "font-[var(--output-mono-font)]",
    );
  });

  it("renders projected code blocks with visible lab bench controls", () => {
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

    expect(screen.getByText("code")).toHaveClass("text-muted-foreground/80");
    expect(screen.getByText("code")).not.toHaveClass("uppercase", "tracking-[0.08em]");
    expect(screen.getByRole("button", { name: "Copy code" })).toHaveClass(
      "inline-flex",
      "border-transparent",
      "bg-transparent",
    );
    expect(screen.getByText("code").closest('[data-slot="markdown-code-block"]')).toHaveClass(
      "border-l-2",
      "bg-muted/[0.14]",
    );
    expect(screen.getByText("code").closest('[data-slot="markdown-code-block"]')).not.toHaveClass(
      "rounded-md",
      "shadow-sm",
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
    expect(screen.getByText("python")).toHaveAttribute("title", "python code block");
    expect(screen.getByText("python")).toHaveClass("text-muted-foreground/80");
    expect(screen.getByText("python")).not.toHaveClass("uppercase", "tracking-[0.08em]");
    expect(screen.getByText("python").closest("[data-code-language]")).toHaveAttribute(
      "data-code-language",
      "python",
    );
    expect(document.querySelector("pre code span")).not.toBeNull();
  });

  it("lets callers pin static code blocks to the cream highlighter palette", () => {
    render(
      <ProjectedMarkdownView
        colorTheme="cream"
        plan={plan({
          blocks: [
            {
              blockId: "code",
              blockIndex: 0,
              codeLanguage: "python",
              element: "pre",
              kind: "code",
              measurement: { estimatedHeight: 72, confidence: "high", width: 720 },
              sourceSpanByte: [0, 20],
              sourceSpanUtf16: [0, 20],
              syntaxSpans: [],
              text: "print('cream')",
            },
          ],
        })}
      />,
    );

    expect(document.querySelector("pre")).toHaveStyle({ backgroundColor: "#f0ede7" });
  });

  it("renders projected inline HTML as plain text", () => {
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

    expect(screen.getByText("K").closest("p")).toHaveTextContent("K and note");
    expect(document.querySelector("kbd")).toBeNull();
    expect(document.querySelector("[title='shortcut']")).toBeNull();
  });

  it("renders unsafe projected inline HTML as plain text", () => {
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

  it("omits isolated projected HTML blocks", () => {
    render(
      <ProjectedMarkdownView
        plan={plan({
          blocks: [
            {
              blockId: "html",
              blockIndex: 0,
              element: "div",
              kind: "isolated",
              measurement: { estimatedHeight: 32, confidence: "low", width: 720 },
              sourceSpanByte: [0, 32],
              sourceSpanUtf16: [0, 32],
              syntaxSpans: [],
              text: "[isolated active HTML region]",
            },
            {
              blockId: "p0",
              blockIndex: 1,
              element: "p",
              kind: "paragraph",
              measurement: { estimatedHeight: 32, confidence: "high", width: 720 },
              sourceSpanByte: [34, 45],
              sourceSpanUtf16: [34, 45],
              syntaxSpans: [],
              text: "after html",
            },
          ],
          runs: [
            {
              blockId: "html",
              inlineId: "html-placeholder",
              listItemIndex: null,
              renderedText: "[isolated active HTML region]",
              renderedTextUtf16: [0, 29],
              semantic: "isolated-placeholder",
              sourceSpanByte: [0, 32],
              sourceSpanUtf16: [0, 32],
            },
            {
              blockId: "p0",
              inlineId: "text",
              listItemIndex: null,
              renderedText: "after html",
              renderedTextUtf16: [0, 10],
              semantic: "text",
              sourceSpanByte: [34, 45],
              sourceSpanUtf16: [34, 45],
            },
          ],
        })}
      />,
    );

    expect(screen.queryByText("[isolated active HTML region]")).toBeNull();
    expect(screen.getByText("after html")).toBeInTheDocument();
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
    expect(image).toHaveClass("border", "shadow-sm");
    expect(image.closest("figure")).toHaveClass("my-5");
    expect(screen.getByText("Daily plot")).toHaveClass("text-xs", "text-muted-foreground");
  });

  it("does not promote image alt text into a figure caption", () => {
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

    expect(screen.getByRole("img", { name: "Plot alt" })).toBeInTheDocument();
    expect(document.querySelector("figcaption")).toBeNull();
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

  it("marks the projected block and run for an active source position", () => {
    const { container } = render(
      <ProjectedMarkdownView
        activeSourcePosition={10}
        plan={plan({
          utf16Length: 20,
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
              text: "Before focus after",
            },
          ],
          runs: [
            {
              blockId: "p0",
              inlineId: "r0",
              listItemIndex: null,
              renderedText: "Before ",
              renderedTextUtf16: [0, 7],
              semantic: "text",
              sourceSpanByte: [0, 7],
              sourceSpanUtf16: [0, 7],
            },
            {
              blockId: "p0",
              inlineId: "r1",
              listItemIndex: null,
              renderedText: "focus",
              renderedTextUtf16: [7, 12],
              semantic: "strong",
              sourceSpanByte: [9, 14],
              sourceSpanUtf16: [9, 14],
            },
          ],
        })}
      />,
    );

    expect(container.querySelector('[data-source-active="true"]')).toHaveTextContent(
      "Before focus",
    );
    expect(container.querySelector('[data-source-active-run="true"]')).toHaveTextContent("focus");
    expect(screen.getByText("focus")).toHaveClass("font-semibold");
  });
});

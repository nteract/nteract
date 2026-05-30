/**
 * Tests for MarkdownCell's formatting logic:
 * - Inline formatting wraps selection correctly and repositions cursor
 * - Link formatting handles empty vs existing selection
 * - Quote formatting prefixes each line with "> "
 * - Edit/view toggle conditions (empty cell stays in edit, non-empty exits on blur)
 *
 * These test the shared pure formatting functions used by MarkdownCell and
 * cloud/shared editable markdown cells, not the React components themselves.
 */

import { describe, expect, it } from "vite-plus/test";
import {
  applyInlineMarkdownFormatting,
  applyLinkMarkdownFormatting,
  applyQuoteMarkdownFormatting,
  shouldExitMarkdownEditOnBlur,
  shouldStartMarkdownEditMode,
} from "@/components/cell/markdown-editor-keymap";

// ── Tests ──────────────────────────────────────────────────────────

describe("applyInlineFormatting", () => {
  it("wraps selected text with bold markers (**)", () => {
    const doc = "hello world";
    const result = applyInlineMarkdownFormatting(doc, { from: 6, to: 11 }, "**");
    expect(result.insert).toBe("**world**");
  });

  it("places cursor inside markers when nothing is selected", () => {
    const doc = "hello world";
    // Cursor at position 5 (no selection, from === to)
    const result = applyInlineMarkdownFormatting(doc, { from: 5, to: 5 }, "**");
    expect(result.insert).toBe("****");
    // Cursor should be between the markers
    expect(result.selectionAnchor).toBe(7);
    expect(result.selectionHead).toBe(7);
  });

  it("selects the wrapped text after formatting", () => {
    const doc = "hello world";
    const result = applyInlineMarkdownFormatting(doc, { from: 6, to: 11 }, "**");
    // Selection should cover "world" inside the markers
    expect(result.selectionAnchor).toBe(8); // after "**"
    expect(result.selectionHead).toBe(13); // before "**"
  });

  it("handles asymmetric markers (e.g. <u>...</u>)", () => {
    const doc = "hello world";
    const result = applyInlineMarkdownFormatting(doc, { from: 0, to: 5 }, "<u>", "</u>");
    expect(result.insert).toBe("<u>hello</u>");
    // Selection covers "hello" between <u> and </u>
    expect(result.selectionAnchor).toBe(3); // after "<u>"
    expect(result.selectionHead).toBe(8); // before "</u>"
  });

  it("handles italic formatting (*)", () => {
    const doc = "emphasis";
    const result = applyInlineMarkdownFormatting(doc, { from: 0, to: 8 }, "*");
    expect(result.insert).toBe("*emphasis*");
    expect(result.selectionAnchor).toBe(1);
    expect(result.selectionHead).toBe(9);
  });

  it("works at the beginning of the document", () => {
    const doc = "text";
    const result = applyInlineMarkdownFormatting(doc, { from: 0, to: 4 }, "**");
    expect(result.from).toBe(0);
    expect(result.insert).toBe("**text**");
  });

  it("works with multi-word selections", () => {
    const doc = "one two three";
    const result = applyInlineMarkdownFormatting(doc, { from: 0, to: 13 }, "**");
    expect(result.insert).toBe("**one two three**");
    expect(result.selectionAnchor).toBe(2);
    expect(result.selectionHead).toBe(15);
  });
});

describe("applyLinkFormatting", () => {
  it("wraps selected text in link syntax", () => {
    const doc = "click here";
    const result = applyLinkMarkdownFormatting(doc, { from: 0, to: 10 });
    expect(result.insert).toBe("[click here](https://)");
  });

  it("selects the link text after formatting (existing selection)", () => {
    const doc = "click here";
    const result = applyLinkMarkdownFormatting(doc, { from: 0, to: 10 });
    // Should select "click here" inside the brackets
    expect(result.selectionAnchor).toBe(1);
    expect(result.selectionHead).toBe(11);
  });

  it("inserts placeholder text when nothing is selected", () => {
    const doc = "hello world";
    const result = applyLinkMarkdownFormatting(doc, { from: 5, to: 5 });
    expect(result.insert).toBe("[link text](https://)");
  });

  it("selects 'link text' placeholder when nothing was selected", () => {
    const doc = "hello world";
    const result = applyLinkMarkdownFormatting(doc, { from: 5, to: 5 });
    // Should select "link text" inside the brackets
    expect(result.selectionAnchor).toBe(6); // 5 + 1 (after "[")
    expect(result.selectionHead).toBe(15); // 6 + "link text".length
  });
});

describe("applyQuoteFormatting", () => {
  it("prefixes a single line with '> '", () => {
    const doc = "hello world";
    const result = applyQuoteMarkdownFormatting(doc, { from: 0, to: 11 });
    expect(result.insert).toBe("> hello world");
  });

  it("prefixes each line of a multi-line selection", () => {
    const doc = "line1\nline2\nline3";
    const result = applyQuoteMarkdownFormatting(doc, { from: 0, to: 17 });
    expect(result.insert).toBe("> line1\n> line2\n> line3");
  });

  it("selects the entire quoted result", () => {
    const doc = "line1\nline2";
    const result = applyQuoteMarkdownFormatting(doc, { from: 0, to: 11 });
    expect(result.selectionAnchor).toBe(0);
    expect(result.selectionHead).toBe("> line1\n> line2".length);
  });

  it("uses placeholder 'quote' when nothing is selected", () => {
    const doc = "some text";
    const result = applyQuoteMarkdownFormatting(doc, { from: 4, to: 4 });
    expect(result.insert).toBe("> quote");
  });

  it("handles empty lines in selection", () => {
    const doc = "line1\n\nline3";
    const result = applyQuoteMarkdownFormatting(doc, { from: 0, to: 12 });
    expect(result.insert).toBe("> line1\n> \n> line3");
  });
});

describe("edit/view toggle conditions", () => {
  /**
   * Mirrors the handleBlur logic from MarkdownCell.tsx:
   * Only exit edit mode if cell.source.trim() is non-empty.
   * This prevents empty cells from being "stuck" in view mode
   * with no content and no way to type.
   */
  it("exits edit mode when cell has content", () => {
    expect(shouldExitMarkdownEditOnBlur("# Hello")).toBe(true);
  });

  it("stays in edit mode when cell is empty", () => {
    expect(shouldExitMarkdownEditOnBlur("")).toBe(false);
  });

  it("stays in edit mode when cell is only whitespace", () => {
    expect(shouldExitMarkdownEditOnBlur("   \n\t  ")).toBe(false);
  });

  it("exits edit mode for single character content", () => {
    expect(shouldExitMarkdownEditOnBlur("a")).toBe(true);
  });

  /**
   * Mirrors the initial editing state:
   * const [editing, setEditing] = useState(cell.source === "");
   * Empty cells start in edit mode.
   */
  it("starts in edit mode for empty cells", () => {
    expect(shouldStartMarkdownEditMode("")).toBe(true);
  });

  it("starts in view mode for cells with content", () => {
    expect(shouldStartMarkdownEditMode("# Title")).toBe(false);
  });

  it("starts in edit mode for whitespace-only cells", () => {
    expect(shouldStartMarkdownEditMode("  ")).toBe(true);
  });
});

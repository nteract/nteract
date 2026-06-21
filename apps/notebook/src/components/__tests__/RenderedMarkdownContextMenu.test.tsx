import { describe, expect, it, vi } from "vite-plus/test";
import {
  buildRenderedMarkdownClipboardPayload,
  buildRenderedMarkdownContextGroups,
  cleanRenderedMarkdownClipboardHtml,
  type BuildRenderedMarkdownContextGroupsOptions,
} from "../RenderedMarkdownContextMenu";
import type { SourceRangeCommentAnchor } from "../../lib/comment-source-anchor";

function buildActions(overrides: Partial<BuildRenderedMarkdownContextGroupsOptions> = {}) {
  const groups = buildRenderedMarkdownContextGroups({
    hasSelection: false,
    canComment: false,
    onCopy: vi.fn(),
    onAddComment: vi.fn(),
    ...overrides,
  });

  return groups[0]?.actions ?? [];
}

describe("buildRenderedMarkdownContextGroups", () => {
  it("shows copy and comment for rendered selections that can comment", () => {
    const actions = buildActions({
      hasSelection: true,
      canComment: true,
    });

    expect(actions.map((action) => action.id)).toEqual(["copy", "add-comment"]);
    expect(actions.map((action) => action.shortcut)).toEqual(["⌘C", "C"]);
    expect(actions.find((action) => action.id === "add-comment")?.separatorBefore).toBe(true);
  });

  it("shows copy only for rendered selections without a comment handler", () => {
    const actions = buildActions({
      hasSelection: true,
      canComment: false,
    });

    expect(actions.map((action) => action.id)).toEqual(["copy"]);
  });

  it("returns no actions without a rendered selection", () => {
    expect(
      buildRenderedMarkdownContextGroups({
        hasSelection: false,
        canComment: true,
      }),
    ).toEqual([]);
  });

  it("shows change to Code when a change-type handler is available", () => {
    const actions = buildActions({
      hasSelection: false,
      canComment: false,
      onChangeCellType: vi.fn(),
    });

    expect(actions.map((action) => action.id)).toEqual(["change-to-code"]);
    expect(actions[0]?.label).toBe("Change to Code");
  });
});

describe("rendered markdown clipboard payload", () => {
  function selectContents(element: HTMLElement): Range {
    const range = document.createRange();
    range.selectNodeContents(element);
    return range;
  }

  it("uses the raw markdown exact quote for plain text", () => {
    const root = document.createElement("div");
    root.textContent = "Heading item";
    const anchor = {
      kind: "source_range",
      cell_id: "md-1",
      start_line: 0,
      start_column: 0,
      end_line: 1,
      end_column: 8,
      exact_quote: "## Heading\n- **item**",
    } as SourceRangeCommentAnchor;

    expect(
      buildRenderedMarkdownClipboardPayload({
        anchor,
        selectedText: "Heading item",
        range: selectContents(root),
      })?.text,
    ).toBe("## Heading\n- **item**");
  });

  it("falls back to selected visible text without an exact source anchor", () => {
    expect(
      buildRenderedMarkdownClipboardPayload({
        anchor: null,
        selectedText: "visible text",
        range: null,
      })?.text,
    ).toBe("visible text");
  });

  it("cleans decorative heading anchors and rendered list markers from html", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <h2>
        Heading
        <a href="#heading" aria-label="Link to Heading">#</a>
      </h2>
      <ul class="list-disc marker:text-primary/65">
        <li class="marker:font-semibold">item</li>
      </ul>
    `;

    const html = cleanRenderedMarkdownClipboardHtml(selectContents(root));

    expect(html).toContain("Heading");
    expect(html).toContain("item");
    expect(html).not.toContain(">#</a>");
    expect(html).not.toContain("list-disc");
    expect(html).not.toContain("marker:text-primary/65");
    expect(html).toContain("list-style-type: none");
  });
});

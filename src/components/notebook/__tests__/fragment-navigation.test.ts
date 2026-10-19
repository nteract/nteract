import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { DocumentAnchor } from "../document-anchors";
import { documentAnchorForFragment, navigateDocumentAnchor } from "../fragment-navigation";

const cellAnchor: DocumentAnchor = {
  id: "notebook-cell-block-3",
  kind: "cell",
  cellId: "block-3",
  cellAnchorId: "notebook-cell-block-3",
  domId: "notebook-cell-block-3",
  href: "#notebook-cell-block-3",
};

const headingAnchor: DocumentAnchor = {
  id: "notebook-cell-intro-heading-load-the-data",
  kind: "markdown_heading",
  cellId: "intro",
  cellAnchorId: "notebook-cell-intro",
  domId: "notebook-cell-intro-heading-load-the-data",
  href: "#notebook-cell-intro-heading-load-the-data",
  markdownHeadingAnchorId: "notebook-cell-intro-heading-load-the-data",
  markdownAnchorSlug: "load-the-data",
};

const anchors = [cellAnchor, headingAnchor];

describe("documentAnchorForFragment", () => {
  it("resolves notebook anchor ids", () => {
    expect(documentAnchorForFragment("#notebook-cell-block-3", anchors)).toBe(cellAnchor);
    expect(documentAnchorForFragment(headingAnchor.href, anchors)).toBe(headingAnchor);
  });

  it("resolves a heading's own slug", () => {
    expect(documentAnchorForFragment("#load-the-data", anchors)).toBe(headingAnchor);
  });

  it("decodes percent-encoded fragments", () => {
    expect(documentAnchorForFragment("#load%2Dthe%2Ddata", anchors)).toBe(headingAnchor);
  });

  it("ignores external URLs, empty and unknown fragments", () => {
    expect(documentAnchorForFragment("https://example.com/#load-the-data", anchors)).toBeNull();
    expect(documentAnchorForFragment("#", anchors)).toBeNull();
    expect(documentAnchorForFragment("#missing", anchors)).toBeNull();
  });
});

describe("navigateDocumentAnchor", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("scrolls the target cell into view", () => {
    const target = document.createElement("div");
    target.id = "notebook-cell-block-3";
    target.scrollIntoView = vi.fn();
    document.body.append(target);

    expect(navigateDocumentAnchor(cellAnchor)).toBe(true);
    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "smooth" });
  });

  it("falls back to the heading's cell when the heading is not in the document", async () => {
    const cell = document.createElement("div");
    cell.id = "notebook-cell-intro";
    cell.scrollIntoView = vi.fn();
    document.body.append(cell);

    expect(navigateDocumentAnchor(headingAnchor)).toBe(true);
    await vi.waitFor(() => {
      expect(cell.scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "smooth" });
    });
  });

  it("returns false when nothing is rendered for the anchor", () => {
    expect(navigateDocumentAnchor(cellAnchor)).toBe(false);
  });
});

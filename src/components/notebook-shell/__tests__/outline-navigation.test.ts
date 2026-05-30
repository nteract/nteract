import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { NotebookOutlineItem } from "runtimed";
import { navigateNotebookOutlineItem } from "../outline-navigation";

describe("navigateNotebookOutlineItem", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("scrolls to notebook outline targets and updates the URL hash", () => {
    const target = document.createElement("div");
    target.id = "notebook-cell-code-1";
    target.scrollIntoView = vi.fn();
    document.body.append(target);

    const item = outlineItem({
      id: "code-1:cell",
      cellAnchorId: "notebook-cell-code-1",
      href: "#notebook-cell-code-1",
    });

    expect(navigateNotebookOutlineItem(item, "#notebook-cell-code-1")).toBe(true);
    expect(target.scrollIntoView).toHaveBeenCalledWith({
      block: "start",
      behavior: "smooth",
    });
    expect(window.location.hash).toBe("#notebook-cell-code-1");
  });

  it("allows hosts to provide their own cell lookup", () => {
    const target = document.createElement("div");
    target.scrollIntoView = vi.fn();
    const item = outlineItem({
      id: "cloud-cell:heading:0",
      cellAnchorId: "notebook-cell-cloud-cell",
      href: "#notebook-cell-cloud-cell-heading-intro",
    });

    expect(
      navigateNotebookOutlineItem(item, "#notebook-cell-cloud-cell-heading-intro", {
        findCellElement: () => target,
      }),
    ).toBe(true);
    expect(target.scrollIntoView).toHaveBeenCalled();
  });

  it("rejects non-anchor outline hrefs", () => {
    expect(navigateNotebookOutlineItem(outlineItem(), "/notebook")).toBe(false);
  });
});

function outlineItem(overrides: Partial<NotebookOutlineItem> = {}): NotebookOutlineItem {
  return {
    id: "code-1:cell",
    kind: "cell",
    title: "Code cell",
    level: 1,
    cellId: "code-1",
    cellAnchorId: "notebook-cell-code-1",
    href: "#notebook-cell-code-1",
    statusLabel: null,
    anchor: null,
    headingAnchorId: null,
    ...overrides,
  } as NotebookOutlineItem;
}

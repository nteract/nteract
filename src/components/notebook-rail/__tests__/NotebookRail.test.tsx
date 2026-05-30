import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { NotebookPackagesPanel, NotebookRail } from "../NotebookRail";

const outlineItems = [
  {
    id: "cell-a:heading:0",
    cellId: "cell-a",
    title: "Load data",
    level: 1,
    kind: "heading" as const,
    cellAnchorId: "notebook-cell-cell-a",
    headingAnchorId: "notebook-cell-cell-a-heading-load-data",
    href: "#notebook-cell-cell-a",
    anchor: "load-data",
  },
  {
    id: "cell-b:heading:0",
    cellId: "cell-b",
    title: "Clean columns",
    level: 2,
    kind: "heading" as const,
    cellAnchorId: "notebook-cell-cell-b",
    headingAnchorId: "notebook-cell-cell-b-heading-clean-columns",
    href: "#notebook-cell-cell-b",
    anchor: "clean-columns",
  },
];

describe("NotebookRail", () => {
  it("renders outline items and reports selection through the adapter callback", () => {
    const onSelectOutlineItem = vi.fn();

    render(
      <NotebookRail
        activePanelId="outline"
        collapsed={false}
        outlineItems={outlineItems}
        selectedOutlineCellId="cell-a"
        packagesPanel={<NotebookPackagesPanel>Packages</NotebookPackagesPanel>}
        onActivePanelChange={vi.fn()}
        onCollapsedChange={vi.fn()}
        onSelectOutlineItem={onSelectOutlineItem}
      />,
    );

    expect(screen.getByRole("link", { name: "Load data" })).toHaveAttribute(
      "aria-current",
      "location",
    );
    expect(screen.getByRole("link", { name: "Load data" })).toHaveAttribute(
      "href",
      "#notebook-cell-cell-a",
    );

    fireEvent.click(screen.getByRole("link", { name: "Clean columns" }));
    expect(onSelectOutlineItem).toHaveBeenCalledWith(outlineItems[1]);
  });

  it("switches to packages without owning package-management state", () => {
    const onActivePanelChange = vi.fn();

    render(
      <NotebookRail
        activePanelId="outline"
        collapsed={false}
        outlineItems={outlineItems}
        packagesSummary="uv · 2 packages"
        packagesPanel={
          <NotebookPackagesPanel>
            <div data-testid="host-package-content">real deps panel</div>
          </NotebookPackagesPanel>
        }
        onActivePanelChange={onActivePanelChange}
        onCollapsedChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Packages" }));
    expect(onActivePanelChange).toHaveBeenCalledWith("packages");
  });

  it("lets the host handle anchor navigation without browser default navigation", () => {
    const onSelectOutlineItem = vi.fn();
    const onNavigateOutlineItem = vi.fn(() => true);

    render(
      <NotebookRail
        activePanelId="outline"
        collapsed={false}
        outlineItems={outlineItems}
        packagesPanel={<NotebookPackagesPanel>Packages</NotebookPackagesPanel>}
        onActivePanelChange={vi.fn()}
        onCollapsedChange={vi.fn()}
        onSelectOutlineItem={onSelectOutlineItem}
        onNavigateOutlineItem={onNavigateOutlineItem}
      />,
    );

    const clickResult = fireEvent.click(screen.getByRole("link", { name: "Load data" }));

    expect(clickResult).toBe(false);
    expect(onSelectOutlineItem).toHaveBeenCalledWith(outlineItems[0]);
    expect(onNavigateOutlineItem).toHaveBeenCalledWith(outlineItems[0], "#notebook-cell-cell-a");
  });

  it("marks only the first outline item for a focused cell when no item is pinned", () => {
    render(
      <NotebookRail
        activePanelId="outline"
        collapsed={false}
        outlineItems={[
          outlineItems[0],
          {
            id: "cell-a:heading:1",
            cellId: "cell-a",
            title: "Load details",
            level: 2,
            kind: "heading" as const,
            cellAnchorId: "notebook-cell-cell-a",
            headingAnchorId: "notebook-cell-cell-a-heading-load-details",
            href: "#notebook-cell-cell-a",
            anchor: "load-details",
          },
          outlineItems[1],
        ]}
        selectedOutlineCellId="cell-a"
        packagesPanel={<NotebookPackagesPanel>Packages</NotebookPackagesPanel>}
        onActivePanelChange={vi.fn()}
        onCollapsedChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("link", { name: "Load data" })).toHaveAttribute(
      "aria-current",
      "location",
    );
    expect(screen.getByRole("link", { name: "Load details" })).not.toHaveAttribute("aria-current");
  });

  it("renders the adapter-provided package panel when packages is active", () => {
    render(
      <NotebookRail
        activePanelId="packages"
        collapsed={false}
        outlineItems={outlineItems}
        packagesSummary="uv · 2 packages"
        packagesPanel={
          <NotebookPackagesPanel>
            <div data-testid="host-package-content">real deps panel</div>
          </NotebookPackagesPanel>
        }
        onActivePanelChange={vi.fn()}
        onCollapsedChange={vi.fn()}
      />,
    );

    expect(screen.getByTestId("host-package-content")).toBeInTheDocument();
  });
});

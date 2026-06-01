import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  NOTEBOOK_RAIL_TAKEOVER_MEDIA_QUERY,
  NOTEBOOK_RAIL_TAKEOVER_PANEL_CLASS_NAMES,
  NOTEBOOK_RAIL_TAKEOVER_STAGE_CLASS_NAME,
  NotebookPackagesPanel,
  NotebookRail,
} from "../NotebookRail";

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
    expect(screen.getByRole("link", { name: "Load data" })).toHaveClass(
      "font-medium",
      "before:bg-primary",
    );
    expect(screen.queryByText("2 items")).not.toBeInTheDocument();
    expect(screen.queryByText("1 item")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Load data" })).toHaveAttribute(
      "href",
      "#notebook-cell-cell-a",
    );

    fireEvent.click(screen.getByRole("link", { name: "Clean columns" }));
    expect(onSelectOutlineItem).toHaveBeenCalledWith(outlineItems[1]);
  });

  it("switches to packages without owning package-management state", () => {
    const onActivePanelChange = vi.fn();
    const onCollapsedChange = vi.fn();

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
        onCollapsedChange={onCollapsedChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Packages" }));
    expect(onActivePanelChange).toHaveBeenCalledWith("packages");
    expect(onCollapsedChange).toHaveBeenCalledWith(false);
  });

  it("keeps the active panel title primary when package metadata is present", () => {
    render(
      <NotebookRail
        activePanelId="packages"
        collapsed={false}
        outlineItems={outlineItems}
        packagesSummary="../pyproject.toml · 25 packages"
        packagesPanel={<NotebookPackagesPanel>Packages</NotebookPackagesPanel>}
        onActivePanelChange={vi.fn()}
        onCollapsedChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Packages" })).toHaveClass("text-sm");
    expect(screen.getByText("../pyproject.toml · 25 packages")).toHaveClass("w-fit", "max-w-full");
  });

  it("collapses the rail when clicking the active expanded panel button", () => {
    const onActivePanelChange = vi.fn();
    const onCollapsedChange = vi.fn();

    render(
      <NotebookRail
        activePanelId="outline"
        collapsed={false}
        outlineItems={outlineItems}
        packagesPanel={<NotebookPackagesPanel>Packages</NotebookPackagesPanel>}
        onActivePanelChange={onActivePanelChange}
        onCollapsedChange={onCollapsedChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Outline" }));
    expect(onCollapsedChange).toHaveBeenCalledWith(true);
    expect(onActivePanelChange).not.toHaveBeenCalled();
  });

  it("exposes the collapse control for narrow takeover focus recovery", () => {
    const { container } = render(
      <NotebookRail
        activePanelId="outline"
        collapsed={false}
        outlineItems={outlineItems}
        packagesPanel={<NotebookPackagesPanel>Packages</NotebookPackagesPanel>}
        onActivePanelChange={vi.fn()}
        onCollapsedChange={vi.fn()}
      />,
    );

    expect(
      container.querySelector('[data-slot="notebook-rail-collapse-button"]'),
    ).toHaveAccessibleName("Collapse rail");
  });

  it("collapses the expanded packages panel from its rail button", () => {
    const onActivePanelChange = vi.fn();
    const onCollapsedChange = vi.fn();

    render(
      <NotebookRail
        activePanelId="packages"
        collapsed={false}
        outlineItems={outlineItems}
        packagesPanel={<NotebookPackagesPanel>Packages</NotebookPackagesPanel>}
        onActivePanelChange={onActivePanelChange}
        onCollapsedChange={onCollapsedChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Packages" }));
    expect(onCollapsedChange).toHaveBeenCalledWith(true);
    expect(onActivePanelChange).not.toHaveBeenCalled();
  });

  it("expands the selected panel when clicking a panel button while collapsed", () => {
    const onActivePanelChange = vi.fn();
    const onCollapsedChange = vi.fn();

    render(
      <NotebookRail
        activePanelId="packages"
        collapsed
        outlineItems={outlineItems}
        packagesPanel={<NotebookPackagesPanel>Packages</NotebookPackagesPanel>}
        onActivePanelChange={onActivePanelChange}
        onCollapsedChange={onCollapsedChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Packages" }));
    expect(onActivePanelChange).toHaveBeenCalledWith("packages");
    expect(onCollapsedChange).toHaveBeenCalledWith(false);
  });

  it("exposes a stable panel slot for host shell layout adapters", () => {
    const { container } = render(
      <NotebookRail
        activePanelId="outline"
        collapsed={false}
        outlineItems={outlineItems}
        packagesPanel={<NotebookPackagesPanel>Packages</NotebookPackagesPanel>}
        onActivePanelChange={vi.fn()}
        onCollapsedChange={vi.fn()}
      />,
    );

    expect(
      screen.getByTestId("notebook-rail").querySelector('[data-slot="notebook-rail-panel"]'),
    ).toBeInTheDocument();
    expect(container.querySelector('[data-slot="notebook-rail-panel"]')).toHaveClass(
      "w-[clamp(13rem,18vw,16rem)]",
      ...NOTEBOOK_RAIL_TAKEOVER_PANEL_CLASS_NAMES.split(" "),
    );
  });

  it("keeps package details compact until the rail owns the viewport", () => {
    const { container } = render(
      <NotebookRail
        activePanelId="packages"
        collapsed={false}
        outlineItems={outlineItems}
        packagesPanel={<NotebookPackagesPanel>Packages</NotebookPackagesPanel>}
        onActivePanelChange={vi.fn()}
        onCollapsedChange={vi.fn()}
      />,
    );

    expect(container.querySelector('[data-slot="notebook-rail-panel"]')).toHaveClass(
      "w-[clamp(12.5rem,17vw,14rem)]",
      "min-w-[12.5rem]",
      ...NOTEBOOK_RAIL_TAKEOVER_PANEL_CLASS_NAMES.split(" "),
    );
  });

  it("keeps the stage and panel takeover breakpoint in one rail contract", () => {
    expect(NOTEBOOK_RAIL_TAKEOVER_MEDIA_QUERY).toBe("(max-width: 599.98px)");
    expect(NOTEBOOK_RAIL_TAKEOVER_STAGE_CLASS_NAME).toBe("max-[599.98px]:hidden");
    expect(NOTEBOOK_RAIL_TAKEOVER_PANEL_CLASS_NAMES).toContain(
      "max-[599.98px]:w-[calc(100vw-3rem)]",
    );
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

  it("prevents outline links from starting browser drag previews", () => {
    const { container } = render(
      <NotebookRail
        activePanelId="outline"
        collapsed={false}
        outlineItems={outlineItems}
        packagesPanel={<NotebookPackagesPanel>Packages</NotebookPackagesPanel>}
        onActivePanelChange={vi.fn()}
        onCollapsedChange={vi.fn()}
      />,
    );

    const outlinePanel = screen.getByTestId("notebook-outline-panel");
    const outlineLink = screen.getByRole("link", { name: "Load data" });
    const outlineTitle = container.querySelector('[data-slot="notebook-outline-item-title"]');

    expect(outlinePanel).toHaveAttribute("data-drag-policy", "navigation-only");
    expect(outlineLink).toHaveAttribute("draggable", "false");
    expect(fireEvent.dragStart(outlineLink)).toBe(false);
    expect(fireEvent.dragStart(outlineTitle!)).toBe(false);
  });

  it("lets outline titles wrap as document language in the rail", () => {
    const { container } = render(
      <NotebookRail
        activePanelId="outline"
        collapsed={false}
        outlineItems={[
          {
            id: "cell-a:heading:0",
            cellId: "cell-a",
            title: "Recent Download Activity Across the Last Thirty Days",
            level: 1,
            kind: "heading" as const,
            cellAnchorId: "notebook-cell-cell-a",
            headingAnchorId: "notebook-cell-cell-a-heading-recent-download-activity",
            href: "#notebook-cell-cell-a",
            anchor: "recent-download-activity",
          },
        ]}
        packagesPanel={<NotebookPackagesPanel>Packages</NotebookPackagesPanel>}
        onActivePanelChange={vi.fn()}
        onCollapsedChange={vi.fn()}
      />,
    );

    const outlineTitle = container.querySelector('[data-slot="notebook-outline-item-title"]');
    expect(outlineTitle).toHaveClass("line-clamp-2");
    expect(outlineTitle).not.toHaveClass("truncate");
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

  it("prefers an explicitly selected outline item over scroll-spy context", () => {
    render(
      <NotebookRail
        activePanelId="outline"
        collapsed={false}
        outlineItems={outlineItems}
        activeOutlineItemId="cell-a:heading:0"
        selectedOutlineItemId="cell-b:heading:0"
        packagesPanel={<NotebookPackagesPanel>Packages</NotebookPackagesPanel>}
        onActivePanelChange={vi.fn()}
        onCollapsedChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("link", { name: "Clean columns" })).toHaveAttribute(
      "aria-current",
      "location",
    );
    expect(screen.getByRole("link", { name: "Load data" })).not.toHaveAttribute("aria-current");
  });

  it("uses notebook cell order to keep code cells in their markdown section context", () => {
    render(
      <NotebookRail
        activePanelId="outline"
        collapsed={false}
        activeOutlineItemId="cell-a:heading:0"
        outlineCellIds={["cell-a", "cell-b", "cell-c", "cell-d"]}
        outlineItems={[
          outlineItems[0],
          {
            id: "cell-c:heading:0",
            cellId: "cell-c",
            title: "Clean columns",
            level: 2,
            kind: "heading" as const,
            cellAnchorId: "notebook-cell-cell-c",
            headingAnchorId: "notebook-cell-cell-c-heading-clean-columns",
            href: "#notebook-cell-cell-c",
            anchor: "clean-columns",
          },
        ]}
        selectedOutlineCellId="cell-d"
        packagesPanel={<NotebookPackagesPanel>Packages</NotebookPackagesPanel>}
        onActivePanelChange={vi.fn()}
        onCollapsedChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("link", { name: "Clean columns" })).toHaveAttribute(
      "aria-current",
      "location",
    );
  });

  it("renders nested outline levels instead of a flat indented list", () => {
    const { container } = render(
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
        ]}
        packagesPanel={<NotebookPackagesPanel>Packages</NotebookPackagesPanel>}
        onActivePanelChange={vi.fn()}
        onCollapsedChange={vi.fn()}
      />,
    );

    expect(
      container.querySelector('li[data-outline-level="1"] ol li[data-outline-level="2"]'),
    ).not.toBeNull();
  });

  it("keeps nested same-cell markdown headings on the cell href by default", () => {
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
        ]}
        packagesPanel={<NotebookPackagesPanel>Packages</NotebookPackagesPanel>}
        onActivePanelChange={vi.fn()}
        onCollapsedChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("link", { name: "Load details" })).toHaveAttribute(
      "href",
      "#notebook-cell-cell-a",
    );
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

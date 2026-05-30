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
  },
  {
    id: "cell-b:heading:0",
    cellId: "cell-b",
    title: "Clean columns",
    level: 2,
    kind: "heading" as const,
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

    expect(screen.getByRole("button", { name: "Load data" })).toHaveAttribute(
      "aria-current",
      "location",
    );

    fireEvent.click(screen.getByRole("button", { name: "Clean columns" }));
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

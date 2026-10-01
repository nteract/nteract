import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vite-plus/test";
import { NotebookDocumentRail } from "../NotebookDocumentRail";
import type { NotebookViewModel } from "../view-model";

describe("NotebookDocumentRail", () => {
  const viewModel: Pick<NotebookViewModel, "outlineItems" | "packages"> = {
    outlineItems: [
      {
        id: "intro:heading:0",
        kind: "heading",
        cellId: "intro",
        title: "Intro",
        level: 1,
        order: 0,
        statusLabel: null,
        href: "#intro",
        anchor: "intro",
        headingAnchorId: "notebook-cell-intro-heading-intro",
      },
    ],
    packages: {
      summary: "uv · 2 packages",
      sections: [],
    },
  };

  it("binds shared notebook view model projections to the notebook rail", () => {
    render(
      <NotebookDocumentRail
        viewModel={viewModel}
        activePanelId="packages"
        collapsed={false}
        packagesPanel={<p>Package details</p>}
        onActivePanelChange={() => {}}
        onCollapsedChange={() => {}}
      />,
    );

    expect(screen.getByTestId("notebook-rail")).toHaveAttribute("data-collapsed", "false");
    expect(screen.queryByText("Runtime packages")).not.toBeInTheDocument();
    expect(screen.getByText("Package details")).toBeVisible();
  });

  it("names the packages panel without duplicating view-model summaries", () => {
    render(
      <NotebookDocumentRail
        viewModel={viewModel}
        activePanelId="packages"
        collapsed={false}
        packagesPanel={<p>Package details</p>}
        onActivePanelChange={() => {}}
        onCollapsedChange={() => {}}
      />,
    );

    expect(screen.getByRole("heading", { name: "Packages" })).toBeVisible();
    expect(screen.queryByText("uv · 2 packages")).not.toBeInTheDocument();
    expect(screen.getByText("Package details")).toBeVisible();
  });

  it("keeps Packages navigation available by pointer and keyboard", async () => {
    const user = userEvent.setup();
    const onActivePanelChange = vi.fn();
    render(
      <NotebookDocumentRail
        viewModel={viewModel}
        activePanelId="outline"
        collapsed={false}
        packagesPanel={<p>Package details</p>}
        onActivePanelChange={onActivePanelChange}
        onCollapsedChange={() => {}}
      />,
    );

    const packagesButton = screen.getByRole("button", { name: "Packages", exact: true });
    await user.click(packagesButton);
    expect(onActivePanelChange).toHaveBeenCalledWith("packages");

    onActivePanelChange.mockClear();
    packagesButton.focus();
    await user.keyboard("{Enter}");
    expect(onActivePanelChange).toHaveBeenCalledWith("packages");
  });

  it("forwards host outline selection state", () => {
    render(
      <NotebookDocumentRail
        viewModel={viewModel}
        activePanelId="outline"
        collapsed={false}
        outlineCellIds={["intro"]}
        activeOutlineItemId="intro:heading:0"
        packagesPanel={<p>Package details</p>}
        onActivePanelChange={() => {}}
        onCollapsedChange={() => {}}
      />,
    );

    expect(screen.getByRole("link", { name: "Intro" })).toHaveAttribute("aria-current", "location");
  });

  it("forwards the host workstation panel", () => {
    render(
      <NotebookDocumentRail
        viewModel={viewModel}
        activePanelId="workstations"
        collapsed={false}
        packagesPanel={<p>Package details</p>}
        workstationsPanel={<p>Runtime target</p>}
        onActivePanelChange={() => {}}
        onCollapsedChange={() => {}}
      />,
    );

    expect(screen.getByRole("heading", { name: "Workstations" })).toBeVisible();
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();
    expect(screen.getByText("Runtime target")).toBeVisible();
  });
});

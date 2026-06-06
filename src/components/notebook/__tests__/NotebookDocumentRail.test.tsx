import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
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
        packagesSummary="Runtime packages"
        packagesPanel={<p>Package details</p>}
        onActivePanelChange={() => {}}
        onCollapsedChange={() => {}}
      />,
    );

    expect(screen.getByTestId("notebook-rail")).toHaveAttribute("data-collapsed", "false");
    expect(screen.getByText("Runtime packages")).toBeVisible();
    expect(screen.getByText("Package details")).toBeVisible();
  });

  it("can suppress the package title summary when the host renders it in the panel", () => {
    render(
      <NotebookDocumentRail
        viewModel={viewModel}
        activePanelId="packages"
        collapsed={false}
        packagesSummary={null}
        packagesPanel={<p>Package details</p>}
        onActivePanelChange={() => {}}
        onCollapsedChange={() => {}}
      />,
    );

    expect(screen.getByRole("heading", { name: "Packages" })).toBeVisible();
    expect(screen.queryByText("uv · 2 packages")).not.toBeInTheDocument();
    expect(screen.getByText("Package details")).toBeVisible();
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
        workstationsSummary="Ready"
        workstationsPanel={<p>Runtime target</p>}
        onActivePanelChange={() => {}}
        onCollapsedChange={() => {}}
      />,
    );

    expect(screen.getByRole("heading", { name: "Workstations" })).toBeVisible();
    expect(screen.getByText("Ready")).toBeVisible();
    expect(screen.getByText("Runtime target")).toBeVisible();
  });
});

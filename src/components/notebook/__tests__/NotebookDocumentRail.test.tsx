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

  const contentSections = [
    {
      id: "recent",
      title: "Recent notebooks",
      items: [
        {
          id: "current",
          kind: "notebook" as const,
          title: "analysis.ipynb",
          detail: "~/Notebooks/analysis.ipynb",
        },
      ],
    },
  ];

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

  it("forwards host content catalog sections", () => {
    render(
      <NotebookDocumentRail
        viewModel={viewModel}
        activePanelId="content"
        collapsed={false}
        contentSections={contentSections}
        contentSummary="Desktop"
        packagesPanel={<p>Package details</p>}
        onActivePanelChange={() => {}}
        onCollapsedChange={() => {}}
      />,
    );

    expect(screen.getByRole("heading", { name: "Content" })).toBeVisible();
    expect(screen.getByText("Desktop")).toBeVisible();
    expect(screen.getByText("analysis.ipynb")).toBeVisible();
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
});

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import { NotebookDocumentRail } from "../NotebookDocumentRail";
import type { NotebookViewModel } from "../view-model";

describe("NotebookDocumentRail", () => {
  it("binds shared notebook view model projections to the notebook rail", () => {
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
    expect(screen.getByText("uv · 2 packages")).toBeVisible();
    expect(screen.getByText("Package details")).toBeVisible();
  });
});

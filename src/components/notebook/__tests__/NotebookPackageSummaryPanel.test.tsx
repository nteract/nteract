import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import { NotebookPackageSummaryPanel } from "../NotebookPackageSummaryPanel";
import type { NotebookPackageViewModel } from "../view-model";

describe("NotebookPackageSummaryPanel", () => {
  it("renders package specs in a shared rail panel", () => {
    const packages: NotebookPackageViewModel = {
      summary: "uv · 2 packages",
      sections: [
        {
          manager: "uv",
          label: "uv",
          dependencies: ["pandas>=2", "polars"],
          details: [{ label: "Python", values: [">=3.12"] }],
        },
      ],
    };

    const { container } = render(<NotebookPackageSummaryPanel packages={packages} readOnly />);

    expect(screen.getByTestId("notebook-packages-panel")).toHaveAttribute("data-read-only", "true");
    expect(container.querySelector('[data-slot="environment-package-summary-panel"]')).toHaveClass(
      "-my-3",
    );
    expect(screen.getByRole("list", { name: "Declared packages" })).toBeVisible();
    expect(screen.getByText("pandas>=2")).toBeVisible();
    expect(screen.getByText("polars")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "uv" })).toBeNull();
    expect(screen.queryByText(">=3.12")).toBeNull();
    expect(screen.queryByText("2 declared dependencies")).toBeNull();
    expect(screen.queryByText("View only")).toBeNull();
  });

  it("shows an empty package listing state", () => {
    render(<NotebookPackageSummaryPanel packages={{ summary: null, sections: [] }} />);

    expect(screen.getByText("No declared packages.")).toBeVisible();
  });
});

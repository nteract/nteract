import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import { NotebookPackageSummaryPanel } from "../NotebookPackageSummaryPanel";
import type { NotebookPackageViewModel } from "../view-model";

describe("NotebookPackageSummaryPanel", () => {
  it("renders package metadata in a read-only shared rail panel", () => {
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

    render(<NotebookPackageSummaryPanel packages={packages} readOnly />);

    expect(screen.getByTestId("notebook-packages-panel")).toHaveAttribute("data-read-only", "true");
    expect(screen.getByRole("heading", { name: "uv" })).toBeVisible();
    expect(screen.getByText("pandas>=2")).toBeVisible();
    expect(screen.getByText("polars")).toBeVisible();
    expect(screen.getByText(">=3.12")).toBeVisible();
    expect(screen.getByText("Read only")).toBeVisible();
  });

  it("shows an empty package metadata state", () => {
    render(<NotebookPackageSummaryPanel packages={{ summary: null, sections: [] }} />);

    expect(screen.getByText("No package metadata in this notebook.")).toBeVisible();
  });
});

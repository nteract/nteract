import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentPackageSummaryPanel,
  notebookMetadataToPackageViewModel,
  type NotebookPackageViewModel,
} from "../index";

describe("EnvironmentPackageSummaryPanel", () => {
  it("renders package specs as a listing without environment manager chrome", () => {
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

    const { container } = render(<EnvironmentPackageSummaryPanel packages={packages} readOnly />);

    expect(container.querySelector('[data-slot="environment-package-summary-panel"]')).toBeTruthy();
    expect(screen.getByRole("list", { name: "Declared packages" })).toBeVisible();
    expect(screen.getByText("pandas>=2")).toBeVisible();
    expect(screen.getByText("polars")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "uv" })).toBeNull();
    expect(screen.queryByText(">=3.12")).toBeNull();
    expect(screen.queryByText("2 declared dependencies")).toBeNull();
    expect(screen.queryByText("View only")).toBeNull();
  });

  it("projects notebook metadata into environment package sections", () => {
    const packages = notebookMetadataToPackageViewModel({
      runt: {
        uv: {
          dependencies: ["pandas>=2"],
          "requires-python": ">=3.12",
        },
        deno: {
          permissions: ["net"],
          flexible_npm_imports: true,
        },
      },
    });

    expect(packages.summary).toBe("uv + Deno · 1 package");
    expect(packages.sections).toMatchObject([
      {
        manager: "uv",
        dependencies: ["pandas>=2"],
        details: [{ label: "Python", values: [">=3.12"] }],
      },
      {
        manager: "deno",
        dependencies: [],
        details: [
          { label: "Permissions", values: ["net"] },
          { label: "Flexible npm imports", values: ["enabled"] },
        ],
      },
    ]);
  });
});

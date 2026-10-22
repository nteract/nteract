import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { InstalledCondaPackagesPanel } from "../InstalledCondaPackagesPanel";

describe("InstalledCondaPackagesPanel", () => {
  it("shows installed records independently from declarations and offers refresh only", () => {
    const onLoad = vi.fn();
    render(
      <InstalledCondaPackagesPanel
        inventory={{
          packages: [{ name: "numpy", version: "2.1.0", build: "py312_0" }],
          truncated: false,
          warnings: [],
        }}
        loading={false}
        error={null}
        onLoad={onLoad}
      />,
    );
    expect(
      screen.getByText(
        "Conda records in the running environment. This is separate from notebook declarations.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("numpy")).toBeTruthy();
    expect(screen.getByText("2.1.0")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
    expect(screen.queryByRole("button", { name: /install packages/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(onLoad).toHaveBeenCalledWith(true);
  });

  it("distinguishes empty records, partial results and errors", () => {
    const { rerender } = render(
      <InstalledCondaPackagesPanel
        inventory={{ packages: [], truncated: false, warnings: [] }}
        loading={false}
        error={null}
        onLoad={() => {}}
      />,
    );
    expect(screen.getByText("No Conda package records found.")).toBeTruthy();
    rerender(
      <InstalledCondaPackagesPanel
        inventory={{ packages: [], truncated: true, warnings: ["Record budget reached"] }}
        loading={false}
        error={"Metadata unreadable"}
        onLoad={() => {}}
      />,
    );
    expect(
      screen.getByText("The inventory was truncated at a configured record or size limit."),
    ).toBeTruthy();
    expect(screen.getByText("Record budget reached")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Metadata unreadable");
  });

  it("does not show a Load button before the runtime-triggered query completes", () => {
    render(
      <InstalledCondaPackagesPanel
        inventory={null}
        loading={false}
        error={null}
        onLoad={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Load" })).toBeNull();
  });
});

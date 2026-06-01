import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { NotebookCommandToolbar } from "../NotebookCommandToolbar";

const runtimeStatus = {
  state: "idle" as const,
  label: "idle",
  ariaLabel: "Kernel: idle",
  title: "Kernel is idle",
};

const editableToolbarCapabilities = {
  canEditStructure: true,
  canExecute: true,
  canViewPackages: true,
};

describe("NotebookCommandToolbar", () => {
  it("renders shared desktop command controls when host capabilities allow them", () => {
    const onAddCell = vi.fn();
    const onRunAllCells = vi.fn();

    render(
      <NotebookCommandToolbar
        capabilities={editableToolbarCapabilities}
        runtime="python"
        environmentManager="uv"
        runtimeStatus={runtimeStatus}
        addAfterCellId="cell-1"
        onAddCell={onAddCell}
        onRunAllCells={onRunAllCells}
        onRestartRuntime={() => {}}
        onRestartAndRunAll={() => {}}
        onInterruptRuntime={() => {}}
        onTogglePackages={() => {}}
        trailingControls={<button type="button">Kyle</button>}
      />,
    );

    fireEvent.click(screen.getByTestId("add-code-cell-button"));
    fireEvent.click(screen.getByTestId("run-all-button"));

    expect(onAddCell).toHaveBeenCalledWith("code", "cell-1");
    expect(onRunAllCells).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("deps-toggle")).toHaveAttribute("data-env-manager", "uv");
    expect(screen.getByRole("button", { name: "Kyle" })).toBeVisible();
  });

  it("hides mutation and execution controls when the host does not grant them", () => {
    render(
      <NotebookCommandToolbar
        capabilities={{
          ...editableToolbarCapabilities,
          canEditStructure: false,
          canExecute: false,
        }}
        runtime="python"
        runtimeStatus={runtimeStatus}
        onAddCell={() => {}}
        onRunAllCells={() => {}}
        onRestartRuntime={() => {}}
        onRestartAndRunAll={() => {}}
      />,
    );

    expect(screen.queryByTestId("add-code-cell-button")).toBeNull();
    expect(screen.queryByTestId("run-all-button")).toBeNull();
    expect(screen.getByTestId("kernel-status")).toHaveAttribute("data-kernel-status", "idle");
  });
});

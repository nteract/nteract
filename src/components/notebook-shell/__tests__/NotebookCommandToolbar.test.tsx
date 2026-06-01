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
  canManageSharing: true,
  canRequestEdit: true,
  auth: {
    canSignIn: true,
    canUseAuthenticatedIdentity: true,
    needsAttention: false,
  },
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
        identityControls={<button type="button">Kyle</button>}
      />,
    );

    fireEvent.click(screen.getByTestId("add-code-cell-button"));
    fireEvent.click(screen.getByTestId("run-all-button"));

    expect(onAddCell).toHaveBeenCalledWith("code", "cell-1");
    expect(onRunAllCells).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("deps-toggle")).toHaveAttribute("data-env-manager", "uv");
    expect(screen.getByRole("button", { name: "Kyle" })).toBeVisible();
  });

  it("renders host chrome through named capability-scoped slots", () => {
    render(
      <NotebookCommandToolbar
        capabilities={editableToolbarCapabilities}
        runtimeStatus={runtimeStatus}
        presenceControls={<div>2 here now, editing</div>}
        utilityControls={<button type="button">Utility</button>}
        sharingControls={<button type="button">Share</button>}
        editControls={<button type="button">View</button>}
        authControls={<button type="button">Sign in</button>}
        identityControls={<button type="button">Kyle</button>}
      />,
    );

    expect(screen.getByText("2 here now, editing")).toBeVisible();
    expect(screen.getByRole("button", { name: "Utility" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Share" })).toBeVisible();
    expect(screen.getByRole("button", { name: "View" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Kyle" })).toBeVisible();
  });

  it("hides mutation and execution controls when the host does not grant them", () => {
    render(
      <NotebookCommandToolbar
        capabilities={{
          ...editableToolbarCapabilities,
          canEditStructure: false,
          canExecute: false,
          canManageSharing: false,
          canRequestEdit: false,
          auth: {
            canSignIn: false,
            canUseAuthenticatedIdentity: false,
            needsAttention: false,
          },
        }}
        runtime="python"
        runtimeStatus={runtimeStatus}
        onAddCell={() => {}}
        onRunAllCells={() => {}}
        onRestartRuntime={() => {}}
        onRestartAndRunAll={() => {}}
        sharingControls={<button type="button">Share</button>}
        editControls={<button type="button">Edit</button>}
        authControls={<button type="button">Sign in</button>}
      />,
    );

    expect(screen.queryByTestId("add-code-cell-button")).toBeNull();
    expect(screen.queryByTestId("run-all-button")).toBeNull();
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(screen.getByTestId("kernel-status")).toHaveAttribute("data-kernel-status", "idle");
  });
});

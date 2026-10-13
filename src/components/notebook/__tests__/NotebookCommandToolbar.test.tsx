import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
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
  canManageSharing: true,
  canRequestEdit: true,
  auth: {
    canSignIn: true,
    canUseAuthenticatedIdentity: true,
    needsAttention: false,
  },
};

describe("NotebookCommandToolbar", () => {
  it("blocks additional startup requests while workstation attachment is pending", () => {
    const onStartRuntime = vi.fn();
    const onRunAllCells = vi.fn();
    const renderToolbar = (pending: boolean) => (
      <NotebookCommandToolbar
        capabilities={editableToolbarCapabilities}
        runtimeStatus={null}
        onStartRuntime={onStartRuntime}
        onRunAllCells={onRunAllCells}
        workstationAction={
          pending
            ? {
                label: "Starting",
                title: "Starting compute",
                pending: true,
                onClick: onStartRuntime,
              }
            : null
        }
      />
    );
    const { rerender } = render(renderToolbar(true));

    expect(screen.getByTestId("start-kernel-button")).toBeDisabled();
    expect(screen.getByTestId("run-all-button")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Starting" })).toBeDisabled();
    fireEvent.click(screen.getByTestId("start-kernel-button"));
    fireEvent.click(screen.getByTestId("run-all-button"));
    expect(onStartRuntime).not.toHaveBeenCalled();
    expect(onRunAllCells).not.toHaveBeenCalled();

    rerender(renderToolbar(false));
    expect(screen.getByTestId("start-kernel-button")).toBeEnabled();
    expect(screen.getByTestId("run-all-button")).toBeEnabled();
    fireEvent.click(screen.getByTestId("start-kernel-button"));
    fireEvent.click(screen.getByTestId("run-all-button"));
    expect(onStartRuntime).toHaveBeenCalledOnce();
    expect(onRunAllCells).toHaveBeenCalledOnce();
  });

  it("lets available compute start or run cells before a runtime status exists", () => {
    const onStartRuntime = vi.fn();
    const onRunAllCells = vi.fn();
    render(
      <NotebookCommandToolbar
        capabilities={editableToolbarCapabilities}
        runtimeStatus={null}
        onStartRuntime={onStartRuntime}
        onRunAllCells={onRunAllCells}
        onRestartRuntime={() => {}}
        onRestartAndRunAll={() => {}}
        onInterruptRuntime={() => {}}
      />,
    );

    fireEvent.click(screen.getByTestId("start-kernel-button"));
    fireEvent.click(screen.getByTestId("run-all-button"));

    expect(onStartRuntime).toHaveBeenCalledOnce();
    expect(onRunAllCells).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("kernel-status")).toBeNull();
    expect(screen.queryByTestId("restart-kernel-button")).toBeNull();
    expect(screen.queryByTestId("restart-run-all-button")).toBeNull();
    expect(screen.queryByTestId("interrupt-kernel-button")).toBeNull();
  });

  it("keeps existing recovery controls reachable while execution is unavailable", () => {
    const onRestartRuntime = vi.fn();
    const onInterruptRuntime = vi.fn();
    const onReconnect = vi.fn();
    render(
      <NotebookCommandToolbar
        capabilities={{
          ...editableToolbarCapabilities,
          canExecute: false,
          canRecoverRuntime: true,
        }}
        runtimeStatus={{ state: "error", label: "disconnected", ariaLabel: "Kernel: disconnected" }}
        onRestartRuntime={onRestartRuntime}
        onInterruptRuntime={onInterruptRuntime}
        onRunAllCells={() => {}}
        onRestartAndRunAll={() => {}}
        workstationAction={{
          label: "Start compute",
          title: "Reconnect to Python",
          onClick: onReconnect,
        }}
      />,
    );
    fireEvent.click(screen.getByTestId("restart-kernel-button"));
    fireEvent.click(screen.getByTestId("interrupt-kernel-button"));
    fireEvent.click(screen.getByRole("button", { name: "Start compute" }));
    expect(onRestartRuntime).toHaveBeenCalledOnce();
    expect(onInterruptRuntime).toHaveBeenCalledOnce();
    expect(onReconnect).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("run-all-button")).toBeNull();
    expect(screen.queryByTestId("restart-run-all-button")).toBeNull();
  });

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
        identityControls={<button type="button">Kyle</button>}
      />,
    );

    fireEvent.click(screen.getByTestId("add-code-cell-button"));
    fireEvent.click(screen.getByTestId("run-all-button"));

    expect(onAddCell).toHaveBeenCalledWith("code", "cell-1");
    expect(onRunAllCells).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("runtime-environment-indicator")).toHaveAttribute(
      "data-env-manager",
      "uv",
    );
    expect(screen.getByRole("button", { name: "Kyle" })).toBeVisible();
  });

  it("renders run-all without requiring host restart actions", () => {
    const onRunAllCells = vi.fn();
    const onInterruptRuntime = vi.fn();

    render(
      <NotebookCommandToolbar
        capabilities={editableToolbarCapabilities}
        runtimeStatus={runtimeStatus}
        onRunAllCells={onRunAllCells}
        onInterruptRuntime={onInterruptRuntime}
      />,
    );

    fireEvent.click(screen.getByTestId("run-all-button"));
    fireEvent.click(screen.getByTestId("interrupt-kernel-button"));

    expect(onRunAllCells).toHaveBeenCalledTimes(1);
    expect(onInterruptRuntime).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("restart-kernel-button")).toBeNull();
    expect(screen.queryByTestId("restart-run-all-button")).toBeNull();
  });

  it("renders host chrome through named capability-scoped slots", () => {
    render(
      <NotebookCommandToolbar
        capabilities={editableToolbarCapabilities}
        runtimeStatus={runtimeStatus}
        presenceControls={<div>Notebook title</div>}
        utilityControls={<button type="button">Utility</button>}
        sharingControls={<button type="button">Share</button>}
        editControls={<button type="button">View</button>}
        authControls={<button type="button">Sign in</button>}
        identityControls={<button type="button">Kyle</button>}
      />,
    );

    expect(screen.getByText("Notebook title")).toBeVisible();
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

  it("can reserve add-cell controls as disabled while host edit access resolves", async () => {
    const user = userEvent.setup();
    const onAddCell = vi.fn();

    render(
      <NotebookCommandToolbar
        capabilities={{
          ...editableToolbarCapabilities,
          canEditStructure: false,
          canExecute: false,
        }}
        addCellControlsDisabled
        onAddCell={onAddCell}
      />,
    );

    const codeButton = screen.getByTestId("add-code-cell-button");
    const markdownButton = screen.getByTestId("add-markdown-cell-button");

    expect(codeButton).toBeDisabled();
    expect(codeButton).toHaveAccessibleName("Add code cell");
    expect(codeButton).toHaveAttribute("aria-description", "Checking edit access");
    expect(markdownButton).toBeDisabled();

    // A disabled button passes the pointer through to its tooltip wrapper.
    expect(codeButton).toHaveClass("disabled:pointer-events-none");
    expect(codeButton.parentElement).toHaveClass("cursor-not-allowed");
    await user.hover(codeButton.parentElement!);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Checking edit access");

    fireEvent.click(codeButton);

    expect(onAddCell).not.toHaveBeenCalled();
  });

  it("can render notebook commands without a runtime status surface", () => {
    render(
      <NotebookCommandToolbar
        capabilities={{
          ...editableToolbarCapabilities,
          canExecute: false,
        }}
        runtime="python"
      />,
    );

    expect(screen.getByTestId("runtime-environment-indicator")).toBeVisible();
    expect(screen.queryByTestId("kernel-status")).toBeNull();
    expect(screen.queryByTestId("run-all-button")).toBeNull();
  });

  it("surfaces attached compute metadata on the runtime chip", async () => {
    const user = userEvent.setup();
    render(
      <NotebookCommandToolbar
        capabilities={editableToolbarCapabilities}
        runtime="python"
        runtimeTarget={{
          id: "ws-lab2",
          kind: "cloud_workstation",
          status: "ready",
          label: "Lab2 workstation",
          statusLabel: "Ready",
          detail: "Runtime peer attached",
          providerLabel: "Cloud room",
          defaultEnvironmentLabel: "Current Python",
          environmentLabel: "Current Python",
          kernelStatusLabel: "idle",
          runtimePeerCount: 1,
        }}
      />,
    );

    const description =
      "Python runtime · Lab2 workstation · Ready · Kernel idle · 1 compute session";
    const chip = screen.getByTestId("runtime-environment-indicator");
    expect(chip).toHaveAttribute("data-runtime-target", "cloud_workstation");
    expect(chip).toHaveAttribute("data-runtime-peer-count", "1");
    expect(within(chip).getByText(description)).toHaveClass("sr-only");

    await user.hover(chip);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(description);
  });

  it("keeps runtime metadata passive without package navigation capabilities", async () => {
    const user = userEvent.setup();
    const onRunAllCells = vi.fn();
    render(
      <NotebookCommandToolbar
        capabilities={editableToolbarCapabilities}
        runtime="python"
        environmentManager="conda"
        environmentOutOfSync
        runtimeStatus={runtimeStatus}
        onRunAllCells={onRunAllCells}
        onRestartAndRunAll={() => {}}
        trailingControls={<button type="button">Next control</button>}
      />,
    );

    const indicator = screen.getByTestId("runtime-environment-indicator");
    expect(indicator).toBeVisible();
    expect(indicator.tagName).toBe("SPAN");
    expect(indicator).toHaveTextContent("Python");
    expect(indicator).toHaveAttribute("data-env-manager", "conda");
    expect(indicator).not.toHaveAttribute("title");
    expect(within(indicator).getByText("Python runtime · conda environment")).toHaveClass(
      "sr-only",
    );
    expect(indicator).not.toHaveAttribute("role");
    expect(indicator).not.toHaveAttribute("tabindex");
    expect(indicator.tabIndex).toBe(-1);
    expect(indicator.className).not.toMatch(/hover:|cursor-|ring-/);
    expect(indicator.querySelector("button, a, [tabindex]")).toBeNull();
    expect(screen.queryByRole("button", { name: /Python|environment panel/ })).toBeNull();

    await user.click(indicator);
    await user.keyboard("{Enter} ");
    expect(onRunAllCells).not.toHaveBeenCalled();
    expect(indicator).not.toHaveFocus();

    screen.getByTestId("restart-run-all-button").focus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Next control" })).toHaveFocus();
    expect(screen.getByTestId("kernel-status")).toBeVisible();
    expect(screen.getByTestId("restart-run-all-button")).toHaveAccessibleName(
      "Dependencies changed - restart kernel and run all cells",
    );
  });

  it("can direct eligible users toward workstation setup without a runtime status", () => {
    const onWorkstationSetup = vi.fn();

    render(
      <NotebookCommandToolbar
        capabilities={{
          ...editableToolbarCapabilities,
          canExecute: false,
        }}
        workstationAction={{
          label: "Set up compute",
          title: "Open workstations panel",
          onClick: onWorkstationSetup,
        }}
      />,
    );

    const setupButton = screen.getByTestId("workstation-setup-button");
    expect(setupButton).toHaveAccessibleName("Set up compute");
    expect(setupButton).toHaveAttribute("aria-description", "Open workstations panel");
    expect(setupButton).not.toHaveAttribute("title");

    fireEvent.click(setupButton);

    expect(onWorkstationSetup).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("run-all-button")).toBeNull();
  });

  it("shows pending workstation start without dispatching duplicate requests", async () => {
    const user = userEvent.setup();
    const onWorkstationSetup = vi.fn();

    render(
      <NotebookCommandToolbar
        capabilities={{
          ...editableToolbarCapabilities,
          canExecute: false,
        }}
        workstationAction={{
          label: "Starting",
          pending: true,
          title: "Starting compute on Lab2 workstation",
          onClick: onWorkstationSetup,
        }}
      />,
    );

    const setupButton = screen.getByTestId("workstation-setup-button");
    expect(setupButton).toHaveAccessibleName("Starting");
    expect(setupButton).toHaveAttribute("aria-description", "Starting compute on Lab2 workstation");
    expect(setupButton).toBeDisabled();

    await user.hover(setupButton.parentElement!);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Starting compute on Lab2 workstation",
    );

    fireEvent.click(setupButton);

    expect(onWorkstationSetup).not.toHaveBeenCalled();
  });

  describe("tooltips", () => {
    function renderDesktopToolbar() {
      return render(
        <NotebookCommandToolbar
          capabilities={editableToolbarCapabilities}
          runtime="python"
          environmentManager="conda"
          runtimeStatus={runtimeStatus}
          onAddCell={() => ({ id: "cell-new" })}
          onRunAllCells={() => {}}
          onRestartRuntime={() => {}}
          onRestartAndRunAll={() => {}}
          onInterruptRuntime={() => {}}
          updateAction={{
            label: "Update 2.5.3",
            title: "Prepare to update to v2.5.3",
            onClick: () => {},
          }}
        />,
      );
    }

    it("explains every icon control on hover without native title tooltips", async () => {
      const user = userEvent.setup();
      renderDesktopToolbar();

      expect(screen.getByTestId("notebook-toolbar").querySelectorAll("[title]")).toHaveLength(0);

      const hints: Array<[target: () => HTMLElement, hint: string]> = [
        [() => screen.getByTestId("add-code-cell-button"), "Add code cell"],
        [() => screen.getByTestId("add-markdown-cell-button"), "Add markdown cell"],
        [() => screen.getByTestId("run-all-button"), "Run all cells"],
        [() => screen.getByTestId("restart-kernel-button"), "Restart kernel"],
        [() => screen.getByTestId("restart-run-all-button"), "Restart kernel and run all cells"],
        [() => screen.getByTestId("interrupt-kernel-button"), "Interrupt kernel"],
        [() => screen.getByTestId("update-download-button"), "Prepare to update to v2.5.3"],
        [
          () => screen.getByTestId("runtime-environment-indicator"),
          "Python runtime · conda environment",
        ],
        [() => within(screen.getByTestId("kernel-status")).getByText("idle"), "Kernel is idle"],
      ];
      for (const [target, hint] of hints) {
        await user.hover(target());
        expect((await screen.findByRole("tooltip")).textContent).toBe(hint);
        // jsdom has no layout for Radix's hover grace area, so dismiss before
        // moving to the next control.
        await user.keyboard("{Escape}");
        await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
      }
    });

    it("opens the hint on keyboard focus and closes it on Escape", async () => {
      const user = userEvent.setup();
      renderDesktopToolbar();

      for (const name of [
        "Add code cell",
        "Add markdown cell",
        "Run all cells",
        "Restart kernel",
        "Restart kernel and run all cells",
        "Interrupt kernel",
      ]) {
        await user.tab();
        expect(screen.getByRole("button", { name })).toHaveFocus();
        expect(screen.getByRole("tooltip").textContent).toBe(name);
      }

      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
      expect(screen.getByRole("button", { name: "Interrupt kernel" })).toHaveFocus();
    });

    it("lets Escape reach a focused cell editor while a hover hint is open", async () => {
      const user = userEvent.setup();
      render(
        <>
          <textarea aria-label="Cell editor" />
          <NotebookCommandToolbar
            capabilities={editableToolbarCapabilities}
            runtimeStatus={runtimeStatus}
            onRunAllCells={() => {}}
          />
        </>,
      );
      const editor = screen.getByRole("textbox", { name: "Cell editor" });
      const escapePrevented: boolean[] = [];
      editor.addEventListener("keydown", (event) => {
        if (event.key === "Escape") escapePrevented.push(event.defaultPrevented);
      });
      editor.focus();

      await user.hover(screen.getByTestId("run-all-button"));
      expect(await screen.findByRole("tooltip")).toHaveTextContent("Run all cells");

      // CodeMirror and command mode both ignore an Escape that was already
      // prevented, so the hint must close without claiming the key.
      await user.keyboard("{Escape}");
      expect(escapePrevented).toEqual([false]);
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
      expect(editor).toHaveFocus();
    });

    it("restores the provider delay after a key closes a hover hint", () => {
      vi.useFakeTimers();
      try {
        render(
          <>
            <textarea aria-label="Cell editor" />
            <NotebookCommandToolbar
              capabilities={editableToolbarCapabilities}
              runtimeStatus={runtimeStatus}
              onRunAllCells={() => {}}
              onRestartRuntime={() => {}}
            />
          </>,
        );
        const editor = screen.getByRole("textbox", { name: "Cell editor" });
        editor.focus();
        const advance = (ms: number) =>
          act(() => {
            vi.advanceTimersByTime(ms);
          });

        fireEvent.pointerMove(screen.getByTestId("run-all-button"));
        advance(300);
        expect(screen.getByRole("tooltip").textContent).toBe("Run all cells");

        fireEvent.keyDown(editor, { key: "x" });
        expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

        // Past the provider's skip-delay window, the next hint waits again.
        advance(1000);
        fireEvent.pointerMove(screen.getByTestId("restart-kernel-button"));
        expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
        advance(300);
        expect(screen.getByRole("tooltip").textContent).toBe("Restart kernel");
      } finally {
        vi.useRealTimers();
      }
    });

    it("closes the hint when its control is clicked", async () => {
      const user = userEvent.setup();
      const onRunAllCells = vi.fn();
      render(
        <NotebookCommandToolbar
          capabilities={editableToolbarCapabilities}
          runtimeStatus={runtimeStatus}
          onRunAllCells={onRunAllCells}
        />,
      );

      const runAll = screen.getByTestId("run-all-button");
      await user.hover(runAll);
      await screen.findByRole("tooltip");
      await user.click(runAll);

      expect(onRunAllCells).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    });

    it("keeps the same button element when disabled toggles", () => {
      const props = {
        capabilities: editableToolbarCapabilities,
        onAddCell: () => ({ id: "cell-new" }),
      };
      const { rerender } = render(<NotebookCommandToolbar {...props} addCellControlsDisabled />);
      const disabledButton = screen.getByTestId("add-code-cell-button");
      expect(disabledButton).toBeDisabled();

      rerender(<NotebookCommandToolbar {...props} addCellControlsDisabled={false} />);

      expect(screen.getByTestId("add-code-cell-button")).toBe(disabledButton);
      expect(disabledButton).toBeEnabled();
    });

    it("gives each command button a visible focus ring", () => {
      renderDesktopToolbar();

      for (const button of within(screen.getByTestId("notebook-toolbar")).getAllByRole("button")) {
        expect(button).toHaveClass("focus-visible:ring-1", "focus-visible:ring-ring");
      }
    });

    it("leaves runtime error details to the hover card instead of a tooltip", () => {
      vi.useFakeTimers();
      try {
        const renderStatus = (error?: ReactNode) => (
          <NotebookCommandToolbar
            capabilities={editableToolbarCapabilities}
            runtimeStatus={{
              state: "error",
              label: "error",
              ariaLabel: "Kernel: Error - conda env failed",
              title: "Error - conda env failed",
              error,
            }}
          />
        );
        const hoverLongEnough = (target: HTMLElement) => {
          fireEvent.pointerMove(target);
          act(() => {
            vi.advanceTimersByTime(1000);
          });
        };
        const { rerender } = render(renderStatus());

        hoverLongEnough(within(screen.getByTestId("kernel-status")).getByText("error"));
        expect(screen.getByRole("tooltip").textContent).toBe("Error - conda env failed");

        rerender(renderStatus(<span data-testid="runtime-error-detail">conda env failed</span>));
        hoverLongEnough(screen.getByTestId("runtime-error-detail"));
        expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

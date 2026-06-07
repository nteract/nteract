import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import type { NotebookShellCapabilities } from "../capabilities";
import { readOnlyNotebookShellCapabilities } from "../capabilities";
import { NotebookWorkstationsPanel } from "../NotebookWorkstationsPanel";

const localReadyCapabilities: NotebookShellCapabilities = {
  ...readOnlyNotebookShellCapabilities,
  canExecute: true,
  access: {
    ...readOnlyNotebookShellCapabilities.access,
    level: "owner",
    source: "local",
    actorLabel: "local:kyle/desktop:main",
    identityLabel: "Kyle",
    actor: {
      actorLabel: "local:kyle/desktop:main",
      principal: {
        id: "local:kyle",
        label: "Kyle",
        source: { provider: "local", namespace: "local" },
      },
      operator: { id: "desktop:main", kind: "desktop", label: "Desktop" },
      scope: "owner",
      status: "active",
    },
  },
  runtime: {
    canWriteRuntimeState: true,
    connected: true,
    executionAvailable: true,
    source: "local",
    actorLabel: "local:kyle/runtime:python",
    identityLabel: "Kyle",
    target: {
      kind: "local_daemon",
      status: "ready",
      label: "This machine",
      statusLabel: "Ready",
      detail: "The local daemon is available for this notebook.",
      providerLabel: "Local daemon",
      environmentLabel: "Notebook runtime",
    },
    actor: {
      actorLabel: "local:kyle/runtime:python",
      principal: {
        id: "local:kyle",
        label: "Kyle",
        source: { provider: "local", namespace: "local" },
      },
      operator: { id: "runtime:python", kind: "runtime", label: "Python runtime" },
      scope: "runtime_peer",
      status: "active",
    },
  },
};

describe("NotebookWorkstationsPanel", () => {
  it("renders a local executable runtime with runtime attribution", () => {
    render(<NotebookWorkstationsPanel capabilities={localReadyCapabilities} />);

    expect(screen.getByRole("heading", { name: "This machine" })).toBeVisible();
    expect(screen.getByText("Ready")).toBeVisible();
    expect(screen.getByText("The local daemon is available for this notebook.")).toBeVisible();
    expect(screen.getAllByText("Local daemon")).toHaveLength(2);
    expect(screen.getAllByText("Notebook runtime")).toHaveLength(2);
    expect(screen.getByText("Kyle")).toBeVisible();
    expect(screen.getByText("Python runtime")).toBeVisible();
    expect(screen.getByText("Can run")).toBeVisible();
    expect(screen.getByText("Remote")).toBeVisible();
    expect(screen.getByText("Coming soon")).toBeVisible();
  });

  it("renders cloud rooms without runtime peers as offline workstations", () => {
    const capabilities: NotebookShellCapabilities = {
      ...readOnlyNotebookShellCapabilities,
      access: {
        ...readOnlyNotebookShellCapabilities.access,
        source: "cloud",
        identityLabel: "Kyle",
      },
      runtime: {
        ...readOnlyNotebookShellCapabilities.runtime,
        source: "cloud",
        target: {
          kind: "cloud_workstation",
          status: "offline",
          label: "No workstation attached",
          statusLabel: "Offline",
          detail: "Attach a user-owned workstation to run cells in this room.",
          providerLabel: "Cloud room",
          environmentLabel: "Not attached",
        },
      },
    };

    render(<NotebookWorkstationsPanel capabilities={capabilities} />);

    expect(screen.getByRole("heading", { name: "No workstation attached" })).toBeVisible();
    expect(screen.getByText("Offline")).toBeVisible();
    expect(
      screen.getByText("Attach a user-owned workstation to run cells in this room."),
    ).toBeVisible();
    expect(screen.getAllByText("Cloud room")).toHaveLength(2);
    expect(screen.getByText("Kyle")).toBeVisible();
    expect(screen.getAllByText("Not attached")).toHaveLength(3);
    expect(screen.getByText("Not runnable")).toBeVisible();
    expect(screen.queryByText("Coming soon")).not.toBeInTheDocument();
  });
});

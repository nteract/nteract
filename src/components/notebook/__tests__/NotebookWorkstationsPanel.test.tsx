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

    expect(screen.getByRole("heading", { name: "Local runtime ready" })).toBeVisible();
    expect(screen.getByText("Ready")).toBeVisible();
    expect(screen.getByText("Execution requests are enabled for this notebook.")).toBeVisible();
    expect(screen.getByText("Local")).toBeVisible();
    expect(screen.getByText("Kyle")).toBeVisible();
    expect(screen.getByText("Python runtime")).toBeVisible();
    expect(screen.getByText("Writable")).toBeVisible();
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
      },
    };

    render(<NotebookWorkstationsPanel capabilities={capabilities} />);

    expect(screen.getByRole("heading", { name: "No workstation" })).toBeVisible();
    expect(screen.getByText("Offline")).toBeVisible();
    expect(screen.getByText("No runtime peer is attached to this room.")).toBeVisible();
    expect(screen.getByText("Cloud")).toBeVisible();
    expect(screen.getByText("Kyle")).toBeVisible();
    expect(screen.getByText("Not attached")).toBeVisible();
    expect(screen.getByText("Read-only")).toBeVisible();
  });
});

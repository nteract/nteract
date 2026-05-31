import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import { NotebookEnvironmentSummary } from "../NotebookEnvironmentSummary";
import type { NotebookShellCapabilities } from "../capabilities";
import type { NotebookPackageViewModel } from "../view-model";

const capabilities: NotebookShellCapabilities = {
  canRead: true,
  canEditMarkdown: true,
  canEditCells: true,
  canEditStructure: true,
  canRequestEdit: false,
  canExecute: true,
  canToggleCode: true,
  canViewPackages: true,
  canManagePackages: true,
  canManageSharing: false,
  access: {
    level: "owner",
    source: "local",
    isPublic: false,
    actorLabel: "local:kyle",
    identityLabel: "Kyle",
  },
  auth: {
    canSignIn: false,
    canUseAuthenticatedIdentity: true,
    needsAttention: false,
  },
  runtime: {
    canWriteRuntimeState: true,
    connected: true,
    source: "local",
    actorLabel: "local:kyle/runtime:python",
    identityLabel: "Kyle",
  },
};

const packages: NotebookPackageViewModel = {
  summary: "uv + pixi - 3 packages",
  sections: [
    {
      manager: "uv",
      label: "uv",
      dependencies: ["pandas>=2", "polars"],
      details: [{ label: "Python", values: [">=3.13"] }],
    },
  ],
};

describe("NotebookEnvironmentSummary", () => {
  it("renders runtime, package, sync, and trust facts", () => {
    render(
      <NotebookEnvironmentSummary
        capabilities={capabilities}
        packages={packages}
        runtimeLabel="Python - local runtime ready"
        packageSourceLabel="pyproject.toml"
        syncLabel="dirty - 1 pending change"
        trustLabel="Trusted"
      />,
    );

    expect(screen.getByRole("heading", { name: "Notebook environment" })).toBeVisible();
    expect(screen.getByText("Python - local runtime ready")).toBeVisible();
    expect(screen.getByText("Runtime author: Python")).toBeVisible();
    expect(screen.getByText("uv + pixi - 3 packages")).toBeVisible();
    expect(screen.getByText("pyproject.toml")).toBeVisible();
    expect(screen.getByText("dirty - 1 pending change")).toBeVisible();
    expect(screen.getByText("pandas>=2")).toBeVisible();
  });

  it("shows read-only environment state when package mutation is unavailable", () => {
    render(
      <NotebookEnvironmentSummary
        capabilities={{
          ...capabilities,
          canExecute: false,
          canManagePackages: false,
          access: {
            ...capabilities.access,
            level: "viewer",
            source: "cloud",
            isPublic: true,
          },
        }}
        packages={{ summary: null, sections: [] }}
      />,
    );

    expect(screen.getByText("Public")).toBeVisible();
    expect(screen.getByText("No runtime")).toBeVisible();
    expect(screen.getByText("No package metadata")).toBeVisible();
    expect(screen.getByText("No package manager metadata available.")).toBeVisible();
  });
});

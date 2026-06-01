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
    expect(screen.getByText("Python authors runtime state")).toBeVisible();
    expect(screen.getByText("uv + pixi - 3 packages")).toBeVisible();
    expect(screen.getByText("pyproject.toml")).toBeVisible();
    expect(screen.getByText("dirty - 1 pending change")).toBeVisible();
    expect(screen.getByText("pandas>=2")).toBeVisible();
  });

  it("shows view-only environment state when package management is unavailable", () => {
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
    expect(screen.getByText("No package details")).toBeVisible();
    expect(screen.getByText("No package manager details yet.")).toBeVisible();
  });

  it("can render only environment facts when package details are shown elsewhere", () => {
    render(
      <NotebookEnvironmentSummary
        capabilities={{
          ...capabilities,
          canManagePackages: false,
          access: {
            ...capabilities.access,
            level: "viewer",
            source: "cloud",
            isPublic: true,
          },
        }}
        packages={packages}
        syncLabel="Live sync connected"
        showPackageDetails={false}
      />,
    );

    expect(screen.getByRole("heading", { name: "Notebook environment" })).toBeVisible();
    expect(screen.getByText("Live sync connected")).toBeVisible();
    expect(screen.getByText("Read-only in this notebook")).toBeVisible();
    expect(screen.queryByText("pandas>=2")).toBeNull();
  });

  it("can render from a typed environment surface projection", () => {
    render(
      <NotebookEnvironmentSummary
        capabilities={capabilities}
        packages={packages}
        environment={{
          access: {
            level: "owner",
            source: "local",
            label: "Owner",
            sourceLabel: "desktop host",
            visibilityLabel: "Private",
            isPublic: false,
          },
          runtime: {
            status: "launching",
            label: "Runtime launching",
            detail: "Queued by Desktop",
            muted: false,
          },
          packages: {
            summary: "uv - 2 packages",
            sourceLabel: "pyproject.toml",
            accessLabel: "Editable in this notebook",
            muted: false,
          },
          sync: {
            status: "dirty",
            label: "Package metadata has pending changes",
            muted: false,
          },
          trust: {
            status: "untrusted",
            label: "Untrusted dependencies",
            attention: true,
          },
        }}
        showPackageDetails={false}
      />,
    );

    expect(screen.getByText("Owner access from desktop host.")).toBeVisible();
    expect(screen.getByText("Runtime launching")).toBeVisible();
    expect(screen.getByText("Package metadata has pending changes")).toBeVisible();
    expect(screen.getByText("Untrusted dependencies")).toBeVisible();
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { CondaDependencyHeader } from "../CondaDependencyHeader";
import { DenoDependencyHeader } from "../DenoDependencyHeader";
import { DependencyHeader } from "../DependencyHeader";
import { PackageSpecList, parsePackageSpec } from "../PackageSpecList";
import { PixiDependencyHeader } from "../PixiDependencyHeader";

describe("PackageSpecList", () => {
  it("renders package specs as rail rows", () => {
    render(
      <PackageSpecList values={["pandas>=2", "polars"]} tone="uv" emptyLabel="No dependencies" />,
    );

    expect(screen.getByText("pandas")).toBeVisible();
    expect(screen.getByText(">=2")).toBeVisible();
    expect(screen.getByText("polars")).toBeVisible();
  });

  it("preserves duplicate package rows from separate dependency sections", () => {
    render(<PackageSpecList values={["numpy", "numpy"]} tone="uv" emptyLabel="No dependencies" />);

    expect(screen.getAllByText("numpy")).toHaveLength(2);
  });

  it("exposes row remove actions when mutation is available", () => {
    const onRemove = vi.fn();

    render(
      <PackageSpecList values={["pandas>=2"]} emptyLabel="No dependencies" onRemove={onRemove} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove pandas>=2" }));
    expect(onRemove).toHaveBeenCalledWith("pandas>=2");
  });

  it("splits package names from version constraints", () => {
    expect(parsePackageSpec("scikit-learn>=1.5")).toEqual({
      name: "scikit-learn",
      spec: ">=1.5",
    });
    expect(parsePackageSpec("numpy")).toEqual({ name: "numpy", spec: null });
  });
});

describe("DependencyHeader rail package copy", () => {
  it("splits project environment copy into fact and action lines", () => {
    render(
      <DependencyHeader
        variant="rail"
        dependencies={["pandas"]}
        requiresPython=">=3.12"
        loading={false}
        onAdd={async () => undefined}
        onRemove={async () => undefined}
        onSetRequiresPython={async () => undefined}
        pyprojectInfo={{
          path: "/work/pyproject.toml",
          relative_path: "pyproject.toml",
          has_dependencies: true,
          has_dev_dependencies: false,
          dependency_count: 1,
          project_name: "analysis",
          requires_python: ">=3.12",
          has_venv: false,
        }}
        isUsingProjectEnv
      />,
    );

    expect(screen.getByText("Using")).toBeVisible();
    expect(screen.getAllByText("pyproject.toml").length).toBeGreaterThan(0);
    expect(screen.getByText("Re-initialize after dependency changes.")).toBeVisible();
  });

  it("keeps uv package details visible while read-only", () => {
    render(
      <DependencyHeader
        variant="rail"
        dependencies={["pandas>=2"]}
        requiresPython=">=3.12"
        loading={false}
        readOnly
        onAdd={async () => undefined}
        onRemove={async () => undefined}
        onSetRequiresPython={async () => undefined}
        syncState={{ status: "dirty", added: ["pandas"], removed: [] }}
        onSyncNow={async () => true}
        pyprojectInfo={{
          path: "/work/pyproject.toml",
          relative_path: "pyproject.toml",
          has_dependencies: true,
          has_dev_dependencies: false,
          dependency_count: 1,
          project_name: "analysis",
          requires_python: ">=3.12",
          has_venv: false,
        }}
        onImportFromPyproject={async () => undefined}
        onUseProjectEnv={async () => undefined}
      />,
    );

    expect(screen.getByText("pandas")).toBeVisible();
    expect(screen.getByText(">=2")).toBeVisible();
    expect(screen.getByText("Python:")).toBeVisible();
    expect(screen.queryByTestId("uv-python-input")).not.toBeInTheDocument();
    expect(screen.queryByTestId("deps-add-input")).not.toBeInTheDocument();
    expect(screen.queryByTestId("deps-restart-button")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /remove pandas/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /use project env/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /copy to notebook/i })).not.toBeInTheDocument();
  });
});

describe("read-only package rails", () => {
  it("keeps conda package details visible without mutation controls", () => {
    render(
      <CondaDependencyHeader
        variant="rail"
        dependencies={["scipy"]}
        channels={["conda-forge"]}
        python="3.12"
        loading={false}
        readOnly
        envSource="conda:inline"
        syncState={{ status: "dirty", added: ["scipy"], removed: [] }}
        onAdd={async () => undefined}
        onRemove={async () => undefined}
        onSetChannels={async () => undefined}
        onSetPython={async () => undefined}
        onSyncNow={async () => true}
      />,
    );

    expect(screen.getByText("scipy")).toBeVisible();
    expect(screen.getByText("conda-forge")).toBeVisible();
    expect(screen.getByText("Python:")).toBeVisible();
    expect(screen.queryByTestId("conda-deps-add-input")).not.toBeInTheDocument();
    expect(screen.queryByTestId("deps-restart-button")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /remove scipy/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /remove conda-forge/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^channel$/i })).not.toBeInTheDocument();
  });

  it("keeps Deno package guidance visible but makes settings read-only", () => {
    const onSetFlexibleNpmImports = vi.fn();
    render(
      <DenoDependencyHeader
        variant="rail"
        denoConfigInfo={null}
        flexibleNpmImports
        onSetFlexibleNpmImports={onSetFlexibleNpmImports}
        readOnly
        syncState={{ status: "dirty" }}
        syncing={false}
        onSyncNow={async () => true}
      />,
    );

    expect(screen.getByText("Import modules directly in your code:")).toBeVisible();
    expect(screen.getByRole("checkbox", { name: /auto-install npm packages/i })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /restart/i })).not.toBeInTheDocument();
  });

  it("keeps inline Pixi details visible while read-only", () => {
    render(
      <PixiDependencyHeader
        variant="rail"
        envSource="pixi:inline"
        pixiInfo={null}
        readOnly
        syncState={{ status: "dirty", added: ["numpy"], removed: [] }}
        onSyncNow={async () => true}
      />,
    );

    expect(screen.getByText("No Pixi dependencies yet.")).toBeVisible();
    expect(screen.queryByPlaceholderText("Add conda package...")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /restart/i })).not.toBeInTheDocument();
  });
});

describe("file-backed package rail variants", () => {
  it("renders environment.yml dependencies as read-only rail rows", () => {
    render(
      <CondaDependencyHeader
        variant="rail"
        dependencies={[]}
        channels={[]}
        python={null}
        loading={false}
        envSource="conda:env_yml"
        syncState={null}
        onAdd={async () => undefined}
        onRemove={async () => undefined}
        onSetChannels={async () => undefined}
        onSetPython={async () => undefined}
        onSyncNow={async () => true}
        environmentYmlInfo={{
          path: "/work/environment.yaml",
          relative_path: "environment.yaml",
          name: "analysis",
          has_dependencies: true,
          dependency_count: 2,
          has_pip_dependencies: true,
          pip_dependency_count: 1,
          python: "3.13",
          channels: ["conda-forge"],
        }}
        environmentYmlDeps={{
          path: "/work/environment.yaml",
          relative_path: "environment.yaml",
          name: "analysis",
          dependencies: ["python=3.13", "scipy"],
          pip_dependencies: ["datasets"],
          python: "3.13",
          channels: ["conda-forge"],
        }}
      />,
    );

    expect(screen.getByText("environment.yaml")).toBeVisible();
    expect(screen.getByText("python")).toBeVisible();
    expect(screen.getByText("=3.13")).toBeVisible();
    expect(screen.getByText("scipy")).toBeVisible();
    expect(screen.getByText("datasets")).toBeVisible();
    expect(screen.queryByTestId("conda-deps-add-input")).not.toBeInTheDocument();
  });

  it("renders pixi.toml dependencies as read-only rail rows", () => {
    render(
      <PixiDependencyHeader
        variant="rail"
        envSource="pixi:toml"
        pixiInfo={{
          path: "/work/pixi.toml",
          relative_path: "pixi.toml",
          workspace_name: "analysis",
          dependencies: ["python>=3.13", "numpy"],
          has_dependencies: true,
          dependency_count: 2,
          pypi_dependencies: ["altair"],
          has_pypi_dependencies: true,
          pypi_dependency_count: 1,
          python: ">=3.13",
          channels: ["conda-forge"],
        }}
        syncState={null}
      />,
    );

    expect(screen.getByText("pixi.toml")).toBeVisible();
    expect(screen.getByText("python")).toBeVisible();
    expect(screen.getAllByText(">=3.13").length).toBeGreaterThan(0);
    expect(screen.getByText("numpy")).toBeVisible();
    expect(screen.getByText("altair")).toBeVisible();
    expect(screen.getByText("Channels")).toBeVisible();
    expect(screen.queryByText(/pixi add/)).not.toBeInTheDocument();
  });
});

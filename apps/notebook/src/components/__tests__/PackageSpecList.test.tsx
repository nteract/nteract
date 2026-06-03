import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  CondaDependencyPanel as CondaDependencyHeader,
  DenoDependencyPanel as DenoDependencyHeader,
  PackageSpecList,
  parsePackageSpec,
  UvDependencyPanel as DependencyHeader,
} from "@/components/environment";
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

  it("quiets read-only package rows without redundant markers", () => {
    const { container } = render(
      <PackageSpecList
        values={["nteract", "gremlin ; sys_platform == 'darwin'"]}
        tone="uv"
        emptyLabel="No dependencies"
        framed={false}
      />,
    );

    expect(container.querySelector("svg")).not.toBeInTheDocument();
    expect(container.querySelector(".bg-uv\\/60")).not.toBeInTheDocument();
    expect(screen.getByText("nteract").parentElement).toHaveClass(
      "grid-cols-[minmax(0,1fr)_auto_auto]",
    );
    expect(screen.getByText("nteract")).toBeVisible();
    expect(screen.getByText("gremlin")).toHaveAttribute("title", "gremlin");
    expect(screen.getByText("sys_platform == 'darwin'")).toBeVisible();
    expect(screen.getByText("sys_platform == 'darwin'")).toHaveAttribute(
      "title",
      "sys_platform == 'darwin'",
    );
    expect(screen.getByText("sys_platform == 'darwin'")).not.toHaveClass("truncate");
    expect(screen.getByText("sys_platform == 'darwin'")).toHaveClass("whitespace-normal");
    expect(screen.getByText("sys_platform == 'darwin'")).toHaveClass("col-start-1");
  });

  it("keeps full package specs available when rail text truncates", () => {
    render(
      <PackageSpecList
        values={["nteract-kernel-launcher>=1.2.3"]}
        tone="uv"
        emptyLabel="No dependencies"
        framed={false}
      />,
    );

    expect(screen.getByText("nteract-kernel-launcher")).toHaveAttribute(
      "title",
      "nteract-kernel-launcher",
    );
    expect(screen.getByText(">=1.2.3")).toHaveAttribute("title", ">=1.2.3");
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
    expect(parsePackageSpec("gremlin ; sys_platform == 'darwin'")).toEqual({
      name: "gremlin",
      spec: "sys_platform == 'darwin'",
    });
    expect(parsePackageSpec("pyzmq>=26 ; python_version >= '3.11'")).toEqual({
      name: "pyzmq",
      spec: ">=26 · python_version >= '3.11'",
    });
    expect(
      parsePackageSpec(
        "example @ https://packages.example.test/example;download=1 ; python_version >= '3.11'",
      ),
    ).toEqual({
      name: "example",
      spec: "@ https://packages.example.test/example;download=1 · python_version >= '3.11'",
    });
    expect(parsePackageSpec("example @ https://packages.example.test/example;download=1")).toEqual({
      name: "example",
      spec: "@ https://packages.example.test/example;download=1",
    });
    expect(parsePackageSpec("numpy")).toEqual({ name: "numpy", spec: null });
  });

  it("does not render URL semicolons as environment-marker rows", () => {
    render(
      <PackageSpecList
        values={["example @ https://packages.example.test/example;download=1"]}
        tone="uv"
        emptyLabel="No dependencies"
        framed={false}
      />,
    );

    const urlSpec = screen.getByText("@ https://packages.example.test/example;download=1");
    expect(urlSpec).toBeVisible();
    expect(urlSpec).not.toHaveClass("whitespace-normal");
    expect(urlSpec).toHaveClass("font-mono");
  });
});

describe("DependencyHeader rail package copy", () => {
  it("keeps the package add row shrinkable inside the rail", () => {
    render(
      <DependencyHeader
        variant="rail"
        dependencies={["pandas"]}
        requiresPython=">=3.12"
        loading={false}
        onAdd={async () => undefined}
        onRemove={async () => undefined}
        onSetRequiresPython={async () => undefined}
      />,
    );

    expect(screen.getByTestId("deps-add-input")).toHaveClass("min-w-0");
  });

  it("leaves package counts to the rail title summary", () => {
    render(
      <DependencyHeader
        variant="rail"
        dependencies={["pandas", "polars"]}
        requiresPython=">=3.12"
        loading={false}
        onAdd={async () => undefined}
        onRemove={async () => undefined}
        onSetRequiresPython={async () => undefined}
      />,
    );

    expect(screen.queryByText("2 packages")).not.toBeInTheDocument();
  });

  it("describes dirty dependencies without overstating all packages as new", () => {
    render(
      <DependencyHeader
        variant="rail"
        dependencies={[
          "pandas",
          "polars",
          "matplotlib",
          "plotly",
          "altair",
          "vega_datasets",
          "kyle",
        ]}
        requiresPython=">=3.13"
        loading={false}
        syncState={{
          status: "dirty",
          added: ["pandas", "polars", "matplotlib", "plotly", "altair", "vega_datasets", "kyle"],
          removed: [],
        }}
        onSyncNow={async () => true}
        onAdd={async () => undefined}
        onRemove={async () => undefined}
        onSetRequiresPython={async () => undefined}
      />,
    );

    expect(
      screen.getByText("Re-initialize the environment to apply dependency changes."),
    ).toBeVisible();
    expect(screen.queryByText(/7 new packages/)).not.toBeInTheDocument();
  });

  it("stacks pyproject actions under the file label in the rail", () => {
    const { container } = render(
      <DependencyHeader
        variant="rail"
        dependencies={["pandas"]}
        requiresPython=">=3.12"
        loading={false}
        onAdd={async () => undefined}
        onRemove={async () => undefined}
        onSetRequiresPython={async () => undefined}
        onImportFromPyproject={async () => undefined}
        onUseProjectEnv={async () => undefined}
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
      />,
    );

    const banner = container.querySelector('[data-slot="deps-pyproject-banner"]');
    const actions = container.querySelector('[data-slot="deps-pyproject-actions"]');

    expect(banner?.firstElementChild).toHaveClass("flex-col");
    expect(actions).toHaveClass("pl-5");
    expect(actions).toHaveTextContent("Use project env");
    expect(actions).toHaveTextContent("Copy to notebook");
  });

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
    expect(screen.queryByText("0 packages")).not.toBeInTheDocument();
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
    expect(screen.getByText("Project")).toBeVisible();
    expect(screen.queryByText("0 packages")).not.toBeInTheDocument();
    expect(screen.getByText("python")).toBeVisible();
    expect(screen.getAllByText(">=3.13").length).toBeGreaterThan(0);
    expect(screen.getByText("numpy")).toBeVisible();
    expect(screen.getByText("altair")).toBeVisible();
    expect(screen.getByText("Channels")).toBeVisible();
    expect(screen.queryByText(/pixi add/)).not.toBeInTheDocument();
  });
});

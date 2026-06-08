import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  clearNotebookLaunchEnvironmentProjectionCacheForTests,
  clearNotebookWorkstationSelectionProjectionCacheForTests,
  DEFAULT_RUNTIME_STATE,
  projectNotebookLaunchEnvironment,
  projectNotebookWorkstationSelection,
  type NotebookRegisteredWorkstation,
} from "../src";

const lab2Workstation: NotebookRegisteredWorkstation = {
  id: "ws-lab2",
  displayName: "Lab2 workstation",
  provider: "runtime_peer",
  defaultEnvironmentLabel: "Current Python",
  environmentPolicy: "current_python",
  status: "online",
  workingDirectory: "/home/ubuntu/codex/nteract",
  environments: [
    {
      id: "current-python",
      label: "Current Python",
      policy: "current_python",
      available: true,
      isDefault: true,
    },
    {
      id: "python-data",
      label: "Python data env",
      policy: "managed_project",
      detail: "pyproject.toml",
      available: true,
    },
  ],
};

beforeEach(() => {
  clearNotebookLaunchEnvironmentProjectionCacheForTests();
  clearNotebookWorkstationSelectionProjectionCacheForTests();
});

describe("notebook launch environment projection", () => {
  it("projects kernelspec and notebook dependency metadata separately from workstations", () => {
    const metadata = {
      kernelspec: {
        name: "python3",
        display_name: "Python 3",
        language: "python",
      },
      language_info: {
        name: "Python",
      },
      runt: {
        uv: {
          dependencies: ["pandas", "polars"],
          "requires-python": ">=3.12",
        },
      },
    };
    const first = projectNotebookLaunchEnvironment({ metadata });
    const second = projectNotebookLaunchEnvironment({ metadata: { ...metadata } });

    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.options)).toBe(true);
    expect(first.runtimeKind).toBe("python");
    expect(first.kernelSpec).toEqual({
      displayName: "Python 3",
      language: "python",
      name: "python3",
    });
    expect(first.options.map((option) => [option.id, option.kind, option.source])).toEqual([
      ["kernelspec:python3", "kernelspec", "kernelspec"],
      ["notebook:uv", "notebook_metadata", "uv"],
    ]);
    expect(first.options.find((option) => option.id === "notebook:uv")).toMatchObject({
      detail: "2 packages · Python >=3.12",
      label: "uv notebook environment",
    });
  });

  it("keeps RuntimeStateDoc active env_source and project context as distinct options", () => {
    const projection = projectNotebookLaunchEnvironment({
      runtimeState: {
        ...DEFAULT_RUNTIME_STATE,
        kernel: {
          ...DEFAULT_RUNTIME_STATE.kernel,
          env_source: "uv:inline",
          language: "python",
        },
        project_context: {
          state: "Detected",
          observed_at: "2026-06-08T00:00:00Z",
          project_file: {
            kind: "PyprojectToml",
            absolute_path: "/home/ubuntu/project/pyproject.toml",
            relative_to_notebook: "pyproject.toml",
          },
          parsed: {
            dependencies: ["pandas"],
            dev_dependencies: ["pytest"],
            extras: { kind: "None" },
            prerelease: null,
            requires_python: ">=3.12",
          },
        },
      },
    });

    expect(projection.activeOption).toMatchObject({
      id: "runtime:uv:inline",
      kind: "running_kernel",
      selected: true,
      source: "uv",
    });
    expect(projection.defaultOption).toBe(projection.activeOption);
    expect(projection.options.map((option) => option.id)).toEqual([
      "runtime:uv:inline",
      "project:PyprojectToml:pyproject.toml",
    ]);
    expect(projection.options[1]).toMatchObject({
      detail: "2 packages · Python >=3.12",
      label: "pyproject.toml environment",
      source: "uv",
    });
  });

  it("projects workstation default and available environments without treating them as attached", () => {
    const selection = projectNotebookWorkstationSelection({
      canSelectWorkstation: true,
      defaultWorkstationId: "ws-lab2",
      registeredWorkstations: [lab2Workstation],
    });
    const projection = projectNotebookLaunchEnvironment({ selection });

    expect(projection.activeOption).toBeNull();
    expect(projection.defaultOption).toMatchObject({
      id: "workstation:ws-lab2:default",
      kind: "workstation_default",
      label: "Current Python",
      source: "current_python",
      isDefault: true,
      available: true,
    });
    expect(projection.options.map((option) => option.id)).toEqual([
      "workstation:ws-lab2:default",
      "workstation:ws-lab2:environment:current-python",
      "workstation:ws-lab2:environment:python-data",
    ]);
  });

  it("projects Deno notebook metadata as what starts, not where it starts", () => {
    const projection = projectNotebookLaunchEnvironment({
      metadata: {
        kernelspec: {
          name: "deno",
          display_name: "Deno",
          language: "typescript",
        },
        runt: {
          deno: {
            permissions: ["net"],
            flexible_npm_imports: true,
          },
        },
      },
    });

    expect(projection.runtimeKind).toBe("deno");
    expect(projection.options.map((option) => [option.id, option.source])).toEqual([
      ["kernelspec:deno", "kernelspec"],
      ["notebook:deno", "deno"],
    ]);
  });
});

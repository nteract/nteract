import { describe, expect, it } from "vite-plus/test";
import {
  borrowedEnvironmentKind,
  projectRunningEnvironment,
  type RunningEnvironmentFacts,
} from "../local-environment-projection";

function facts(overrides: Partial<RunningEnvironmentFacts> = {}): RunningEnvironmentFacts {
  return {
    lifecycle: "Running",
    envSource: "kernelspec",
    environmentId: "kernelspec:julia-1.11",
    environmentName: "Julia 1.11",
    pythonVersion: undefined,
    language: "julia",
    ...overrides,
  };
}

describe("borrowedEnvironmentKind", () => {
  it("treats existing Conda and installed kernelspecs as borrowed, everything else as managed", () => {
    expect(borrowedEnvironmentKind("conda:existing:local")).toBe("conda");
    expect(borrowedEnvironmentKind("kernelspec")).toBe("kernelspec");
    for (const managed of ["uv:prewarmed", "conda:inline", "pixi:toml", "deno", "", null, undefined])
      expect(borrowedEnvironmentKind(managed)).toBeNull();
  });
});

describe("projectRunningEnvironment", () => {
  it("names a running installed kernel by display name and language", () => {
    expect(projectRunningEnvironment(facts())).toEqual({
      id: "kernelspec:julia-1.11",
      name: "Julia 1.11",
      pythonVersion: null,
      language: "julia",
    });
  });

  it("reports nothing running for every lifecycle except Running", () => {
    for (const lifecycle of ["NotStarted", "Resolving", "Launching", "Error", "Shutdown", ""])
      expect(projectRunningEnvironment(facts({ lifecycle }))).toBeNull();
  });

  it("keeps Python facts and no language for managed and Conda environments", () => {
    expect(
      projectRunningEnvironment(
        facts({
          envSource: "conda:existing:local",
          environmentId: "rankings",
          environmentName: "rankings",
          pythonVersion: "3.12",
          language: "python",
        }),
      ),
    ).toEqual({ id: "rankings", name: "rankings", pythonVersion: "3.12", language: null });
    expect(
      projectRunningEnvironment(
        facts({
          envSource: "uv:prewarmed",
          environmentId: undefined,
          environmentName: undefined,
          language: "python",
        }),
      ),
    ).toEqual({ id: null, name: "uv:prewarmed", pythonVersion: null, language: null });
  });

  it("falls back without inventing an identity when the daemon sent no name", () => {
    expect(
      projectRunningEnvironment(
        facts({ environmentId: "", environmentName: "", language: "" }),
      ),
    ).toEqual({ id: null, name: "Jupyter kernel", pythonVersion: null, language: null });
    expect(
      projectRunningEnvironment(
        facts({ envSource: undefined, environmentId: undefined, environmentName: undefined }),
      ),
    ).toMatchObject({ id: null, name: "Automatic environment" });
  });
});

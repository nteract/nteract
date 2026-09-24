import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { usePyodideDependencies } from "../usePyodideDependencies";

const mocks = vi.hoisted(() => ({
  addExecutionDependency: vi.fn().mockResolvedValue(undefined),
  removeExecutionDependency: vi.fn().mockResolvedValue(undefined),
  runtimeInstalled: [] as string[],
  dependencies: [] as string[],
}));

vi.mock("../../lib/notebook-metadata", () => ({
  addExecutionDependency: mocks.addExecutionDependency,
  removeExecutionDependency: mocks.removeExecutionDependency,
  useExecutionDependencies: () => ({ dependencies: mocks.dependencies, profile: null }),
}));

vi.mock("../../lib/runtime-state", () => ({
  useRuntimeState: () => ({
    env: { runtime_installed: mocks.runtimeInstalled },
  }),
}));

describe("usePyodideDependencies", () => {
  it("promotes runtime-installed packages into declared metadata", async () => {
    mocks.addExecutionDependency.mockClear();
    mocks.dependencies = ["six"];
    mocks.runtimeInstalled = ["six", "attrs"];

    renderHook(() => usePyodideDependencies());

    await waitFor(() => {
      expect(mocks.addExecutionDependency).toHaveBeenCalledWith("attrs");
    });
    // Already-declared entries are not re-added.
    expect(mocks.addExecutionDependency).not.toHaveBeenCalledWith("six");
  });

  it("does nothing when every capture is already declared", async () => {
    mocks.addExecutionDependency.mockClear();
    mocks.dependencies = ["six"];
    mocks.runtimeInstalled = ["six"];

    renderHook(() => usePyodideDependencies());

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.addExecutionDependency).not.toHaveBeenCalled();
  });
});

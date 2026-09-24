import { describe, expect, it, vi } from "vite-plus/test";
import { addPyodidePackageWithRollback } from "../pyodide-package-add";

function setup(overrides: Partial<Parameters<typeof addPyodidePackageWithRollback>[0]> = {}) {
  const addDependency = vi.fn().mockResolvedValue(undefined);
  const removeDependency = vi.fn().mockResolvedValue(undefined);
  const syncEnvironment = vi
    .fn()
    .mockResolvedValue({ result: "sync_environment_complete", synced_packages: ["requests"] });
  return {
    addDependency,
    removeDependency,
    syncEnvironment,
    options: {
      pkg: "requests",
      declaredBefore: [] as string[],
      addDependency,
      removeDependency,
      syncEnvironment,
      ...overrides,
    },
  };
}

describe("addPyodidePackageWithRollback", () => {
  it("keeps the declaration when the install succeeds", async () => {
    const { options, removeDependency } = setup();

    const result = await addPyodidePackageWithRollback(options);

    expect(options.addDependency).toHaveBeenCalledWith("requests");
    expect(removeDependency).not.toHaveBeenCalled();
    expect(result).toEqual({ rolledBack: false });
  });

  it("rolls the declaration back when the install fails", async () => {
    const onFailure = vi.fn();
    const { options, removeDependency, syncEnvironment } = setup({ onFailure });
    syncEnvironment.mockResolvedValue({
      result: "sync_environment_failed",
      error: "Package 'request' could not be resolved",
      needs_restart: false,
    });

    const result = await addPyodidePackageWithRollback(options);

    expect(onFailure).toHaveBeenCalledWith("Package 'request' could not be resolved");
    expect(removeDependency).toHaveBeenCalledWith("requests");
    expect(result).toEqual({ rolledBack: true });
  });

  it("never removes a requirement that was already declared", async () => {
    const { options, removeDependency, syncEnvironment } = setup({
      declaredBefore: ["requests"],
    });
    syncEnvironment.mockResolvedValue({
      result: "sync_environment_failed",
      error: "network failure",
      needs_restart: false,
    });

    const result = await addPyodidePackageWithRollback(options);

    expect(removeDependency).not.toHaveBeenCalled();
    expect(result).toEqual({ rolledBack: false });
  });

  it("reports a rollback error without throwing", async () => {
    const rollbackError = new Error("daemon unavailable");
    const { options, removeDependency, syncEnvironment } = setup();
    syncEnvironment.mockResolvedValue({
      result: "sync_environment_failed",
      error: "bad package",
      needs_restart: false,
    });
    removeDependency.mockRejectedValue(rollbackError);

    const result = await addPyodidePackageWithRollback(options);

    expect(result).toEqual({ rolledBack: false, rollbackError });
  });
});

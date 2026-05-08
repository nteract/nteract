import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_POOL_STATE,
  type PoolState,
  resetPoolState,
  setPoolState,
} from "../../lib/pool-state";
import { usePoolState } from "../usePoolState";

function stateWithErrors(overrides: Partial<PoolState>): PoolState {
  return {
    uv: { ...DEFAULT_POOL_STATE.uv },
    conda: { ...DEFAULT_POOL_STATE.conda },
    pixi: { ...DEFAULT_POOL_STATE.pixi },
    ...overrides,
  };
}

describe("usePoolState", () => {
  afterEach(() => {
    resetPoolState();
  });

  it("hides transient retry errors from inactive package managers", () => {
    act(() => {
      setPoolState(
        stateWithErrors({
          pixi: {
            ...DEFAULT_POOL_STATE.pixi,
            error: "Pixi environment creation failed: failed to fetch matplotlib",
            error_kind: "setup_failed",
            consecutive_failures: 1,
            retry_in_secs: 30,
          },
        }),
      );
    });

    const { result } = renderHook(() => usePoolState("uv"));

    expect(result.current.pixiError).toBeNull();
    expect(result.current.hasErrors).toBe(false);
  });

  it("shows transient retry errors for the active package manager", () => {
    act(() => {
      setPoolState(
        stateWithErrors({
          pixi: {
            ...DEFAULT_POOL_STATE.pixi,
            error: "Pixi environment creation failed: failed to fetch matplotlib",
            error_kind: "setup_failed",
            consecutive_failures: 1,
            retry_in_secs: 30,
          },
        }),
      );
    });

    const { result } = renderHook(() => usePoolState("pixi"));

    expect(result.current.pixiError?.message).toContain("Pixi environment creation failed");
    expect(result.current.hasErrors).toBe(true);
  });

  it("keeps actionable inactive-manager errors visible", () => {
    act(() => {
      setPoolState(
        stateWithErrors({
          pixi: {
            ...DEFAULT_POOL_STATE.pixi,
            error: "Pixi package not found",
            error_kind: "invalid_package",
            failed_package: "not-a-package",
            consecutive_failures: 1,
            retry_in_secs: 0,
          },
        }),
      );
    });

    const { result } = renderHook(() => usePoolState("uv"));

    expect(result.current.pixiError?.failed_package).toBe("not-a-package");
    expect(result.current.hasErrors).toBe(true);
  });
});

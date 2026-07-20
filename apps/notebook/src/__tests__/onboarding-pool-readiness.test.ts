import { describe, expect, it } from "vitest";
import type { PoolState, RuntimePoolState } from "runtimed";
import {
  hasOnboardingPoolError,
  isOnboardingPoolReady,
  onboardingPoolErrorMessage,
} from "../../onboarding/pool-readiness";

const DEFAULT_RUNTIME_POOL: RuntimePoolState = {
  available: 0,
  warming: 0,
  pool_size: 1,
  consecutive_failures: 0,
  retry_in_secs: 0,
};

function runtimePool(overrides: Partial<RuntimePoolState>): RuntimePoolState {
  return { ...DEFAULT_RUNTIME_POOL, ...overrides };
}

function poolState(pythonEnv: keyof PoolState, overrides: Partial<RuntimePoolState>): PoolState {
  return {
    uv: runtimePool({}),
    conda: runtimePool({}),
    pixi: runtimePool({}),
    [pythonEnv]: runtimePool(overrides),
  };
}

describe("onboarding pool readiness", () => {
  it("does not treat a warming selected pool as ready", () => {
    expect(isOnboardingPoolReady("uv", poolState("uv", { warming: 1, pool_size: 2 }))).toBe(false);
  });

  it("does not treat an idle empty selected pool as ready", () => {
    expect(isOnboardingPoolReady("uv", poolState("uv", { pool_size: 2 }))).toBe(false);
  });

  it("treats the selected pool as ready when at least one env is available", () => {
    expect(
      isOnboardingPoolReady("uv", poolState("uv", { available: 1, warming: 1, pool_size: 2 })),
    ).toBe(true);
  });

  it("treats a disabled selected pool as ready", () => {
    expect(isOnboardingPoolReady("uv", poolState("uv", { pool_size: 0 }))).toBe(true);
  });
});

describe("onboarding pool error", () => {
  it("flags a failed pool with a recorded error", () => {
    expect(
      hasOnboardingPoolError(
        "conda",
        poolState("conda", {
          consecutive_failures: 2,
          error: "warm-env timed out after 900s",
        }),
      ),
    ).toBe(true);
  });

  it("does not flag an error while still warming without a failure", () => {
    expect(hasOnboardingPoolError("conda", poolState("conda", { warming: 1 }))).toBe(false);
  });

  it("does not flag an error once an env is available", () => {
    expect(
      hasOnboardingPoolError(
        "conda",
        poolState("conda", {
          available: 1,
          consecutive_failures: 3,
          error: "stale error",
        }),
      ),
    ).toBe(false);
  });

  it("does not flag a failure with no recorded message", () => {
    expect(hasOnboardingPoolError("conda", poolState("conda", { consecutive_failures: 1 }))).toBe(
      false,
    );
  });

  it("names the failed package for invalid_package errors", () => {
    expect(
      onboardingPoolErrorMessage(
        "Conda",
        runtimePool({
          error_kind: "invalid_package",
          failed_package: "bogus-pkg",
          error: "No solution found",
        }),
      ),
    ).toContain("bogus-pkg");
  });

  it("gives a network-friendly message for timeouts", () => {
    const message = onboardingPoolErrorMessage(
      "Conda",
      runtimePool({
        error_kind: "timeout",
        error: "warm-env subprocess timed out after 900s",
      }),
    );
    expect(message).toContain("timed out");
    expect(message).toContain("retrying");
  });

  it("falls back to the raw error detail", () => {
    expect(
      onboardingPoolErrorMessage(
        "UV",
        runtimePool({
          error_kind: "setup_failed",
          error: "disk full",
        }),
      ),
    ).toContain("disk full");
  });
});

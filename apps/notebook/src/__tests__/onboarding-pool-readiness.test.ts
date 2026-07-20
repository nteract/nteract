import { describe, expect, it } from "vitest";
import {
  hasOnboardingPoolError,
  isOnboardingPoolReady,
  onboardingPoolErrorMessage,
} from "../../onboarding/pool-readiness";

describe("onboarding pool readiness", () => {
  it("does not treat a warming selected pool as ready", () => {
    expect(
      isOnboardingPoolReady("uv", {
        uv: { available: 0, warming: 1, pool_size: 2 },
      }),
    ).toBe(false);
  });

  it("does not treat an idle empty selected pool as ready", () => {
    expect(
      isOnboardingPoolReady("uv", {
        uv: { available: 0, warming: 0, pool_size: 2 },
      }),
    ).toBe(false);
  });

  it("treats the selected pool as ready when at least one env is available", () => {
    expect(
      isOnboardingPoolReady("uv", {
        uv: { available: 1, warming: 1, pool_size: 2 },
      }),
    ).toBe(true);
  });

  it("treats a disabled selected pool as ready", () => {
    expect(
      isOnboardingPoolReady("uv", {
        uv: { available: 0, warming: 0, pool_size: 0 },
      }),
    ).toBe(true);
  });
});

describe("onboarding pool error", () => {
  it("flags a failed pool with a recorded error", () => {
    expect(
      hasOnboardingPoolError("conda", {
        conda: {
          available: 0,
          warming: 0,
          pool_size: 1,
          consecutive_failures: 2,
          error: "warm-env timed out after 900s",
        },
      }),
    ).toBe(true);
  });

  it("does not flag an error while still warming without a failure", () => {
    expect(
      hasOnboardingPoolError("conda", {
        conda: { available: 0, warming: 1, pool_size: 1 },
      }),
    ).toBe(false);
  });

  it("does not flag an error once an env is available", () => {
    expect(
      hasOnboardingPoolError("conda", {
        conda: {
          available: 1,
          warming: 0,
          pool_size: 1,
          consecutive_failures: 3,
          error: "stale error",
        },
      }),
    ).toBe(false);
  });

  it("does not flag a failure with no recorded message", () => {
    expect(
      hasOnboardingPoolError("conda", {
        conda: { available: 0, warming: 0, pool_size: 1, consecutive_failures: 1 },
      }),
    ).toBe(false);
  });

  it("names the failed package for invalid_package errors", () => {
    expect(
      onboardingPoolErrorMessage("Conda", {
        error_kind: "invalid_package",
        failed_package: "bogus-pkg",
        error: "No solution found",
      }),
    ).toContain("bogus-pkg");
  });

  it("gives a network-friendly message for timeouts", () => {
    const message = onboardingPoolErrorMessage("Conda", {
      error_kind: "timeout",
      error: "warm-env subprocess timed out after 900s",
    });
    expect(message).toContain("timed out");
    expect(message).toContain("retrying");
  });

  it("falls back to the raw error detail", () => {
    expect(
      onboardingPoolErrorMessage("UV", {
        error_kind: "setup_failed",
        error: "disk full",
      }),
    ).toContain("disk full");
  });
});

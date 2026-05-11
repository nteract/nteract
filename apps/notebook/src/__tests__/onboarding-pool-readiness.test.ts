import { describe, expect, it } from "vitest";
import { isOnboardingPoolReady } from "../../onboarding/pool-readiness";

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
});

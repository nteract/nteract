import { describe, expect, it } from "vite-plus/test";
import { stableCacheKey } from "../src/projection-cache";

describe("stableCacheKey", () => {
  it("keeps undefined distinct from null", () => {
    expect(stableCacheKey([undefined])).not.toBe(stableCacheKey([null]));
    expect(stableCacheKey([{ value: undefined }])).not.toBe(stableCacheKey([{ value: null }]));
  });
});

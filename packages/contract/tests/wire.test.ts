// @vitest-environment node
import { describe, expect, it } from "vite-plus/test";
import {
  FrameType,
  MAX_FRAME_SIZE,
  frameSizeLimits,
  type FrameTypeValue,
} from "@runtimed/contract/wire";

describe("@runtimed/contract/wire", () => {
  it("assigns the request frame type byte", () => {
    expect(FrameType.REQUEST).toBe(0x01);
  });

  it("gives every frame type a size cap no larger than the frame maximum", () => {
    const values = Object.values(FrameType) as FrameTypeValue[];
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      const limits = frameSizeLimits(value);
      expect(limits.cap).toBeGreaterThan(0);
      expect(limits.cap).toBeLessThanOrEqual(MAX_FRAME_SIZE);
    }
  });
});

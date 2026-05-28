import { describe, expect, it } from "vite-plus/test";
import {
  _remoteCursorFlagOverlapsText,
  _remoteCursorFlagRect,
  _remoteCursorRectsIntersect,
} from "../remote-cursors";

describe("remote cursor flag geometry", () => {
  it("projects the flag above the cursor bar", () => {
    const rect = _remoteCursorFlagRect("peer", 100, 50);

    expect(rect).not.toBeNull();
    expect(rect?.left).toBe(99);
    expect(rect?.right).toBeGreaterThan(100);
    expect(rect?.top).toBeLessThan(50);
    expect(rect?.bottom).toBe(49);
  });

  it("detects when the projected flag overlaps visible text", () => {
    expect(
      _remoteCursorFlagOverlapsText("peer", 100, 50, [
        { left: 96, right: 140, top: 35, bottom: 48 },
      ]),
    ).toBe(true);
  });

  it("allows the flag when nearby text is outside the projected flag", () => {
    expect(
      _remoteCursorFlagOverlapsText("peer", 100, 50, [
        { left: 96, right: 140, top: 55, bottom: 70 },
      ]),
    ).toBe(false);
  });

  it("uses padding when checking visual crowding", () => {
    const flag = { left: 0, right: 10, top: 0, bottom: 10 };
    const nearbyText = { left: 11, right: 20, top: 0, bottom: 10 };

    expect(_remoteCursorRectsIntersect(flag, nearbyText)).toBe(false);
    expect(_remoteCursorRectsIntersect(flag, nearbyText, 2)).toBe(true);
  });
});

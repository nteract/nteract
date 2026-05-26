import { describe, expect, it, vi } from "vite-plus/test";
import {
  outputFrameContainerDimensions,
  outputFrameDisplayHeight,
  sameOutputFrameContainerDimensions,
  undefinedIfEmptyContainerDimensions,
} from "../output-frame-sizing";

describe("output frame sizing policy", () => {
  it("grows to measured content when auto height is enabled", () => {
    expect(outputFrameDisplayHeight(2600.2, { autoHeight: true, maxHeight: 400 })).toBe(2601);
  });

  it("caps measured content when auto height is disabled", () => {
    expect(outputFrameDisplayHeight(900, { autoHeight: false, maxHeight: 400 })).toBe(400);
  });

  it("honors a minimum height for React-managed frames", () => {
    expect(outputFrameDisplayHeight(4, { autoHeight: false, maxHeight: 400, minHeight: 24 })).toBe(
      24,
    );
  });

  it("advertises width and capped-height policy as host context dimensions", () => {
    const iframe = document.createElement("iframe");
    vi.spyOn(iframe, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 321.4,
      bottom: 0,
      left: 0,
      width: 321.4,
      height: 120,
      toJSON: () => ({}),
    });

    expect(
      outputFrameContainerDimensions(iframe, {
        autoHeight: false,
        maxHeight: 640,
      }),
    ).toEqual({ width: 321, maxHeight: 640 });
  });

  it("can preserve IsolatedFrame's undefined empty-dimensions state", () => {
    expect(undefinedIfEmptyContainerDimensions({})).toBeUndefined();
    expect(sameOutputFrameContainerDimensions(undefined, {})).toBe(true);
    expect(sameOutputFrameContainerDimensions({ width: 320 }, { width: 321 })).toBe(false);
  });
});

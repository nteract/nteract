import { afterEach, describe, expect, it } from "vite-plus/test";
import { measureDocumentHeight } from "../layout-measure";

function defineElementSize(element: HTMLElement, height: number) {
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    value: height,
  });
  Object.defineProperty(element, "offsetHeight", {
    configurable: true,
    value: height,
  });
  element.getBoundingClientRect = () =>
    ({
      top: 0,
      bottom: height,
      left: 0,
      right: 100,
      width: 100,
      height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
}

describe("measureDocumentHeight", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("prefers root content height over viewport-sized body scroll height", () => {
    document.body.innerHTML = '<div id="root"></div>';
    const root = document.getElementById("root") as HTMLElement;

    defineElementSize(root, 720);
    defineElementSize(document.body, 1200);
    defineElementSize(document.documentElement, 1200);

    expect(measureDocumentHeight()).toBe(722);
  });

  it("falls back to document height when root is absent", () => {
    defineElementSize(document.body, 900);
    defineElementSize(document.documentElement, 1200);

    expect(measureDocumentHeight()).toBe(1202);
  });
});

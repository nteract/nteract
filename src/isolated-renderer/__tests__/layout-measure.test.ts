import { afterEach, describe, expect, it } from "vite-plus/test";
import { measureDocumentHeight } from "../layout-measure";

function defineElementSize(element: HTMLElement, height: number, top = 0) {
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
      top,
      bottom: top + height,
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

  it("accounts for rendered descendants when root scroll height is stale", () => {
    document.body.innerHTML = '<div id="root"><div id="content">markdown</div></div>';
    const root = document.getElementById("root") as HTMLElement;
    const content = document.getElementById("content") as HTMLElement;

    defineElementSize(root, 24);
    defineElementSize(content, 42, 8);
    content.style.marginBottom = "16px";

    expect(measureDocumentHeight()).toBe(68);
  });

  it("falls back to document height when root is absent", () => {
    defineElementSize(document.body, 900);
    defineElementSize(document.documentElement, 1200);

    expect(measureDocumentHeight()).toBe(1202);
  });
});

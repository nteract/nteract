import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { findVerticalScrollAncestor, scrollFrameWheelBoundary } from "../scroll-boundary";

function setScrollMetrics(element: HTMLElement, scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    value: scrollHeight,
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    value: clientHeight,
  });
}

describe("scroll-boundary", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("finds the nearest vertical scroll ancestor", () => {
    const outer = document.createElement("div");
    outer.style.overflowY = "auto";
    setScrollMetrics(outer, 1000, 200);

    const inner = document.createElement("div");
    const iframe = document.createElement("iframe");
    inner.appendChild(iframe);
    outer.appendChild(inner);
    document.body.appendChild(outer);

    expect(findVerticalScrollAncestor(iframe.parentElement)).toBe(outer);
  });

  it("scrolls the nearest vertical scroll ancestor by the wheel delta", () => {
    const scrollContainer = document.createElement("div");
    scrollContainer.style.overflowY = "auto";
    setScrollMetrics(scrollContainer, 1000, 200);
    scrollContainer.scrollTop = 300;
    scrollContainer.scrollBy = vi.fn();

    const output = document.createElement("div");
    const iframe = document.createElement("iframe");
    output.appendChild(iframe);
    scrollContainer.appendChild(output);
    document.body.appendChild(scrollContainer);

    scrollFrameWheelBoundary(iframe, { deltaY: -160 });

    expect(scrollContainer.scrollBy).toHaveBeenCalledWith({
      top: -160,
      behavior: "auto",
    });
  });

  it("normalizes line-mode wheel deltas before scrolling the ancestor", () => {
    const scrollContainer = document.createElement("div");
    scrollContainer.style.overflowY = "auto";
    setScrollMetrics(scrollContainer, 1000, 200);
    scrollContainer.scrollTop = 300;
    scrollContainer.scrollBy = vi.fn();

    const iframe = document.createElement("iframe");
    scrollContainer.appendChild(iframe);
    document.body.appendChild(scrollContainer);

    scrollFrameWheelBoundary(iframe, { deltaY: 3, deltaMode: 1 });

    expect(scrollContainer.scrollBy).toHaveBeenCalledWith({
      top: 48,
      behavior: "auto",
    });
  });

  it("normalizes page-mode wheel deltas from the iframe height", () => {
    const scrollContainer = document.createElement("div");
    scrollContainer.style.overflowY = "auto";
    setScrollMetrics(scrollContainer, 2000, 200);
    scrollContainer.scrollTop = 300;
    scrollContainer.scrollBy = vi.fn();

    const iframe = document.createElement("iframe");
    Object.defineProperty(iframe, "clientHeight", {
      configurable: true,
      value: 320,
    });
    scrollContainer.appendChild(iframe);
    document.body.appendChild(scrollContainer);

    scrollFrameWheelBoundary(iframe, { deltaY: 1, deltaMode: 2 });

    expect(scrollContainer.scrollBy).toHaveBeenCalledWith({
      top: 320,
      behavior: "auto",
    });
  });

  it("does not scroll the nearest ancestor past its top edge", () => {
    const scrollContainer = document.createElement("div");
    scrollContainer.style.overflowY = "auto";
    setScrollMetrics(scrollContainer, 1000, 200);
    scrollContainer.scrollTop = 0;
    scrollContainer.scrollBy = vi.fn();

    const iframe = document.createElement("iframe");
    scrollContainer.appendChild(iframe);
    document.body.appendChild(scrollContainer);

    scrollFrameWheelBoundary(iframe, { deltaY: -160 });

    expect(scrollContainer.scrollBy).not.toHaveBeenCalled();
  });

  it("does not scroll the nearest ancestor past its bottom edge", () => {
    const scrollContainer = document.createElement("div");
    scrollContainer.style.overflowY = "auto";
    setScrollMetrics(scrollContainer, 1000, 200);
    scrollContainer.scrollTop = 800;
    scrollContainer.scrollBy = vi.fn();

    const iframe = document.createElement("iframe");
    scrollContainer.appendChild(iframe);
    document.body.appendChild(scrollContainer);

    scrollFrameWheelBoundary(iframe, { deltaY: 160 });

    expect(scrollContainer.scrollBy).not.toHaveBeenCalled();
  });

  it("scrolls the next ancestor when the nearest scroll ancestor is at a boundary", () => {
    const notebookScroller = document.createElement("div");
    notebookScroller.style.overflowY = "auto";
    setScrollMetrics(notebookScroller, 2000, 600);
    notebookScroller.scrollTop = 200;
    notebookScroller.scrollBy = vi.fn();

    const outputWell = document.createElement("div");
    outputWell.style.overflowY = "auto";
    setScrollMetrics(outputWell, 1000, 400);
    outputWell.scrollTop = 600;
    outputWell.scrollBy = vi.fn();

    const iframe = document.createElement("iframe");
    outputWell.appendChild(iframe);
    notebookScroller.appendChild(outputWell);
    document.body.appendChild(notebookScroller);

    scrollFrameWheelBoundary(iframe, { deltaY: 160 });

    expect(outputWell.scrollBy).not.toHaveBeenCalled();
    expect(notebookScroller.scrollBy).toHaveBeenCalledWith({
      top: 160,
      behavior: "auto",
    });
  });

  it("falls back to the owning window when no scroll ancestor exists", () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    Object.defineProperty(window, "scrollY", {
      configurable: true,
      value: 300,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 200,
    });
    setScrollMetrics(document.documentElement, 1000, 200);
    const scrollBy = vi.fn();
    Object.defineProperty(window, "scrollBy", {
      configurable: true,
      value: scrollBy,
    });

    scrollFrameWheelBoundary(iframe, { deltaY: 80 });

    expect(scrollBy).toHaveBeenCalledWith({
      top: 80,
      behavior: "auto",
    });
  });

  it("does not scroll the owning window past its top edge", () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    Object.defineProperty(window, "scrollY", {
      configurable: true,
      value: 0,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 200,
    });
    setScrollMetrics(document.documentElement, 1000, 200);
    const scrollBy = vi.fn();
    Object.defineProperty(window, "scrollBy", {
      configurable: true,
      value: scrollBy,
    });

    scrollFrameWheelBoundary(iframe, { deltaY: -80 });

    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("ignores missing or non-finite deltas", () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const scrollBy = vi.fn();
    Object.defineProperty(window, "scrollBy", {
      configurable: true,
      value: scrollBy,
    });

    scrollFrameWheelBoundary(iframe, {});
    scrollFrameWheelBoundary(iframe, { deltaY: Number.NaN });

    expect(scrollBy).not.toHaveBeenCalled();
  });
});

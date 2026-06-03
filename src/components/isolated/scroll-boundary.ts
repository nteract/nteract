import type { NteractWheelBoundaryParams } from "./rpc-methods";

const WHEEL_DELTA_LINE = 1;
const WHEEL_DELTA_PAGE = 2;
const DEFAULT_WHEEL_LINE_HEIGHT = 16;

function hasScrollableOverflow(element: HTMLElement): boolean {
  const { overflowY } = window.getComputedStyle(element);
  return overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
}

function canScrollVertically(element: HTMLElement): boolean {
  return hasScrollableOverflow(element) && element.scrollHeight > element.clientHeight + 1;
}

function canConsumeScrollDelta(element: HTMLElement, deltaY: number): boolean {
  if (deltaY < 0) {
    return element.scrollTop > 0;
  }

  return element.scrollTop + element.clientHeight < element.scrollHeight - 1;
}

function canWindowConsumeScrollDelta(win: Window, deltaY: number): boolean {
  const doc = win.document.documentElement;
  const scrollTop = win.scrollY || doc.scrollTop;
  const viewportHeight = win.innerHeight;
  const scrollHeight = Math.max(doc.scrollHeight, win.document.body?.scrollHeight ?? 0);

  if (deltaY < 0) {
    return scrollTop > 0;
  }

  return scrollTop + viewportHeight < scrollHeight - 1;
}

export function findVerticalScrollAncestor(start: Element | null): HTMLElement | null {
  let element = start instanceof HTMLElement ? start : (start?.parentElement ?? null);

  while (element) {
    if (canScrollVertically(element)) {
      return element;
    }
    element = element.parentElement;
  }

  return null;
}

function findVerticalScrollConsumer(start: Element | null, deltaY: number): HTMLElement | null {
  let element = start instanceof HTMLElement ? start : (start?.parentElement ?? null);

  while (element) {
    if (canScrollVertically(element) && canConsumeScrollDelta(element, deltaY)) {
      return element;
    }
    element = element.parentElement;
  }

  return null;
}

export function scrollFrameWheelBoundary(
  iframe: HTMLIFrameElement | null,
  params: NteractWheelBoundaryParams,
): void {
  const deltaY = normalizedWheelDeltaY(iframe, params);

  if (deltaY === 0) {
    return;
  }

  const scrollTarget = findVerticalScrollConsumer(iframe?.parentElement ?? null, deltaY);
  if (scrollTarget) {
    scrollTarget.scrollBy({ top: deltaY, behavior: "auto" });
    return;
  }

  const win = iframe?.ownerDocument.defaultView;
  if (win && canWindowConsumeScrollDelta(win, deltaY)) {
    win.scrollBy({ top: deltaY, behavior: "auto" });
  }
}

function normalizedWheelDeltaY(
  iframe: HTMLIFrameElement | null,
  params: NteractWheelBoundaryParams,
): number {
  const rawDeltaY =
    typeof params.deltaY === "number" && Number.isFinite(params.deltaY) ? params.deltaY : 0;
  if (rawDeltaY === 0) {
    return 0;
  }

  if (params.deltaMode === WHEEL_DELTA_LINE) {
    return rawDeltaY * wheelLineHeight(iframe);
  }

  if (params.deltaMode === WHEEL_DELTA_PAGE) {
    return rawDeltaY * wheelPageHeight(iframe);
  }

  return rawDeltaY;
}

function wheelLineHeight(iframe: HTMLIFrameElement | null): number {
  const ownerWindow = iframe?.ownerDocument.defaultView ?? window;
  const rawLineHeight = ownerWindow.getComputedStyle(
    iframe?.ownerDocument.documentElement ?? document.documentElement,
  ).lineHeight;
  const parsedLineHeight = Number.parseFloat(rawLineHeight);
  return Number.isFinite(parsedLineHeight) && parsedLineHeight > 0
    ? parsedLineHeight
    : DEFAULT_WHEEL_LINE_HEIGHT;
}

function wheelPageHeight(iframe: HTMLIFrameElement | null): number {
  const ownerWindow = iframe?.ownerDocument.defaultView ?? window;
  return Math.max(1, iframe?.clientHeight || ownerWindow.innerHeight || 0);
}

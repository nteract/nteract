import type { NteractMeasureElementResult } from "@/components/isolated/rpc-methods";
import type { IsolatedFrameHandle } from "@/components/isolated/isolated-frame";
import { findVerticalScrollAncestor } from "@/components/isolated/scroll-boundary";

export interface MarkdownHeadingNavigatorOptions {
  behavior?: ScrollBehavior;
}

export type MarkdownHeadingNavigator = (
  headingAnchorId: string,
  options?: MarkdownHeadingNavigatorOptions,
) => Promise<boolean>;

const navigators = new Map<string, MarkdownHeadingNavigator>();

export function registerMarkdownHeadingNavigator(
  cellId: string,
  navigator: MarkdownHeadingNavigator,
): () => void {
  navigators.set(cellId, navigator);
  return () => {
    if (navigators.get(cellId) === navigator) {
      navigators.delete(cellId);
    }
  };
}

export async function navigateMarkdownHeading(
  cellId: string,
  headingAnchorId: string,
  options?: MarkdownHeadingNavigatorOptions,
): Promise<boolean> {
  const navigator = navigators.get(cellId);
  if (!navigator) return false;
  try {
    return await navigator(headingAnchorId, options);
  } catch {
    return false;
  }
}

export function isMeasuredElementFound(
  result: NteractMeasureElementResult | null,
): result is NteractMeasureElementResult & { found: true; top: number; height: number } {
  return (
    result?.found === true &&
    typeof result.top === "number" &&
    Number.isFinite(result.top) &&
    typeof result.height === "number" &&
    Number.isFinite(result.height)
  );
}

export async function scrollIsolatedMarkdownHeading({
  frame,
  root,
  headingAnchorId,
  behavior = "smooth",
}: {
  frame: IsolatedFrameHandle | null;
  root: HTMLElement | null;
  headingAnchorId: string;
  behavior?: ScrollBehavior;
}): Promise<boolean> {
  if (!headingAnchorId || !frame?.isReady) return false;

  const measurement = await frame.measureElement(headingAnchorId);
  if (!isMeasuredElementFound(measurement)) return false;

  const iframe = root?.querySelector<HTMLIFrameElement>('iframe[data-slot="isolated-frame"]');
  if (!iframe) return false;

  const topPadding = 16;
  const iframeRect = iframe.getBoundingClientRect();
  const scrollContainer = findVerticalScrollAncestor(iframe.parentElement ?? iframe);

  if (scrollContainer) {
    const containerRect = scrollContainer.getBoundingClientRect();
    scrollContainer.scrollTo({
      top: Math.max(
        0,
        scrollContainer.scrollTop +
          iframeRect.top -
          containerRect.top +
          measurement.top -
          topPadding,
      ),
      behavior,
    });
    return true;
  }

  window.scrollTo({
    top: Math.max(0, window.scrollY + iframeRect.top + measurement.top - topPadding),
    behavior,
  });
  return true;
}

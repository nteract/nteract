import type { NteractMeasureElementResult } from "@/components/isolated/rpc-methods";

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

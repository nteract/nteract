import type { NteractEmbedContainerDimensions } from "./host-context";

export const DEFAULT_OUTPUT_FRAME_MAX_HEIGHT = 2000;
export const DEFAULT_OUTPUT_FRAME_MIN_HEIGHT = 24;

export interface OutputFrameSizingPolicy {
  autoHeight: boolean;
  maxHeight: number;
  minHeight?: number;
}

export function outputFrameDisplayHeight(
  contentHeight: number,
  { autoHeight, maxHeight, minHeight = 1 }: OutputFrameSizingPolicy,
): number {
  const measuredHeight = Math.max(minHeight, Math.ceil(contentHeight));
  return autoHeight ? measuredHeight : Math.min(maxHeight, measuredHeight);
}

export function outputFrameContainerDimensions(
  iframe: HTMLIFrameElement | null,
  { autoHeight, maxHeight }: OutputFrameSizingPolicy,
): NteractEmbedContainerDimensions {
  const dimensions: NteractEmbedContainerDimensions = {};
  const width = iframe ? Math.round(iframe.getBoundingClientRect().width) : 0;
  if (width > 0) {
    dimensions.width = width;
  }
  if (!autoHeight && Number.isFinite(maxHeight)) {
    dimensions.maxHeight = maxHeight;
  }
  return dimensions;
}

export function undefinedIfEmptyContainerDimensions(
  dimensions: NteractEmbedContainerDimensions,
): NteractEmbedContainerDimensions | undefined {
  return Object.keys(dimensions).length > 0 ? dimensions : undefined;
}

export function sameOutputFrameContainerDimensions(
  a: NteractEmbedContainerDimensions | undefined,
  b: NteractEmbedContainerDimensions | undefined,
): boolean {
  return (
    (a?.width ?? null) === (b?.width ?? null) &&
    (a?.maxWidth ?? null) === (b?.maxWidth ?? null) &&
    (a?.height ?? null) === (b?.height ?? null) &&
    (a?.maxHeight ?? null) === (b?.maxHeight ?? null)
  );
}

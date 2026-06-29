import { notebookCellAnchorId } from "runtimed";

export interface NotebookScrollAnchorCandidate {
  anchorId: string;
  cellId: string;
  top: number;
  bottom: number;
}

export interface NotebookScrollAnchorSnapshot {
  anchorId: string;
  cellId: string;
  offsetFromContainerTop: number;
}

export interface SelectNotebookScrollAnchorOptions {
  excludedCellIds?: ReadonlySet<string>;
  viewportHeight: number;
}

export interface TailPinnedInput {
  cellCount: number;
  containerScrollHeight: number;
  containerClientHeight: number;
  containerScrollTop: number;
  containerTop: number;
  containerBottom: number;
  lastCellTop: number | null;
  lastCellBottom: number | null;
  thresholdPx: number;
}

export function selectTopVisibleCellAnchor(
  candidates: readonly NotebookScrollAnchorCandidate[],
  options: SelectNotebookScrollAnchorOptions,
): NotebookScrollAnchorCandidate | null {
  const excluded = options.excludedCellIds ?? new Set<string>();
  const visible = candidates.filter(
    (candidate) =>
      !excluded.has(candidate.cellId) &&
      candidate.bottom > 0 &&
      candidate.top < options.viewportHeight,
  );
  if (visible.length === 0) return null;

  const crossingTop = visible
    .filter((candidate) => candidate.top <= 0 && candidate.bottom > 0)
    .sort((left, right) => right.top - left.top)[0];
  if (crossingTop) return crossingTop;

  return visible.sort((left, right) => left.top - right.top)[0] ?? null;
}

export function selectCellDeletionScrollAnchor(
  candidates: readonly NotebookScrollAnchorCandidate[],
  visualCellIds: readonly string[],
  deletedCellId: string,
  viewportHeight: number,
): NotebookScrollAnchorSnapshot | null {
  const topVisible = selectTopVisibleCellAnchor(candidates, { viewportHeight });
  if (topVisible && topVisible.cellId !== deletedCellId) {
    return snapshotFromCandidate(topVisible);
  }

  if (topVisible?.cellId === deletedCellId) {
    const fallback = deletionFallbackCandidate(candidates, visualCellIds, deletedCellId);
    if (fallback) {
      return {
        anchorId: fallback.anchorId,
        cellId: fallback.cellId,
        offsetFromContainerTop: topVisible.top,
      };
    }
  }

  const nonDeleted = selectTopVisibleCellAnchor(candidates, {
    viewportHeight,
    excludedCellIds: new Set([deletedCellId]),
  });
  return nonDeleted ? snapshotFromCandidate(nonDeleted) : null;
}

export function shouldTailFollowCellCountChange(
  previousCellCount: number,
  nextCellCount: number,
  tailPinned: boolean,
): boolean {
  return tailPinned && nextCellCount > previousCellCount;
}

export function isNotebookTailPinned(input: TailPinnedInput): boolean {
  if (input.cellCount === 0) return false;

  const distanceFromTail =
    input.containerScrollHeight - input.containerClientHeight - input.containerScrollTop;
  if (distanceFromTail <= input.thresholdPx) return true;

  if (input.lastCellTop === null || input.lastCellBottom === null) return false;
  return (
    input.lastCellBottom >= input.containerTop &&
    input.lastCellTop <= input.containerBottom &&
    input.lastCellBottom >= input.containerBottom - input.thresholdPx
  );
}

export function captureCellDeletionScrollAnchor(
  container: HTMLElement | null,
  visualCellIds: readonly string[],
  deletedCellId: string,
): NotebookScrollAnchorSnapshot | null {
  if (!container) return null;
  return selectCellDeletionScrollAnchor(
    cellAnchorCandidates(container, visualCellIds),
    visualCellIds,
    deletedCellId,
    container.getBoundingClientRect().height,
  );
}

export function restoreScrollAnchor(
  container: HTMLElement | null,
  snapshot: NotebookScrollAnchorSnapshot | null,
): boolean {
  if (!container || !snapshot) return false;
  const target = elementByIdWithin(container, snapshot.anchorId);
  if (!target) return false;

  const containerTop = container.getBoundingClientRect().top;
  const targetTop = target.getBoundingClientRect().top;
  container.scrollTop += targetTop - containerTop - snapshot.offsetFromContainerTop;
  return true;
}

export function scrollToDocumentAnchor(
  container: HTMLElement | null,
  anchorId: string,
  options: ScrollIntoViewOptions = {},
): boolean {
  if (!container) return false;
  const target = elementByIdWithin(container, anchorId);
  if (!target) return false;
  scrollElementIntoView(target, {
    block: options.block ?? "nearest",
    behavior: options.behavior ?? "auto",
    inline: options.inline,
  });
  return true;
}

export function scrollElementIntoView(element: Element, options: ScrollIntoViewOptions = {}): void {
  element.scrollIntoView({
    block: options.block ?? "nearest",
    behavior: options.behavior ?? "auto",
    inline: options.inline,
  });
}

export function scrollToNotebookTail(container: HTMLElement | null): boolean {
  if (!container) return false;
  container.scrollTop = container.scrollHeight;
  return true;
}

function snapshotFromCandidate(
  candidate: NotebookScrollAnchorCandidate,
): NotebookScrollAnchorSnapshot {
  return {
    anchorId: candidate.anchorId,
    cellId: candidate.cellId,
    offsetFromContainerTop: candidate.top,
  };
}

function deletionFallbackCandidate(
  candidates: readonly NotebookScrollAnchorCandidate[],
  visualCellIds: readonly string[],
  deletedCellId: string,
): NotebookScrollAnchorCandidate | null {
  const deletedIndex = visualCellIds.indexOf(deletedCellId);
  if (deletedIndex < 0) return null;
  for (let index = deletedIndex + 1; index < visualCellIds.length; index++) {
    const candidate = candidates.find((entry) => entry.cellId === visualCellIds[index]);
    if (candidate) return candidate;
  }
  for (let index = deletedIndex - 1; index >= 0; index--) {
    const candidate = candidates.find((entry) => entry.cellId === visualCellIds[index]);
    if (candidate) return candidate;
  }
  return null;
}

function cellAnchorCandidates(
  container: HTMLElement,
  visualCellIds: readonly string[],
): NotebookScrollAnchorCandidate[] {
  const containerTop = container.getBoundingClientRect().top;
  return visualCellIds.flatMap((cellId) => {
    const anchorId = notebookCellAnchorId(cellId);
    const element = elementByIdWithin(container, anchorId);
    if (!element) return [];
    const rect = element.getBoundingClientRect();
    return [
      {
        anchorId,
        cellId,
        top: rect.top - containerTop,
        bottom: rect.bottom - containerTop,
      },
    ];
  });
}

function elementByIdWithin(container: HTMLElement, id: string): HTMLElement | null {
  const element = container.ownerDocument.getElementById(id);
  if (!(element instanceof HTMLElement)) return null;
  return container.contains(element) ? element : null;
}

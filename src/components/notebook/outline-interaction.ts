import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  notebookCellAnchorId,
  resolveNotebookOutlineSelection,
  type NotebookOutlineItem,
} from "runtimed";
import { setSelectedNotebookOutlineItemId, useNotebookRailUiState } from "./state/rail-ui-state";

/**
 * Tracks the active outline item based on scroll position and visibility.
 * Uses IntersectionObserver + scroll/resize listeners over cell anchors.
 *
 * @param items - Outline items from the notebook view model
 * @param cellIds - Ordered cell IDs from the notebook
 * @param enabled - Whether the outline is visible (disables tracking when false)
 * @returns The ID of the currently active outline item, or null
 */
export function useActiveOutlineItemId(
  items: readonly NotebookOutlineItem[],
  cellIds: readonly string[],
  enabled: boolean,
): string | null {
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const itemsRef = useRef(items);
  const cellIdsRef = useRef(cellIds);
  const itemIdsKey = useMemo(() => items.map((item) => item.id).join("\n"), [items]);
  const cellIdsKey = useMemo(() => cellIds.join("\n"), [cellIds]);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    cellIdsRef.current = cellIds;
  }, [cellIds]);

  useEffect(() => {
    if (!enabled || itemIdsKey.length === 0 || cellIdsKey.length === 0) {
      setActiveItemId(null);
      return;
    }

    let frame: number | null = null;
    const visibleCellIds = new Set<string>();
    const observedCellIds = new Map<Element, string>();
    const anchorTop = 96;

    const measure = () => {
      frame = null;
      let currentCellId: string | null = null;
      let firstUpcomingCellId: string | null = null;
      let firstUpcomingTop = Number.POSITIVE_INFINITY;
      const currentCellIds = cellIdsRef.current;
      const candidateCellIds =
        visibleCellIds.size > 0
          ? currentCellIds.filter((cellId) => visibleCellIds.has(cellId))
          : currentCellIds;

      for (const cellId of candidateCellIds) {
        const target = document.getElementById(notebookCellAnchorId(cellId));
        if (!target) continue;

        const rect = target.getBoundingClientRect();
        if (rect.bottom < anchorTop) continue;

        if (rect.top <= anchorTop) {
          currentCellId = cellId;
        } else if (rect.top < firstUpcomingTop) {
          firstUpcomingTop = rect.top;
          firstUpcomingCellId = cellId;
        }
      }

      const nextCellId = currentCellId ?? firstUpcomingCellId;
      const nextItemId = nextCellId
        ? resolveNotebookOutlineSelection(itemsRef.current, {
            selectedCellId: nextCellId,
            cellIds: currentCellIds,
          })
        : null;
      setActiveItemId((current) => (current === nextItemId ? current : nextItemId));
    };

    const scheduleMeasure = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(measure);
    };

    scheduleMeasure();
    const observer =
      "IntersectionObserver" in window
        ? new IntersectionObserver(
            (entries) => {
              for (const entry of entries) {
                const cellId = observedCellIds.get(entry.target);
                if (!cellId) continue;
                if (entry.isIntersecting) {
                  visibleCellIds.add(cellId);
                } else {
                  visibleCellIds.delete(cellId);
                }
              }
              scheduleMeasure();
            },
            { rootMargin: `-${anchorTop}px 0px 0px 0px`, threshold: [0, 0.01] },
          )
        : null;

    if (observer) {
      for (const cellId of cellIdsRef.current) {
        const target = document.getElementById(notebookCellAnchorId(cellId));
        if (!target) continue;
        observedCellIds.set(target, cellId);
        observer.observe(target);
      }
    }

    document.addEventListener("scroll", scheduleMeasure, true);
    window.addEventListener("resize", scheduleMeasure);

    return () => {
      observer?.disconnect();
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
      document.removeEventListener("scroll", scheduleMeasure, true);
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, [cellIdsKey, enabled, itemIdsKey]);

  return activeItemId;
}

/**
 * Manages outline selection state and focus coupling.
 * Clears selection when focus moves to a cell not matching the selected outline item.
 * Optionally couples outline selection to focused cell ID (when setFocusedCellId is provided).
 *
 * @param options.outlineItems - Outline items from the notebook view model
 * @param options.focusedCellId - Currently focused cell ID (or null)
 * @param options.setFocusedCellId - Optional callback to set focused cell (enables focus coupling)
 * @returns Selection state and handler
 */
export function useOutlineSelection(options: {
  outlineItems: readonly NotebookOutlineItem[];
  focusedCellId: string | null;
  setFocusedCellId?: (cellId: string) => void;
}): {
  selectedOutlineItemId: string | null;
  handleSelectOutlineItem: (item: NotebookOutlineItem) => void;
} {
  const { outlineItems, focusedCellId, setFocusedCellId } = options;
  const { selectedOutlineItemId } = useNotebookRailUiState();

  // Clear selection when focus moves to a different cell
  useEffect(() => {
    if (!selectedOutlineItemId) return;
    const selectedOutlineItem = outlineItems.find((item) => item.id === selectedOutlineItemId);
    if (
      !selectedOutlineItem ||
      (focusedCellId !== null && focusedCellId !== selectedOutlineItem.cellId)
    ) {
      setSelectedNotebookOutlineItemId(null);
    }
  }, [focusedCellId, outlineItems, selectedOutlineItemId]);

  const handleSelectOutlineItem = useCallback(
    (item: NotebookOutlineItem) => {
      setSelectedNotebookOutlineItemId(item.id);
      setFocusedCellId?.(item.cellId);
    },
    [setFocusedCellId],
  );

  return { selectedOutlineItemId, handleSelectOutlineItem };
}

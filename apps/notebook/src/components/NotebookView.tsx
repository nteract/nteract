import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS as DndCSS } from "@dnd-kit/utilities";
import { Eye, EyeOff, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { notebookCellAnchorId, type NotebookInteractionTarget } from "runtimed";
import { CellInsertionRibbon, type CellInsertionType } from "@/components/cell/CellInsertionRibbon";
import { CellSkeleton } from "@/components/cell/CellSkeleton";
import { Button } from "@/components/ui/button";
import type { NteractEmbedHostContextPatch } from "@/components/isolated/host-context";
import type { NotebookShellCapabilities } from "@/components/notebook";
import type { MarkdownHeadingAnchor } from "@/components/outputs/markdown-heading-anchors";
import type { Runtime } from "@/hooks/useSyncedSettings";
import { ErrorBoundary } from "@/lib/error-boundary";
import { cn } from "@/lib/utils";
import type { TracebackCellTarget } from "@/components/outputs/traceback-output";
import { usePresenceContext } from "@/components/notebook/presence-context";
import { EditorRegistryProvider, useEditorRegistry } from "../hooks/useEditorRegistry";
import {
  flushCellUIState,
  setActiveInteractionTarget,
  useFocusedCellId,
  useSearchCurrentMatch,
} from "@/components/notebook/state/cell-ui-state";
import {
  clearOutputFocusedCellId,
  setOutputFocusedCellId,
  useOutputFocusedCellId,
} from "@/components/notebook/state/output-focus-store";
import { logger } from "../lib/logger";
import { useOutputProjectionFailures } from "@/components/notebook/state/runtime-store-projection";
import { computeCanMutateCells } from "@/components/notebook/mutation-gate";
import {
  getCellById,
  getNotebookCellsSnapshot,
  useCell,
  useMaterializeVersion,
} from "@/components/notebook/state/cell-store";
import {
  getCellOutputsSnapshot,
  subscribeOutputsVersion,
  useOutputStructureVersion,
} from "@/components/notebook/state/output-store";
import type { CodeCell as CodeCellType, NotebookCell } from "../types";
import { CodeCell, type HiddenGroupCellSummary } from "./CodeCell";
import { MarkdownCell } from "./MarkdownCell";
import { RawCell } from "./RawCell";
import type {
  SourceCommentSelectionRect,
  SourceRangeCommentAnchor,
} from "../lib/comment-source-anchor";

type AddCellResult = NotebookCell | null;
type AddCellHandler = (type: CellInsertionType, afterCellId?: string | null) => AddCellResult;

export interface NotebookViewProps {
  cellIds: string[];
  isLoading?: boolean;
  capabilities?: NotebookShellCapabilities;
  canAcceptCellMutations?: boolean;
  readOnly?: boolean;
  loadError?: string | null;
  runtime?: Runtime | null;
  sessionRuntimeState?: string | null;
  onFocusCell: (cellId: string) => void;
  onExecuteCell: (cellId: string) => void;
  onRequestExecuteCell?: (cellId: string) => void;
  onInterruptKernel: () => void;
  onDeleteCell: (cellId: string) => void;
  onUpdateCellSource?: (cellId: string, source: string) => void;
  onAddCell: AddCellHandler;
  onMoveCell: (cellId: string, afterCellId?: string | null) => void;
  onReportOutputMatchCount?: (cellId: string, count: number) => void;
  onSetCellSourceHidden?: (cellId: string, hidden: boolean) => void;
  onSetCellOutputsHidden?: (cellId: string, hidden: boolean) => void;
  onCreateSourceComment?: (
    anchor: SourceRangeCommentAnchor,
    rect: SourceCommentSelectionRect | null,
  ) => void;
  onActivateCommentThread?: (threadId: string) => void;
  markdownHeadingAnchorsByCellId?: ReadonlyMap<string, readonly MarkdownHeadingAnchor[]>;
  outputHostContext?: NteractEmbedHostContextPatch;
  deferOutputIsolatedFramesUntilVisible?: boolean;
  deferredOutputIsolatedFrameRootMargin?: string;
  autoFocusFirstCell?: boolean;
}

const NOTEBOOK_TAIL_SPACE = "clamp(4rem, 10vh, 6rem)";
const NOTEBOOK_TAIL_PIN_THRESHOLD_PX = 96;

function CellAdder({
  afterCellId,
  onAdd,
  terminal = false,
}: {
  afterCellId?: string | null;
  onAdd: AddCellHandler;
  terminal?: boolean;
}) {
  return <CellInsertionRibbon terminal={terminal} onInsert={(type) => onAdd(type, afterCellId)} />;
}

function CellErrorFallback({
  error,
  onRetry,
  onDelete,
}: {
  error: Error;
  onRetry: () => void;
  onDelete?: () => void;
}) {
  return (
    <div className="mx-4 my-2 rounded-md border border-destructive/50 bg-destructive/5 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-destructive">This cell encountered an error</p>
          <p className="mt-1 truncate text-xs text-muted-foreground">{error.message}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={onRetry}
            className="h-7 gap-1 px-2 text-xs"
            title="Retry rendering"
          >
            <RotateCcw className="h-3 w-3" />
            Retry
          </Button>
          {onDelete ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={onDelete}
              className="h-7 gap-1 px-2 text-xs text-destructive hover:text-destructive"
              title="Delete cell"
            >
              <X className="h-3 w-3" />
              Delete
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Index card preview shown when dragging a cell */
function CellDragPreview({ cellId }: { cellId: string }) {
  const cell = useCell(cellId);
  if (!cell) return null;

  // Get first 3 lines of source, truncated
  const sourceLines = cell.source.split("\n").slice(0, 3);
  const hasMoreLines = cell.source.split("\n").length > 3;
  const hasOutputs = cell.cell_type === "code" && (cell as CodeCellType).outputs.length > 0;

  // Ribbon color based on cell type
  const ribbonColor =
    cell.cell_type === "code"
      ? "bg-sky-400 dark:bg-sky-500"
      : cell.cell_type === "raw"
        ? "bg-rose-400 dark:bg-rose-500"
        : "bg-emerald-400 dark:bg-emerald-500";

  return (
    <div className="w-80 rounded-lg bg-background shadow-2xl ring-1 ring-border/50 rotate-1 scale-[1.02] overflow-hidden">
      <div className="flex">
        <div className={cn("w-1 flex-shrink-0", ribbonColor)} />
        <div className="flex-1 p-3 min-w-0">
          {sourceLines.length > 0 && sourceLines[0] !== "" ? (
            <pre className="text-xs text-foreground font-mono whitespace-pre overflow-hidden">
              {sourceLines.map((line, i) => (
                <span key={i} className="block truncate">
                  {line || " "}
                </span>
              ))}
            </pre>
          ) : (
            <p className="text-xs text-muted-foreground italic">Empty cell</p>
          )}
          {(hasMoreLines || hasOutputs) && (
            <div className="mt-2 flex items-center gap-2 text-[10px] text-muted-foreground">
              {hasMoreLines && <span>...</span>}
              {hasOutputs && (
                <span className="rounded bg-muted px-1.5 py-0.5">
                  {(cell as CodeCellType).outputs.length} output
                  {(cell as CodeCellType).outputs.length !== 1 ? "s" : ""}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Check if a cell has both source and outputs hidden via metadata.
 *  We intentionally don't check outputs.length so cells stay collapsed
 *  when outputs are transiently cleared during re-execution. */
function isCellFullyHidden(cell: NotebookCell): boolean {
  if (cell.cell_type !== "code") return false;
  const jupyter = cell.metadata?.jupyter as
    | { source_hidden?: boolean; outputs_hidden?: boolean }
    | undefined;
  if (!jupyter?.source_hidden) return false;
  // Fully hidden when source is hidden AND either outputs are explicitly
  // hidden or there are no outputs to show. Read outputs from the
  // per-output store (source of truth post Phase C-lite) rather than
  // `cell.outputs`, which the frame pipeline no longer updates on
  // output-only frames.
  if (jupyter.outputs_hidden === true) return true;
  return getCellOutputsSnapshot(cell.id).length === 0;
}

function hiddenGroupCellSummary(
  cell: NotebookCell,
  outputCount: number,
  hasError: boolean,
): HiddenGroupCellSummary {
  const firstLine = cell.source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  return {
    id: cell.id,
    preview: firstLine ?? "empty cell",
    outputCount,
    hasError,
  };
}

/**
 * Per-cell subscriber component. Uses useCell(id) so it only re-renders
 * when this specific cell changes — not when other cells change.
 */
const CellRenderer = memo(function CellRenderer({
  cellId,
  index,
  renderCell,
  dragHandleProps,
  isDragging,
}: {
  cellId: string;
  index: number;
  renderCell: (
    cell: NotebookCell,
    index: number,
    dragHandleProps?: Record<string, unknown>,
    isDragging?: boolean,
  ) => React.ReactNode;
  dragHandleProps?: Record<string, unknown>;
  isDragging?: boolean;
}) {
  const cell = useCell(cellId);
  if (!cell) return null;
  return <>{renderCell(cell, index, dragHandleProps, isDragging)}</>;
});

/** Wrapper component for sortable cells */
function SortableCell({
  cellId,
  index,
  renderCell,
  onAddCell,
  onDeleteCell,
  isLastCell,
  isHiddenInGroup,
  canMutateCells,
}: {
  cellId: string;
  index: number;
  renderCell: (
    cell: NotebookCell,
    index: number,
    dragHandleProps?: Record<string, unknown>,
    isDragging?: boolean,
  ) => React.ReactNode;
  onAddCell: AddCellHandler;
  onDeleteCell: (cellId: string) => void;
  isLastCell?: boolean;
  isHiddenInGroup?: boolean;
  canMutateCells: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: cellId,
    disabled: !canMutateCells,
  });

  const style: React.CSSProperties = {
    transform: DndCSS.Transform.toString(transform),
    transition,
    order: index,
  };
  const anchorId = notebookCellAnchorId(cellId);

  // Combine listeners and attributes for the drag handle
  // This enables keyboard-initiated dragging (Space/Enter + arrows)
  const dragHandleProps = canMutateCells
    ? {
        ...listeners,
        ...attributes,
      }
    : undefined;

  if (isHiddenInGroup) {
    return <div id={anchorId} ref={setNodeRef} style={style} />;
  }

  return (
    <div id={anchorId} ref={setNodeRef} style={style}>
      {canMutateCells && index === 0 && <CellAdder afterCellId={null} onAdd={onAddCell} />}
      <ErrorBoundary
        fallback={(error, resetErrorBoundary) => (
          <CellErrorFallback
            error={error}
            onRetry={resetErrorBoundary}
            onDelete={canMutateCells ? () => onDeleteCell(cellId) : undefined}
          />
        )}
      >
        <CellRenderer
          cellId={cellId}
          index={index}
          renderCell={renderCell}
          dragHandleProps={dragHandleProps}
          isDragging={isDragging}
        />
      </ErrorBoundary>
      {canMutateCells && <CellAdder afterCellId={cellId} onAdd={onAddCell} terminal={isLastCell} />}
    </div>
  );
}

function NotebookViewContent({
  cellIds,
  isLoading = false,
  capabilities,
  canAcceptCellMutations = false,
  readOnly = false,
  loadError = null,
  runtime = "python",
  sessionRuntimeState = null,
  onFocusCell,
  onExecuteCell,
  onRequestExecuteCell,
  onInterruptKernel,
  onDeleteCell,
  onUpdateCellSource,
  onAddCell,
  onMoveCell,
  onReportOutputMatchCount,
  onSetCellSourceHidden,
  onSetCellOutputsHidden,
  onCreateSourceComment,
  onActivateCommentThread,
  markdownHeadingAnchorsByCellId,
  outputHostContext,
  deferOutputIsolatedFramesUntilVisible = false,
  deferredOutputIsolatedFrameRootMargin,
  autoFocusFirstCell = true,
}: NotebookViewProps) {
  const presence = usePresenceContext();
  const containerRef = useRef<HTMLDivElement>(null);
  const tailPinnedRef = useRef(false);
  const tailScrollFrameRef = useRef<number | null>(null);
  const canEditCodeCellSources = capabilities?.canEditCells ?? !readOnly;
  const canEditMarkdownSources = capabilities?.canEditMarkdown ?? !readOnly;
  const canMutateCells = computeCanMutateCells({ canAcceptCellMutations, capabilities, readOnly });
  const canExecuteCells = capabilities?.canExecute ?? !readOnly;

  // Read transient UI state from the store instead of props
  const focusedCellId = useFocusedCellId();
  const searchCurrentMatch = useSearchCurrentMatch();
  const outputFocusedCellId = useOutputFocusedCellId();
  // FSB-1 failure surface: outputs whose projection failed after retries.
  const outputProjectionFailures = useOutputProjectionFailures();

  // Output-focus follows cell selection: when the user moves the caret to a
  // different cell (arrow keys, click, programmatic focus), the previously
  // output-focused cell exits focus. This keeps the "wheel ownership" cell
  // and the "keyboard target" cell aligned without separate handlers.
  //
  // The `focusedCellId !== null` guard was needed when outputFocusedCellId
  // lived in useState (which committed before the deferred cell-ui-state
  // flush resolved focusedCellId). Both values are now in stores that emit
  // via React's batching, so the guard is no longer load-bearing — but it
  // is kept as a safety net: treat null as "no current selection," not
  // "user moved selection away."
  useEffect(() => {
    if (
      outputFocusedCellId !== null &&
      focusedCellId !== null &&
      focusedCellId !== outputFocusedCellId
    ) {
      clearOutputFocusedCellId();
    }
  }, [focusedCellId, outputFocusedCellId]);

  useEffect(() => {
    if (outputFocusedCellId !== null && !cellIds.includes(outputFocusedCellId)) {
      clearOutputFocusedCellId();
    }
  }, [cellIds, outputFocusedCellId]);

  const publishInteractionTarget = useCallback(
    (target: NotebookInteractionTarget) => {
      setActiveInteractionTarget(target);
      flushCellUIState();
      presence?.setInteraction(target);
      presence?.setFocus(target.cellId);
    },
    [presence],
  );

  const focusInteractionTarget = useCallback(
    (target: NotebookInteractionTarget) => {
      onFocusCell(target.cellId);
      publishInteractionTarget(target);
    },
    [onFocusCell, publishInteractionTarget],
  );

  // Document-level Esc listener while a cell is output-focused. Esc events
  // that originate inside the iframe don't reach the document unless the
  // iframe lets them through, so this only fires for top-level Esc.
  useEffect(() => {
    if (outputFocusedCellId === null) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        clearOutputFocusedCellId();
        publishInteractionTarget({ kind: "cell", cellId: outputFocusedCellId });
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [outputFocusedCellId, publishInteractionTarget]);

  // Click-outside-container exit. Clicking another cell's editor already
  // clears focus via the selection-change effect above, but clicking another
  // cell's iframe (Sift, HTML) never fires onFocusCell because the iframe
  // absorbs the event. Same goes for clicks on page chrome between cells.
  // Scope the dismiss to the focused cell's container so clicks on its own
  // right-gutter buttons (focus, expand, eye) still hit their handlers.
  useEffect(() => {
    if (outputFocusedCellId === null) return;
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const focusedCellEl = document.querySelector(
        `[data-slot="cell-container"][data-cell-id="${outputFocusedCellId}"]`,
      );
      if (focusedCellEl && !focusedCellEl.contains(target)) {
        clearOutputFocusedCellId();
        publishInteractionTarget({ kind: "cell", cellId: outputFocusedCellId });
      }
    };
    document.addEventListener("mousedown", handleMouseDown, true);
    return () => document.removeEventListener("mousedown", handleMouseDown, true);
  }, [outputFocusedCellId, publishInteractionTarget]);

  const handleOutputFocusChange = useCallback(
    (cellId: string, outputFocused: boolean) => {
      if (outputFocused) {
        focusInteractionTarget({ kind: "output", cellId });
        setOutputFocusedCellId(cellId);
        return;
      }
      clearOutputFocusedCellId(cellId);
      publishInteractionTarget({ kind: "cell", cellId });
    },
    [focusInteractionTarget, publishInteractionTarget],
  );

  // Ref for cellIds so renderCell can read the latest list without
  // depending on the array identity. This prevents recreating
  // renderCell (and remounting widget iframes) on structural changes.
  const cellIdsRef = useRef(cellIds);
  cellIdsRef.current = cellIds;
  const { focusCell } = useEditorRegistry();

  // Track full materializations for cross-cell derived state
  const materializeVersion = useMaterializeVersion();
  // Recompute hidden-group membership when outputs are added, removed, or
  // change kind. Phase C-lite stopped updating `cell.outputs` on output-only
  // frames, so source-hidden cells still need a store signal when their
  // output membership changes. Stream text/display payload updates keep the
  // same membership and should not rescan all hidden groups.
  const outputStructureVersion = useOutputStructureVersion();

  // Drag-and-drop state
  const [activeId, setActiveId] = useState<string | null>(null);

  // Configure dnd-kit sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      setActiveId(null);

      if (over && active.id !== over.id) {
        const oldIndex = cellIds.indexOf(active.id as string);
        const newIndex = cellIds.indexOf(over.id as string);

        // Calculate afterCellId: we want to place the cell after the cell
        // that will be above it in the new position
        let afterCellId: string | null;
        if (newIndex === 0) {
          // Moving to the beginning
          afterCellId = null;
        } else if (newIndex > oldIndex) {
          // Moving down: place after the cell at newIndex
          afterCellId = cellIds[newIndex];
        } else {
          // Moving up: place after the cell at newIndex - 1
          afterCellId = newIndex > 0 ? cellIds[newIndex - 1] : null;
        }

        onMoveCell(active.id as string, afterCellId);
      }
    },
    [cellIds, onMoveCell],
  );

  // IMPORTANT: Stable DOM order — do NOT replace with cellIds.map() directly.
  // Cells are rendered in sorted-ID order so React never calls insertBefore on
  // existing DOM nodes. Visual ordering uses CSS `order` on each cell wrapper.
  // Without this, moving a cell causes browsers to reload iframes (destroying
  // content, widgets, and theme state). See CLAUDE.md § "Cell List Stable DOM Order".
  //
  // Default JS string sort (code-unit order, not locale-aware) is correct
  // here because the sort only needs to be *stable and deterministic*, not
  // human-meaningful — cell ids are UUIDs today (FSB-3). If a non-UUID id
  // scheme ever lands, any total order still satisfies the invariant; what
  // matters is every client sorts identically, which `Array.prototype.sort`'s
  // UTF-16 code-unit comparison guarantees and locale-aware collation would not.
  const stableDomOrder = useMemo(() => [...cellIds].sort(), [cellIds]);

  // Map cell ID → visual index for O(1) lookup
  const cellIdToIndex = useMemo(() => {
    const map = new Map<string, number>();
    for (let i = 0; i < cellIds.length; i++) {
      map.set(cellIds[i], i);
    }
    return map;
  }, [cellIds]);

  // Compute consecutive groups of fully-hidden cells
  // Maps cell ID → { count, isFirst, groupCellIds }
  // Recomputes on structural changes and full materializations (metadata changes)
  const hiddenGroups = useMemo(() => {
    // Depend on cellIds (structural changes), materializeVersion (metadata
    // changes like source_hidden), and outputStructureVersion (output adds,
    // removals, or type changes that affect hidden grouping / error counts).
    void cellIds;
    void materializeVersion;
    void outputStructureVersion;
    const cells = getNotebookCellsSnapshot();
    const groups = new Map<
      string,
      {
        count: number;
        isFirst: boolean;
        groupCellIds: string[];
        items: HiddenGroupCellSummary[];
        errorCount: number;
      }
    >();
    let i = 0;
    while (i < cells.length) {
      if (isCellFullyHidden(cells[i])) {
        const groupCellIds: string[] = [];
        const groupItems: HiddenGroupCellSummary[] = [];
        let groupErrorCount = 0;
        while (i < cells.length && isCellFullyHidden(cells[i])) {
          const c = cells[i];
          const outputs = c.cell_type === "code" ? getCellOutputsSnapshot(c.id) : [];
          const errorCount = outputs.filter((o) => o.output_type === "error").length;
          groupCellIds.push(c.id);
          groupItems.push(hiddenGroupCellSummary(c, outputs.length, errorCount > 0));
          if (c.cell_type === "code") {
            // Read from the outputs store - `c.outputs` is stale under
            // Phase C-lite on output-only frame updates.
            groupErrorCount += errorCount;
          }
          i++;
        }
        for (let j = 0; j < groupCellIds.length; j++) {
          groups.set(groupCellIds[j], {
            count: groupCellIds.length,
            isFirst: j === 0,
            groupCellIds,
            items: groupItems,
            errorCount: groupErrorCount,
          });
        }
      } else {
        i++;
      }
    }
    return groups;
  }, [cellIds, materializeVersion, outputStructureVersion]);
  const hiddenGroupsRef = useRef(hiddenGroups);
  hiddenGroupsRef.current = hiddenGroups;
  const pendingRevealFocusCellIdRef = useRef<string | null>(null);

  useEffect(() => {
    const cellId = pendingRevealFocusCellIdRef.current;
    if (!cellId) return;

    const cell = getCellById(cellId);
    if (!cell) {
      pendingRevealFocusCellIdRef.current = null;
      return;
    }

    if (isCellFullyHidden(cell)) return;

    pendingRevealFocusCellIdRef.current = null;
    const frame = window.requestAnimationFrame(() => {
      focusCell(cellId, "start");
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusCell, hiddenGroups, materializeVersion, outputStructureVersion]);

  const cancelTailScrollFrame = useCallback(() => {
    if (tailScrollFrameRef.current === null) return;
    window.cancelAnimationFrame(tailScrollFrameRef.current);
    tailScrollFrameRef.current = null;
  }, []);

  const suppressTailFollowForInPlaceExecution = useCallback(() => {
    tailPinnedRef.current = false;
    cancelTailScrollFrame();
  }, [cancelTailScrollFrame]);

  // Prevent horizontal scroll drift (can happen during text selection) and
  // remember whether the user is already reading at the notebook tail.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      if (container.scrollLeft !== 0) {
        container.scrollLeft = 0;
      }

      if (cellIdsRef.current.length === 0) {
        tailPinnedRef.current = false;
        return;
      }

      const distanceFromTail =
        container.scrollHeight - container.clientHeight - container.scrollTop;
      if (distanceFromTail <= NOTEBOOK_TAIL_PIN_THRESHOLD_PX) {
        tailPinnedRef.current = true;
        return;
      }

      const lastCellId = cellIdsRef.current.at(-1);
      const lastCellEl = lastCellId
        ? container.querySelector(`[data-cell-id="${CSS.escape(lastCellId)}"]`)
        : null;
      if (!lastCellEl) {
        tailPinnedRef.current = false;
        return;
      }

      const containerRect = container.getBoundingClientRect();
      const lastCellRect = lastCellEl.getBoundingClientRect();
      tailPinnedRef.current =
        lastCellRect.bottom >= containerRect.top &&
        lastCellRect.top <= containerRect.bottom &&
        lastCellRect.bottom >= containerRect.bottom - NOTEBOOK_TAIL_PIN_THRESHOLD_PX;
    };

    handleScroll();
    container.addEventListener("scroll", handleScroll);
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  const scheduleTailScrollIfPinned = useCallback(() => {
    if (!tailPinnedRef.current) return;
    const container = containerRef.current;
    if (!container || tailScrollFrameRef.current !== null) return;

    tailScrollFrameRef.current = window.requestAnimationFrame(() => {
      tailScrollFrameRef.current = null;
      if (!tailPinnedRef.current) return;
      const currentContainer = containerRef.current;
      if (!currentContainer) return;
      currentContainer.scrollTop = currentContainer.scrollHeight;
    });
  }, []);

  useEffect(() => {
    return () => {
      cancelTailScrollFrame();
    };
  }, [cancelTailScrollFrame]);

  // If outputs or trailing cells arrive while the user is already at the
  // notebook tail, keep the tail anchored so last-cell outputs do not grow
  // below the viewport and vanish. Scrolling up opts out via tailPinnedRef.
  useEffect(() => {
    return subscribeOutputsVersion(scheduleTailScrollIfPinned);
  }, [scheduleTailScrollIfPinned]);

  useEffect(() => {
    scheduleTailScrollIfPinned();
  }, [cellIds.length, scheduleTailScrollIfPinned]);

  // Scroll the current search match cell into view
  useEffect(() => {
    if (!searchCurrentMatch) return;
    const cellEl = containerRef.current?.querySelector(
      `[data-cell-id="${CSS.escape(searchCurrentMatch.cellId)}"]`,
    );
    if (cellEl) {
      cellEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [searchCurrentMatch]);

  useEffect(() => {
    if (!autoFocusFirstCell) return;
    if (isLoading || focusedCellId !== null) return;
    if (cellIds.length > 0) {
      focusInteractionTarget({ kind: "cell", cellId: cellIds[0] });
    }
  }, [autoFocusFirstCell, isLoading, cellIds, focusedCellId, focusInteractionTarget]);

  const renderCell = useCallback(
    (
      cell: NotebookCell,
      index: number,
      dragHandleProps?: Record<string, unknown>,
      isDragging?: boolean,
    ) => {
      // Navigation callbacks — skip cells that are collapsed into a hidden group
      const isVisibleCell = (id: string) => {
        const g = hiddenGroupsRef.current.get(id);
        return !g || g.isFirst;
      };

      const onFocusPrevious = (cursorPosition: "start" | "end") => {
        logger.debug(
          `[cell-nav] onFocusPrevious called: cell=${cell.id.slice(0, 8)} index=${index} cellIds=${cellIdsRef.current.map((id) => id.slice(0, 8)).join(",")}`,
        );
        let prevIndex = index - 1;
        while (prevIndex >= 0 && !isVisibleCell(cellIdsRef.current[prevIndex])) {
          prevIndex--;
        }
        if (prevIndex >= 0) {
          const prevCellId = cellIdsRef.current[prevIndex];
          logger.debug(`[cell-nav] Focusing previous: ${prevCellId.slice(0, 8)}`);
          focusInteractionTarget({ kind: "editor", cellId: prevCellId });
          focusCell(prevCellId, cursorPosition);
        } else {
          logger.debug("[cell-nav] No previous cell (index=0)");
        }
      };

      const onFocusNext = (cursorPosition: "start" | "end") => {
        logger.debug(
          `[cell-nav] onFocusNext called: cell=${cell.id.slice(0, 8)} index=${index} cellIds=${cellIdsRef.current.map((id) => id.slice(0, 8)).join(",")}`,
        );
        let nextIndex = index + 1;
        while (
          nextIndex < cellIdsRef.current.length &&
          !isVisibleCell(cellIdsRef.current[nextIndex])
        ) {
          nextIndex++;
        }
        if (nextIndex < cellIdsRef.current.length) {
          const nextCellId = cellIdsRef.current[nextIndex];
          logger.debug(`[cell-nav] Focusing next: ${nextCellId.slice(0, 8)}`);
          focusInteractionTarget({ kind: "editor", cellId: nextCellId });
          focusCell(nextCellId, cursorPosition);
        } else {
          logger.debug("[cell-nav] No next cell (at end)");
        }
      };

      const onNavigateToCell = (target: TracebackCellTarget) => {
        const targetCellId = target.cellId;
        logger.debug(`[cell-nav] Navigating to traceback cell: ${targetCellId.slice(0, 8)}`);
        focusInteractionTarget({ kind: "editor", cellId: targetCellId });
        focusCell(targetCellId, typeof target.line === "number" ? { line: target.line } : "start");
      };

      // Build right gutter content — delete button for all cells,
      // plus input toggle for code cells
      const deleteButton = canMutateCells ? (
        <button
          type="button"
          tabIndex={-1}
          onClick={() => onDeleteCell(cell.id)}
          className="flex items-center justify-center rounded p-1 text-muted-foreground/40 transition-colors hover:text-destructive"
          title="Delete cell"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      ) : null;

      let rightGutterContent: React.ReactNode;
      if (cell.cell_type === "code") {
        const isSourceHidden =
          (cell.metadata?.jupyter as { source_hidden?: boolean })?.source_hidden === true;
        const isOutputsHidden =
          (cell.metadata?.jupyter as { outputs_hidden?: boolean })?.outputs_hidden === true;
        const bothHidden = isSourceHidden && isOutputsHidden;
        const hasSourceText = cell.source.trim().length > 0;
        const sourceToggleButton =
          canMutateCells &&
          onSetCellSourceHidden &&
          !bothHidden &&
          (hasSourceText || isSourceHidden) ? (
            <button
              type="button"
              tabIndex={-1}
              onClick={() => onSetCellSourceHidden(cell.id, !isSourceHidden)}
              className={cn(
                "flex items-center justify-center rounded p-1 transition-colors hover:text-foreground",
                isSourceHidden ? "text-muted-foreground/70" : "text-muted-foreground/40",
              )}
              title={isSourceHidden ? "Show input" : "Hide input"}
            >
              {isSourceHidden ? (
                <Eye className="h-3.5 w-3.5" />
              ) : (
                <EyeOff className="h-3.5 w-3.5" />
              )}
            </button>
          ) : null;
        const visibleDeleteButton = !isSourceHidden ? deleteButton : null;

        rightGutterContent =
          sourceToggleButton || visibleDeleteButton ? (
            <div className="flex flex-col gap-0.5">
              {sourceToggleButton}
              {visibleDeleteButton}
            </div>
          ) : undefined;
      } else {
        rightGutterContent = deleteButton ? (
          <div className="flex flex-col gap-0.5">{deleteButton}</div>
        ) : undefined;
      }

      if (cell.cell_type === "code") {
        // Use TypeScript for Deno, IPython otherwise (for magic/shell highlighting)
        const language = runtime === "deno" ? "typescript" : "ipython";
        const hiddenGroup = hiddenGroupsRef.current.get(cell.id);
        const executeCellOrHiddenGroup = () => {
          const latestHiddenGroup = hiddenGroupsRef.current.get(cell.id);
          if (latestHiddenGroup && latestHiddenGroup.count > 1) {
            for (const hiddenCellId of latestHiddenGroup.groupCellIds) {
              onExecuteCell(hiddenCellId);
            }
          } else {
            onExecuteCell(cell.id);
          }
        };
        const requestExecuteCellOrHiddenGroup = onRequestExecuteCell
          ? () => {
              const latestHiddenGroup = hiddenGroupsRef.current.get(cell.id);
              if (latestHiddenGroup && latestHiddenGroup.count > 1) {
                for (const hiddenCellId of latestHiddenGroup.groupCellIds) {
                  onRequestExecuteCell(hiddenCellId);
                }
              } else {
                onRequestExecuteCell(cell.id);
              }
            }
          : undefined;
        const executeCellInPlaceOrHiddenGroup = () => {
          suppressTailFollowForInPlaceExecution();
          executeCellOrHiddenGroup();
        };
        const requestExecuteCellInPlaceOrHiddenGroup = requestExecuteCellOrHiddenGroup
          ? () => {
              suppressTailFollowForInPlaceExecution();
              requestExecuteCellOrHiddenGroup();
            }
          : undefined;

        return (
          <CodeCell
            key={cell.id}
            cell={cell}
            language={language}
            onSearchMatchCount={
              onReportOutputMatchCount
                ? (count: number) => onReportOutputMatchCount(cell.id, count)
                : undefined
            }
            onFocus={() => {
              focusInteractionTarget({ kind: "editor", cellId: cell.id });
            }}
            outputFocused={outputFocusedCellId === cell.id}
            outputDimmed={outputFocusedCellId !== null && outputFocusedCellId !== cell.id}
            onOutputFocusChange={(focused) => handleOutputFocusChange(cell.id, focused)}
            onExecute={executeCellOrHiddenGroup}
            onExecuteInPlace={executeCellInPlaceOrHiddenGroup}
            onRequestExecute={requestExecuteCellOrHiddenGroup}
            onRequestExecuteInPlace={requestExecuteCellInPlaceOrHiddenGroup}
            onInterrupt={onInterruptKernel}
            onDelete={canMutateCells ? () => onDeleteCell(cell.id) : undefined}
            onFocusPrevious={onFocusPrevious}
            onFocusNext={onFocusNext}
            onNavigateToCell={onNavigateToCell}
            onInsertCellAfter={canMutateCells ? () => onAddCell("code", cell.id) : undefined}
            isLastCell={index === cellIdsRef.current.length - 1}
            dragHandleProps={dragHandleProps}
            isDragging={isDragging}
            rightGutterContent={rightGutterContent}
            readOnly={!canEditCodeCellSources}
            canExecute={canExecuteCells}
            onCreateSourceComment={onCreateSourceComment}
            onActivateCommentThread={onActivateCommentThread}
            outputHostContext={outputHostContext}
            deferOutputIsolatedFrameUntilVisible={deferOutputIsolatedFramesUntilVisible}
            deferredOutputIsolatedFrameRootMargin={deferredOutputIsolatedFrameRootMargin}
            onToggleSourceHidden={
              canMutateCells && onSetCellSourceHidden
                ? (hidden: boolean) => onSetCellSourceHidden(cell.id, hidden)
                : undefined
            }
            onToggleOutputsHidden={
              canMutateCells && onSetCellOutputsHidden
                ? (hidden: boolean) => onSetCellOutputsHidden(cell.id, hidden)
                : undefined
            }
            hiddenGroupCount={hiddenGroup?.count}
            hiddenGroupErrorCount={hiddenGroup?.errorCount}
            hiddenGroupCellIds={hiddenGroup?.groupCellIds}
            hiddenGroupItems={hiddenGroup?.items}
            onExpandHiddenGroup={
              hiddenGroupsRef.current.has(cell.id) &&
              canMutateCells &&
              onSetCellSourceHidden &&
              onSetCellOutputsHidden
                ? () => {
                    const group = hiddenGroupsRef.current.get(cell.id);
                    if (group) {
                      for (const id of group.groupCellIds) {
                        onSetCellSourceHidden(id, false);
                        onSetCellOutputsHidden(id, false);
                      }
                    }
                  }
                : undefined
            }
            onExpandHiddenGroupCell={
              hiddenGroupsRef.current.has(cell.id) &&
              canMutateCells &&
              onSetCellSourceHidden &&
              onSetCellOutputsHidden
                ? (hiddenCellId: string) => {
                    pendingRevealFocusCellIdRef.current = hiddenCellId;
                    onSetCellSourceHidden(hiddenCellId, false);
                    onSetCellOutputsHidden(hiddenCellId, false);
                    focusInteractionTarget({ kind: "cell", cellId: hiddenCellId });
                  }
                : undefined
            }
          />
        );
      }

      if (cell.cell_type === "markdown") {
        return (
          <MarkdownCell
            key={cell.id}
            cell={cell}
            onFocus={() => {
              focusInteractionTarget({ kind: "editor", cellId: cell.id });
            }}
            onDelete={canMutateCells ? () => onDeleteCell(cell.id) : undefined}
            onUpdateSource={
              canMutateCells && canEditMarkdownSources && onUpdateCellSource
                ? (source: string) => onUpdateCellSource(cell.id, source)
                : undefined
            }
            onFocusPrevious={onFocusPrevious}
            onFocusNext={onFocusNext}
            onInsertCellAfter={canMutateCells ? () => onAddCell("markdown", cell.id) : undefined}
            isLastCell={index === cellIdsRef.current.length - 1}
            dragHandleProps={dragHandleProps}
            isDragging={isDragging}
            rightGutterContent={rightGutterContent}
            headingAnchors={markdownHeadingAnchorsByCellId?.get(cell.id)}
            readOnly={!canEditMarkdownSources}
            outputHostContext={outputHostContext}
          />
        );
      }

      // Raw cells
      return (
        <RawCell
          key={cell.id}
          cell={cell}
          onFocus={() => {
            focusInteractionTarget({ kind: "editor", cellId: cell.id });
          }}
          onDelete={canMutateCells ? () => onDeleteCell(cell.id) : undefined}
          onFocusPrevious={onFocusPrevious}
          onFocusNext={onFocusNext}
          onInsertCellAfter={canMutateCells ? () => onAddCell("code", cell.id) : undefined}
          isLastCell={index === cellIdsRef.current.length - 1}
          dragHandleProps={dragHandleProps}
          isDragging={isDragging}
          rightGutterContent={rightGutterContent}
          readOnly={!canEditCodeCellSources}
          onCreateSourceComment={onCreateSourceComment}
          onActivateCommentThread={onActivateCommentThread}
        />
      );
    },
    [
      runtime,
      focusInteractionTarget,
      suppressTailFollowForInPlaceExecution,
      onExecuteCell,
      onInterruptKernel,
      onDeleteCell,
      onUpdateCellSource,
      onAddCell,
      onReportOutputMatchCount,
      onSetCellSourceHidden,
      onSetCellOutputsHidden,
      onCreateSourceComment,
      onActivateCommentThread,
      markdownHeadingAnchorsByCellId,
      canEditCodeCellSources,
      canEditMarkdownSources,
      canMutateCells,
      canExecuteCells,
      outputHostContext,
      deferOutputIsolatedFramesUntilVisible,
      deferredOutputIsolatedFrameRootMargin,
      outputFocusedCellId,
      focusCell,
      handleOutputFocusChange,
    ],
  );

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto overflow-x-clip overscroll-x-contain scroll-smooth pt-0 pb-4 pl-0 pr-2"
      style={{
        contain: "paint",
        overflowAnchor: "none",
        paddingBottom: NOTEBOOK_TAIL_SPACE,
        scrollPaddingBlock: `0rem ${NOTEBOOK_TAIL_SPACE}`,
      }}
      data-notebook-synced={!isLoading && !loadError}
      data-session-runtime-state={sessionRuntimeState ?? "unknown"}
      data-session-ready={sessionRuntimeState === "ready"}
      data-cell-count={cellIds.length}
    >
      {loadError ? (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          Notebook failed to finish loading: {loadError}
        </div>
      ) : null}
      {outputProjectionFailures.length > 0 ? (
        <div
          className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-300"
          data-testid="output-projection-failures"
        >
          {outputProjectionFailures.length === 1
            ? "1 output failed to load"
            : `${outputProjectionFailures.length} outputs failed to load`}{" "}
          and may be stale. They will refresh on the next change or reconnect.
        </div>
      ) : null}
      {cellIds.length === 0 ? (
        isLoading ? (
          <CellSkeleton />
        ) : loadError ? (
          <div className="flex flex-col items-center justify-center py-20 text-center text-destructive">
            <p className="text-sm font-medium">Notebook load failed</p>
            <p className="mt-1 max-w-xl text-xs text-muted-foreground">{loadError}</p>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <p className="text-sm">Empty notebook</p>
            {canMutateCells ? (
              <>
                <p className="text-xs mt-1">Add a cell to get started</p>
                <div className="mt-4 flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onAddCell("code")}
                    className="gap-1"
                  >
                    <Plus className="h-3 w-3" />
                    Code Cell
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onAddCell("markdown")}
                    className="gap-1"
                  >
                    <Plus className="h-3 w-3" />
                    Markdown Cell
                  </Button>
                </div>
              </>
            ) : null}
          </div>
        )
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setActiveId(null)}
        >
          <SortableContext items={cellIds} strategy={verticalListSortingStrategy}>
            <div style={{ display: "flex", flexDirection: "column" }}>
              {stableDomOrder.map((cellId) => {
                const index = cellIdToIndex.get(cellId) ?? 0;
                const group = hiddenGroups.get(cellId);
                return (
                  <SortableCell
                    key={cellId}
                    cellId={cellId}
                    index={index}
                    renderCell={renderCell}
                    onAddCell={onAddCell}
                    onDeleteCell={onDeleteCell}
                    isLastCell={index === cellIds.length - 1}
                    isHiddenInGroup={group != null && !group.isFirst}
                    canMutateCells={canMutateCells}
                  />
                );
              })}
            </div>
          </SortableContext>
          <DragOverlay>{activeId && <CellDragPreview cellId={activeId} />}</DragOverlay>
        </DndContext>
      )}
    </div>
  );
}

export function NotebookView(props: NotebookViewProps) {
  return (
    <EditorRegistryProvider>
      <NotebookViewContent {...props} />
    </EditorRegistryProvider>
  );
}

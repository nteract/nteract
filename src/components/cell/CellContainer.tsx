import { forwardRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { cellContentColumnInset, cellOutputRowInset, notebookCellLayoutVars } from "./cell-layout";
import { type GutterColorConfig, getGutterColors } from "./gutter-colors";

interface CellContainerProps {
  id: string;
  elementId?: string;
  cellType: string;
  isFocused?: boolean;
  onFocus?: () => void;
  /** Content for the code/editor section (use with outputContent for segmented ribbon) */
  codeContent?: ReactNode;
  /** Content for the output section (renders with a different ribbon color) */
  outputContent?: ReactNode;
  /** Hide the output section (useful for preloading content invisibly) */
  hideOutput?: boolean;
  /** Legacy children prop - use codeContent/outputContent for segmented ribbon support */
  children?: ReactNode;
  /** Content to render in the left state lane (e.g., play button, execution marker) */
  gutterContent?: ReactNode;
  /** Optional layout override for the left state lane. */
  stateLaneClassName?: string;
  /** Content to render in the right margin aligned with code row (e.g., cell controls) */
  rightGutterContent?: ReactNode;
  /** Content to render in the right margin aligned with output row (e.g., output controls) */
  outputRightGutterContent?: ReactNode;
  /** Remote peer presence indicators (colored dots showing who's on this cell) */
  presenceIndicators?: ReactNode;
  /** Custom color configuration for cell types not in defaults */
  customGutterColors?: Record<string, GutterColorConfig>;
  /** Whether this cell is immediately before the focused cell (keeps output bright) */
  isPreviousCellFromFocused?: boolean;
  /** Whether this cell is immediately after the focused cell (keeps output bright) */
  isNextCellFromFocused?: boolean;
  /**
   * True when this cell's output is in "output focus" mode - the immersive
   * view where the iframe owns the wheel and the cell dominates. Distinct
   * from `isFocused` (cell selection / editor caret).
   */
  outputFocused?: boolean;
  /**
   * True when some OTHER cell is output-focused, so this one should dim out.
   * Mutually exclusive with `outputFocused`.
   */
  outputDimmed?: boolean;
  /** Props for dnd-kit drag handle (applied to ribbon) */
  dragHandleProps?: Record<string, unknown>;
  /** Whether this cell is currently being dragged */
  isDragging?: boolean;
  className?: string;
}

function CellActionOverlay({
  children,
  dataSlot,
  visible = false,
}: {
  children?: ReactNode;
  dataSlot: string;
  visible?: boolean;
}) {
  if (!children) return null;

  return (
    <div
      data-slot={dataSlot}
      className={cn(
        "absolute right-2 top-1 z-20 flex flex-col items-center gap-0.5 rounded-sm px-0.5 py-0.5 select-none",
        "bg-background/80 shadow-sm ring-1 ring-border/40 backdrop-blur-sm",
        "pointer-events-none opacity-0 transition-opacity duration-150",
        "group-hover:pointer-events-auto group-hover:opacity-100",
        "focus-within:pointer-events-auto focus-within:opacity-100",
        visible && "pointer-events-auto opacity-100",
      )}
    >
      {children}
    </div>
  );
}

export const CellContainer = forwardRef<HTMLDivElement, CellContainerProps>(
  (
    {
      id,
      elementId,
      cellType,
      isFocused = false,
      onFocus,
      codeContent,
      outputContent,
      hideOutput,
      children,
      gutterContent,
      stateLaneClassName,
      rightGutterContent,
      outputRightGutterContent,
      presenceIndicators,
      customGutterColors,
      isPreviousCellFromFocused = false,
      isNextCellFromFocused = false,
      outputFocused = false,
      outputDimmed = false,
      dragHandleProps,
      isDragging = false,
      className,
    },
    ref,
  ) => {
    const focusState = outputFocused ? "focused" : outputDimmed ? "dimmed" : undefined;
    const colors = getGutterColors(cellType, customGutterColors);
    const ribbonColor = isFocused ? colors.ribbon.focused : colors.ribbon.default;
    const outputRibbonColor = isFocused ? colors.outputRibbon.focused : colors.outputRibbon.default;
    const bgColor = isFocused ? colors.background.focused : undefined;

    const hasCodeContent =
      codeContent !== undefined && codeContent !== null && codeContent !== false;
    const hasOutput = outputContent !== undefined && outputContent !== null;
    const useSegmentedRibbon = codeContent !== undefined || hasOutput;

    return (
      <div
        ref={ref}
        id={elementId}
        data-slot="cell-container"
        data-cell-id={id}
        data-cell-type={cellType}
        data-focus-state={focusState}
        className={cn(
          "cell-container group relative flex transition-colors duration-150",
          notebookCellLayoutVars,
          bgColor,
          isFocused && "-mr-4 pr-4",
          isDragging && "opacity-50",
          // Output focus dim wins over the existing opacity-70 dim on the
          // output row. Applied to the whole cell container so the editor
          // dims too while another cell owns the wheel.
          outputDimmed && "opacity-[0.35]",
          className,
        )}
      >
        {/* Optional state lane - lives inside the source inset so clipped scroll containers do not hide it. */}
        <div
          data-slot="cell-state-lane"
          className={cn(
            "absolute left-1 top-0 z-10 flex w-[var(--cell-content-column-inset,3.25rem)] flex-col items-center justify-start gap-0.5 pt-[1.125rem] select-none sm:pt-3.5",
            stateLaneClassName,
          )}
          onMouseDown={onFocus}
        >
          {gutterContent}
          {presenceIndicators}
        </div>
        {/* Cell content with ribbon */}
        {useSegmentedRibbon ? (
          <div className="flex min-w-0 flex-1 flex-col">
            {/* Code row - ribbon + content + right gutter */}
            {hasCodeContent ? (
              <div data-slot="cell-code-row" className="relative flex" onMouseDown={onFocus}>
                <div
                  {...dragHandleProps}
                  data-slot="cell-ribbon"
                  className={cn(
                    "w-1 transition-colors duration-150",
                    ribbonColor,
                    dragHandleProps && "cursor-grab hover:brightness-125 touch-none",
                    isDragging && "cursor-grabbing",
                  )}
                />
                <div
                  data-slot="cell-code-content"
                  className={cn(
                    "min-w-0 flex-1 pt-1.5",
                    cellContentColumnInset,
                    rightGutterContent ? "pr-14" : "pr-3",
                    hasOutput && !hideOutput ? "pb-1.5" : "pb-3",
                  )}
                >
                  {codeContent}
                </div>
                <CellActionOverlay dataSlot="cell-action-overlay" visible={isFocused}>
                  {rightGutterContent}
                </CellActionOverlay>
              </div>
            ) : null}
            {/* Output row - ribbon + content + right gutter
                onMouseDown sets visual focus (ribbon/bg) without stealing editor focus */}
            {hasOutput && (
              <div
                data-slot="cell-output-row"
                className={cn("relative flex", hideOutput && "hidden")}
                onMouseDown={onFocus}
              >
                <div
                  data-slot="cell-output-ribbon"
                  className={cn("w-1 transition-colors duration-150", outputRibbonColor)}
                />
                <div
                  data-slot="cell-output-content"
                  className={cn(
                    "min-w-0 flex-1 pt-1 pb-2 transition-opacity duration-150",
                    cellOutputRowInset,
                    outputRightGutterContent ? "pr-14" : "pr-3",
                    !outputFocused &&
                      !isFocused &&
                      !isPreviousCellFromFocused &&
                      !isNextCellFromFocused &&
                      "opacity-70",
                    // Elevate via top + bottom edges only. The cell's left
                    // ribbon plus this slab forms a three-sided frame that
                    // reads as active without the card-like ring aesthetic.
                    outputFocused && "border-y border-primary/40 bg-primary/5",
                    !hasCodeContent && "pt-2",
                  )}
                >
                  {outputContent}
                </div>
                <CellActionOverlay dataSlot="cell-output-action-overlay" visible={isFocused}>
                  {outputRightGutterContent}
                </CellActionOverlay>
              </div>
            )}
          </div>
        ) : (
          <>
            {/* Legacy layout - ribbon + content side by side */}
            <div className="relative flex min-w-0 flex-1" onMouseDown={onFocus}>
              <div
                {...dragHandleProps}
                data-slot="cell-ribbon"
                className={cn(
                  "w-1 self-stretch transition-colors duration-150",
                  ribbonColor,
                  dragHandleProps && "cursor-grab hover:brightness-125 touch-none",
                  isDragging && "cursor-grabbing",
                )}
              />
              <div
                data-slot="cell-code-content"
                className={cn(
                  "min-w-0 flex-1 pt-1.5 pb-3",
                  cellContentColumnInset,
                  rightGutterContent ? "pr-14" : "pr-3",
                )}
              >
                {children}
              </div>
              <CellActionOverlay dataSlot="cell-action-overlay" visible={isFocused}>
                {rightGutterContent}
              </CellActionOverlay>
            </div>
          </>
        )}
      </div>
    );
  },
);

CellContainer.displayName = "CellContainer";

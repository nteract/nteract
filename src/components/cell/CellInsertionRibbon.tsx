import { Code, LetterText } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { notebookCellLayoutVars } from "./cell-layout";

export type CellInsertionType = "code" | "markdown";

interface CellInsertionRibbonProps {
  terminal?: boolean;
  activeType?: CellInsertionType | null;
  onActiveTypeChange?: (type: CellInsertionType | null) => void;
  onInsert: (type: CellInsertionType) => void;
  forceActionsVisible?: boolean;
  className?: string;
}

const insertionRibbonClasses: Record<CellInsertionType, string> = {
  code: "bg-sky-400 dark:bg-sky-600",
  markdown: "bg-emerald-400 dark:bg-emerald-600",
};

const terminalInsertionRibbonClasses: Record<CellInsertionType, string> = {
  code: "bg-gradient-to-b from-sky-400 via-sky-400/60 to-sky-400/0 dark:from-sky-600 dark:via-sky-600/60 dark:to-sky-600/0",
  markdown:
    "bg-gradient-to-b from-emerald-400 via-emerald-400/60 to-emerald-400/0 dark:from-emerald-600 dark:via-emerald-600/60 dark:to-emerald-600/0",
};

const actionButtonIntentClasses: Record<CellInsertionType, string> = {
  code: "border-sky-500/20 bg-sky-500/12 text-sky-700 hover:bg-sky-500/16 dark:border-sky-300/20 dark:text-sky-300",
  markdown:
    "border-emerald-500/20 bg-emerald-500/12 text-emerald-700 hover:bg-emerald-500/16 dark:border-emerald-300/20 dark:text-emerald-300",
};

const insertionBridgeSurfaceClasses: Record<CellInsertionType, string> = {
  code: "bg-sky-500/12 dark:bg-sky-400/10",
  markdown: "bg-emerald-500/12 dark:bg-emerald-400/10",
};

const insertionBridgeBorderClasses: Record<CellInsertionType, string> = {
  code: "border-sky-500/20 dark:border-sky-300/20",
  markdown: "border-emerald-500/20 dark:border-emerald-300/20",
};

const insertionTrailingRuleIntentClasses: Record<CellInsertionType, string> = {
  code: "bg-gradient-to-r from-sky-400/35 via-border/35 to-transparent dark:from-sky-300/30 dark:via-border/30",
  markdown:
    "bg-gradient-to-r from-emerald-400/35 via-border/35 to-transparent dark:from-emerald-300/30 dark:via-border/30",
};

const insertionTypeOrder: Record<CellInsertionType, number> = {
  code: 0,
  markdown: 1,
};

export function CellInsertionRibbon({
  terminal = false,
  activeType,
  onActiveTypeChange,
  onInsert,
  forceActionsVisible = false,
  className,
}: CellInsertionRibbonProps) {
  const [uncontrolledActiveType, setUncontrolledActiveType] = useState<CellInsertionType | null>(
    null,
  );
  const [interactionActive, setInteractionActive] = useState(false);
  const resolvedActiveType = activeType === undefined ? uncontrolledActiveType : activeType;
  const visualActiveType = resolvedActiveType ?? null;
  const isOpen = interactionActive || forceActionsVisible;
  const actionTabIndex = isOpen ? 0 : -1;
  const bridgeActiveType = terminal ? null : visualActiveType;
  const ribbonClass = visualActiveType
    ? terminal
      ? terminalInsertionRibbonClasses[visualActiveType]
      : insertionRibbonClasses[visualActiveType]
    : undefined;

  const setActiveType = (type: CellInsertionType | null) => {
    if (activeType === undefined) {
      setUncontrolledActiveType(type);
    }
    onActiveTypeChange?.(type);
  };

  const actionButtonClass = (type: CellInsertionType) => {
    const isActive = visualActiveType === type;
    const isBridgeLead =
      bridgeActiveType !== null && insertionTypeOrder[type] < insertionTypeOrder[bridgeActiveType];
    const isBridged =
      bridgeActiveType !== null && insertionTypeOrder[type] <= insertionTypeOrder[bridgeActiveType];
    const bridgeClasses = bridgeActiveType
      ? cn(
          insertionBridgeSurfaceClasses[bridgeActiveType],
          insertionBridgeBorderClasses[bridgeActiveType],
        )
      : null;

    return cn(
      "relative inline-flex h-6 items-center justify-center gap-1 border border-transparent px-2.5 text-xs font-medium text-muted-foreground/55 transition-colors",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
      isBridged ? "rounded-none" : "rounded-full",
      bridgeActiveType === type && "rounded-l-none rounded-r-full",
      bridgeActiveType && type === "markdown" && "ml-1",
      isActive
        ? actionButtonIntentClasses[type]
        : isBridgeLead && bridgeClasses
          ? cn(
              bridgeClasses,
              "border-x-0",
              "text-muted-foreground/45 hover:text-muted-foreground/65",
            )
          : "hover:bg-muted/45 hover:text-foreground",
    );
  };

  const leadingInsertionRuleClass = cn(
    "transition-colors duration-150",
    bridgeActiveType
      ? cn(
          "h-6 border-y",
          insertionBridgeSurfaceClasses[bridgeActiveType],
          insertionBridgeBorderClasses[bridgeActiveType],
        )
      : "h-px rounded-full bg-border/45",
  );
  const trailingInsertionRuleClass = cn(
    "h-px rounded-full transition-colors duration-150",
    visualActiveType ? insertionTrailingRuleIntentClasses[visualActiveType] : "bg-border/45",
  );

  return (
    <div
      data-slot="cell-adder"
      data-terminal={terminal || undefined}
      data-active-type={visualActiveType ?? undefined}
      data-interaction-active={isOpen || undefined}
      className={cn(
        "group/adder flex w-full select-none",
        terminal ? "h-[clamp(3.5rem,9vh,5.5rem)] items-start" : "h-7 items-center",
        notebookCellLayoutVars,
        className,
      )}
      onPointerEnter={() => setInteractionActive(true)}
      onPointerLeave={() => {
        setInteractionActive(false);
        setActiveType(null);
      }}
      onFocusCapture={() => setInteractionActive(true)}
      onBlur={(event) => {
        const nextTarget = event.relatedTarget;
        if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
          setInteractionActive(false);
          setActiveType(null);
        }
      }}
    >
      <div
        data-slot="cell-adder-ribbon"
        className={cn(
          "relative h-full w-1 shrink-0 overflow-hidden",
          terminal &&
            "[mask-image:linear-gradient(to_bottom,black_0,black_calc(100%-1.5rem),transparent_100%)]",
        )}
      >
        <div
          data-slot="cell-adder-ribbon-continuation"
          className={cn(
            "absolute inset-0 transition-colors duration-150 dark:bg-gray-700/55",
            terminal ? "bg-gray-200/70" : "bg-gray-200/55",
            isOpen && !visualActiveType && "bg-gray-300/70 dark:bg-gray-600/60",
          )}
        />
        {ribbonClass ? (
          <div
            data-slot="cell-adder-ribbon-intent"
            className={cn(
              "absolute left-0 top-0 w-full transition-colors duration-150",
              terminal ? "h-7" : "h-full",
              ribbonClass,
            )}
          />
        ) : null}
      </div>
      <button
        type="button"
        data-slot="cell-adder-primary-hit-target"
        title="Add code cell here"
        aria-label="Add code cell here"
        onPointerEnter={() => setActiveType("code")}
        onFocus={() => setActiveType("code")}
        onClick={() => onInsert("code")}
        className={cn(
          "relative flex h-full w-[var(--cell-content-column-inset,3.25rem)] shrink-0 items-center justify-center rounded-none transition-colors duration-150",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:ring-inset",
          visualActiveType
            ? "text-muted-foreground/0"
            : isOpen
              ? "bg-transparent text-muted-foreground/35 hover:bg-muted/20 hover:text-muted-foreground/65"
              : "text-muted-foreground/0 hover:bg-muted/20",
          terminal && "h-7",
        )}
      >
        {bridgeActiveType ? (
          <span
            data-slot="cell-adder-primary-bridge"
            className={cn(
              "pointer-events-none absolute inset-x-0 top-1/2 h-6 -translate-y-1/2 rounded-l-full border-y border-l",
              insertionBridgeSurfaceClasses[bridgeActiveType],
              insertionBridgeBorderClasses[bridgeActiveType],
            )}
            aria-hidden="true"
          />
        ) : null}
        <span className="sr-only">Add code cell here</span>
      </button>
      <div
        data-slot="cell-adder-actions"
        aria-hidden={isOpen ? undefined : true}
        className={cn(
          "flex min-w-0 flex-1 items-center transition-opacity duration-150 ease-out",
          terminal && "pt-0.5",
          forceActionsVisible
            ? "opacity-100"
            : isOpen
              ? "pointer-events-auto opacity-100"
              : "pointer-events-none opacity-0 transition-none",
        )}
      >
        <span
          data-slot="cell-adder-leading-rule"
          className={cn("w-2 shrink-0", leadingInsertionRuleClass)}
          aria-hidden="true"
        />
        <div
          data-slot="cell-adder-action-palette"
          className={cn(
            "flex h-7 shrink-0 items-center py-0 pl-0 pr-1 transition-colors duration-150",
            bridgeActiveType ? "gap-0" : "gap-1",
          )}
        >
          <button
            type="button"
            title="Add code cell"
            aria-label="Add code cell"
            tabIndex={actionTabIndex}
            onPointerEnter={() => setActiveType("code")}
            onFocus={() => setActiveType("code")}
            onClick={() => onInsert("code")}
            className={actionButtonClass("code")}
          >
            {bridgeActiveType === "markdown" ? (
              <span
                data-slot="cell-adder-action-bridge-gap"
                className={cn(
                  "pointer-events-none absolute left-full top-1/2 h-6 w-1 -translate-y-1/2 border-y",
                  insertionBridgeSurfaceClasses.markdown,
                  insertionBridgeBorderClasses.markdown,
                )}
                aria-hidden="true"
              />
            ) : null}
            <Code className="size-3" aria-hidden="true" />
            <span>Code</span>
          </button>
          <button
            type="button"
            title="Add markdown cell"
            aria-label="Add markdown cell"
            tabIndex={actionTabIndex}
            onPointerEnter={() => setActiveType("markdown")}
            onFocus={() => setActiveType("markdown")}
            onClick={() => onInsert("markdown")}
            className={actionButtonClass("markdown")}
          >
            <LetterText className="size-3" aria-hidden="true" />
            <span>Markdown</span>
          </button>
        </div>
        <span
          data-slot="cell-adder-trailing-rule"
          className={cn("min-w-8 flex-1", trailingInsertionRuleClass)}
          aria-hidden="true"
        />
      </div>
    </div>
  );
}

import { Code, LetterText, Plus } from "lucide-react";
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
  const resolvedActiveType = activeType === undefined ? uncontrolledActiveType : activeType;
  const ribbonClass = resolvedActiveType
    ? terminal
      ? terminalInsertionRibbonClasses[resolvedActiveType]
      : insertionRibbonClasses[resolvedActiveType]
    : undefined;

  const setActiveType = (type: CellInsertionType | null) => {
    if (activeType === undefined) {
      setUncontrolledActiveType(type);
    }
    onActiveTypeChange?.(type);
  };

  const actionButtonClass = (type: CellInsertionType) =>
    cn(
      "inline-flex h-6 items-center justify-center gap-1 rounded-sm px-2 text-xs text-muted-foreground/60 transition-colors",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
      resolvedActiveType === type
        ? "bg-muted text-foreground shadow-sm"
        : "hover:bg-muted/60 hover:text-foreground",
    );

  return (
    <div
      data-slot="cell-adder"
      data-terminal={terminal || undefined}
      className={cn(
        "group/adder flex w-full select-none",
        terminal ? "h-[clamp(3.5rem,9vh,5.5rem)] items-start" : "h-7 items-center",
        notebookCellLayoutVars,
        className,
      )}
      onPointerLeave={() => setActiveType(null)}
      onBlur={(event) => {
        const nextTarget = event.relatedTarget;
        if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
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
            "absolute inset-0 dark:bg-gray-700/55",
            terminal ? "bg-gray-200/70" : "bg-gray-200/55",
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
        title="Add code cell from insertion margin"
        aria-label="Add code cell from insertion margin"
        onPointerEnter={() => setActiveType(null)}
        onFocus={() => setActiveType(null)}
        onClick={() => onInsert("code")}
        className={cn(
          "h-full w-[var(--cell-content-column-inset,3.25rem)] shrink-0 rounded-none transition-colors duration-150",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:ring-inset",
          resolvedActiveType ? "bg-transparent" : "hover:bg-muted/20",
          terminal && "h-7",
        )}
      >
        <span className="sr-only">Add code cell</span>
      </button>
      <div
        data-slot="cell-adder-actions"
        className={cn(
          "flex items-center transition-opacity duration-150",
          terminal && "pt-0.5",
          forceActionsVisible
            ? "opacity-100"
            : "opacity-0 group-hover/adder:opacity-100 group-hover/adder:delay-75 group-focus-within/adder:opacity-100 group-focus-within/adder:delay-75",
        )}
      >
        <div
          data-slot="cell-adder-action-palette"
          className="flex h-7 items-center gap-0.5 rounded-sm border border-border/45 bg-background/85 p-0.5 shadow-sm backdrop-blur-sm"
        >
          <button
            type="button"
            title="Add code cell"
            aria-label="Add code cell"
            onPointerEnter={() => setActiveType("code")}
            onFocus={() => setActiveType("code")}
            onClick={() => onInsert("code")}
            className={actionButtonClass("code")}
          >
            <Plus className="h-2.5 w-2.5" aria-hidden="true" />
            <Code className="h-3 w-3" aria-hidden="true" />
            <span>Code</span>
          </button>
          <button
            type="button"
            title="Add markdown cell"
            aria-label="Add markdown cell"
            onPointerEnter={() => setActiveType("markdown")}
            onFocus={() => setActiveType("markdown")}
            onClick={() => onInsert("markdown")}
            className={actionButtonClass("markdown")}
          >
            <Plus className="h-2.5 w-2.5" aria-hidden="true" />
            <LetterText className="h-3 w-3" aria-hidden="true" />
            <span>Markdown</span>
          </button>
        </div>
      </div>
      <div className="flex-1" />
    </div>
  );
}

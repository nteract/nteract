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

const actionButtonIntentClasses: Record<CellInsertionType, string> = {
  code: "bg-sky-500/12 text-sky-700 ring-sky-500/20 hover:bg-sky-500/16 dark:text-sky-300",
  markdown:
    "bg-emerald-500/12 text-emerald-700 ring-emerald-500/20 hover:bg-emerald-500/16 dark:text-emerald-300",
};

const insertionRuleIntentClasses: Record<CellInsertionType, string> = {
  code: "bg-sky-400/50 dark:bg-sky-300/40",
  markdown: "bg-emerald-400/50 dark:bg-emerald-300/40",
};

const insertionTrailingRuleIntentClasses: Record<CellInsertionType, string> = {
  code: "bg-gradient-to-r from-sky-400/35 via-border/35 to-transparent dark:from-sky-300/30 dark:via-border/30",
  markdown:
    "bg-gradient-to-r from-emerald-400/35 via-border/35 to-transparent dark:from-emerald-300/30 dark:via-border/30",
};

const insertionChannelIntentClasses: Record<CellInsertionType, string> = {
  code: "bg-sky-500/6 text-sky-700 dark:text-sky-300",
  markdown: "bg-emerald-500/6 text-emerald-700 dark:text-emerald-300",
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

  const actionButtonClass = (type: CellInsertionType) =>
    cn(
      "inline-flex h-6 items-center justify-center gap-1 rounded-full px-2.5 text-xs font-medium text-muted-foreground/55 transition-colors ring-1 ring-transparent",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
      visualActiveType === type
        ? actionButtonIntentClasses[type]
        : "hover:bg-muted/45 hover:text-foreground",
    );

  const leadingInsertionRuleClass = cn(
    "h-px rounded-full transition-colors duration-150",
    visualActiveType ? insertionRuleIntentClasses[visualActiveType] : "bg-border/45",
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
          "flex h-full w-[var(--cell-content-column-inset,3.25rem)] shrink-0 items-center justify-center rounded-none transition-colors duration-150",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:ring-inset",
          visualActiveType
            ? insertionChannelIntentClasses[visualActiveType]
            : isOpen
              ? "bg-transparent text-muted-foreground/35 hover:bg-muted/20 hover:text-muted-foreground/65"
              : "text-muted-foreground/0 hover:bg-muted/20",
          terminal && "h-7",
        )}
      >
        <Plus
          data-slot="cell-adder-primary-glyph"
          className={cn(
            "size-3 transition-opacity duration-150",
            visualActiveType ? "opacity-100" : "opacity-0",
          )}
          aria-hidden="true"
        />
        <span className="sr-only">Add code cell here</span>
      </button>
      <div
        data-slot="cell-adder-actions"
        aria-hidden={isOpen ? undefined : true}
        className={cn(
          "flex min-w-0 flex-1 items-center transition-opacity duration-150",
          terminal && "pt-0.5",
          forceActionsVisible
            ? "opacity-100"
            : isOpen
              ? "pointer-events-auto opacity-100 delay-75"
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
          className="flex h-7 shrink-0 items-center gap-1 py-0 pl-0.5 pr-1"
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
            <Plus className="h-2.5 w-2.5" aria-hidden="true" />
            <Code className="h-3 w-3" aria-hidden="true" />
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
            <Plus className="h-2.5 w-2.5" aria-hidden="true" />
            <LetterText className="h-3 w-3" aria-hidden="true" />
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

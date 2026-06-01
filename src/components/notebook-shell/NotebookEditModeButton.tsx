import { BookOpen, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import type { NotebookInteractionMode, NotebookInteractionState } from "./interaction-mode";

export type NotebookEditMode = NotebookInteractionMode;
export type NotebookEditModeState = NotebookInteractionState;

export interface NotebookEditModeButtonProps {
  mode: NotebookEditMode;
  state: NotebookEditModeState;
  onModeChange: (mode: NotebookEditMode) => void;
  disabled?: boolean;
  variant?: "button" | "segmented";
  className?: string;
}

export function NotebookEditModeButton({
  className,
  disabled = false,
  mode,
  onModeChange,
  state,
  variant = "button",
}: NotebookEditModeButtonProps) {
  const requestingEdit = mode === "edit";
  const nextMode: NotebookEditMode = requestingEdit ? "view" : "edit";
  const label = requestingEdit ? "View" : "Edit";
  const title = requestingEdit
    ? state === "editing"
      ? "Return to read-only viewing"
      : "Stop requesting edit access"
    : "Request edit access";

  if (variant === "segmented") {
    return (
      <div
        className={cn(
          "inline-flex h-9 max-w-[min(18rem,58vw)] min-w-0 items-center rounded-lg border border-border bg-background p-1 text-sm text-muted-foreground",
          disabled && "opacity-60",
          className,
        )}
        role="group"
        aria-label="Notebook interaction mode"
        data-slot="notebook-edit-mode-button"
        data-state={state}
        data-variant={variant}
      >
        <button
          type="button"
          aria-pressed={mode === "view"}
          className={cn(
            "inline-flex h-7 min-w-0 items-center justify-center gap-1.5 rounded-md px-2.5 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed",
            mode === "view" && "bg-background text-foreground shadow-sm",
          )}
          disabled={disabled}
          title="View notebook"
          onClick={() => {
            if (mode !== "view") {
              onModeChange("view");
            }
          }}
        >
          <BookOpen className="size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 truncate leading-none">Viewing</span>
        </button>
        <button
          type="button"
          aria-pressed={mode === "edit"}
          className={cn(
            "inline-flex h-7 min-w-0 items-center justify-center gap-1.5 rounded-md px-2.5 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed",
            mode === "edit" && "bg-background text-emerald-700 shadow-sm dark:text-emerald-300",
          )}
          disabled={disabled}
          title={state === "editing" ? "Editing notebook" : "Request edit access"}
          onClick={() => {
            if (mode !== "edit") {
              onModeChange("edit");
            }
          }}
        >
          <Pencil className="size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 truncate leading-none">Editing</span>
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      aria-pressed={requestingEdit}
      className={cn(
        "inline-flex h-8 max-w-[min(12rem,38vw)] min-w-0 items-center justify-center gap-1.5 rounded-full border border-border bg-background/90 px-3 text-sm text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60",
        state === "editing" && "border-emerald-500/50 text-emerald-700 dark:text-emerald-300",
        state === "requested" && "border-ring/50 text-foreground",
        className,
      )}
      data-slot="notebook-edit-mode-button"
      data-state={state}
      data-variant={variant}
      disabled={disabled}
      title={title}
      onClick={() => onModeChange(nextMode)}
    >
      {requestingEdit ? (
        <BookOpen className="size-4 shrink-0" aria-hidden="true" />
      ) : (
        <Pencil className="size-4 shrink-0" aria-hidden="true" />
      )}
      <span className="min-w-0 truncate leading-none">{label}</span>
    </button>
  );
}
